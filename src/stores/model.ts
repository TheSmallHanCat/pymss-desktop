import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { loadAppStore, saveAppStore } from '@/utils/appStore'
import { useSettingsStore } from '@/stores/settings'

export type ModelEntry = {
  name: string
  aliases: string[]
  modelType: string | null
  architecture: string
  supported: boolean
  unsupportedReason: string
  category: string
  categoryCn: string
  primaryCategory: string
  primaryCategoryCn: string
  secondaryCategory: string
  secondaryCategoryCn: string
  targetStem: string
  configInstruments: string
  configTargetInstrument: string
  classificationConfidence: string
  classificationBasis: string
  sizeBytes: number
  sha256: string
  downloaded: boolean
  missingPaths: string[]
  modelPath: string
  configPath: string | null
  auxiliaryPaths: string[]
  defaultInferenceParams?: ModelDefaultInferenceParams
  defaultInferenceParamsResolved?: boolean
}

export type ModelDefaultInferenceParams = {
  batch_size?: number
  overlap_size?: number
  num_overlap?: number
  chunk_size?: number
  standardize?: boolean
  normalize?: boolean
  window_size?: number
  aggression?: number
  enable_post_process?: boolean
  post_process_threshold?: number
  high_end_process?: boolean
}

type ModelsPayload = {
  models: ModelEntry[]
  categories: string[]
  categoriesCn: string[]
  count: number
  modelDir: string
}

type DownloadStatus = 'idle' | 'downloading' | 'done' | 'error' | 'cancelled' | 'paused' | 'interrupted'

export type DownloadTask = {
  taskId: string
  model: string
  status: DownloadStatus
  progress: number
  message: string
  completedFiles: number
  totalFiles: number
  updatedAt: number
}

export type ModelStorageFile = { path: string; sizeBytes: number; exists?: boolean }
export type ModelStorageItem = {
  name: string
  downloaded: boolean
  sizeBytes: number
  expectedSizeBytes: number
  files: ModelStorageFile[]
}

export type ModelStorageSummary = {
  modelDir: string
  totalBytes: number
  downloadedCount: number
  models: ModelStorageItem[]
  residualFiles: ModelStorageFile[]
  residualBytes: number
}

export type DeleteTaskStatus = 'deleting' | 'done' | 'error' | 'cancelled'

export type DeleteTask = {
  taskId: string
  model: string
  status: DeleteTaskStatus
  progress: number
  message: string
  completedFiles: number
  totalFiles: number
  updatedAt: number
  source?: 'single' | 'batch'
  resultModelInfo?: ModelEntry | null
}

export type BatchDeleteState = {
  active: boolean
  totalModels: number
  completedModels: number
  currentModel: string
  failedModels: string[]
}

export type ResidualCleanupState = {
  taskId: string
  active: boolean
  status: DeleteTaskStatus | 'idle'
  progress: number
  message: string
  completedFiles: number
  totalFiles: number
  updatedAt: number
  notified?: boolean
}

const DELETE_TASK_TIMEOUT_MS = 5 * 60 * 1000
const STORAGE_SUMMARY_CACHE_TTL_MS = 30 * 1000

type StoredModelState = {
  models?: ModelEntry[]
  categories?: string[]
  categoriesCn?: string[]
  count?: number
  modelDir?: string
  downloadTasks?: Record<string, DownloadTask>
  modelInferenceOverrides?: Record<string, ModelDefaultInferenceParams>
}

function normalizeDownloadTasks(input?: Record<string, DownloadTask>) {
  const next: Record<string, DownloadTask> = {}
  Object.entries(input || {}).forEach(([name, task]) => {
    if (!task?.model) return
    next[name] = {
      ...task,
      status: task.status === 'downloading' ? 'interrupted' : task.status,
      message: task.status === 'downloading' ? '下载已中断' : task.message,
      updatedAt: Date.now(),
    }
  })
  return next
}

function normalizeModelInferenceOverrides(input?: Record<string, ModelDefaultInferenceParams>) {
  const next: Record<string, ModelDefaultInferenceParams> = {}
  Object.entries(input || {}).forEach(([name, value]) => {
    const normalized = normalizeDefaultInferenceParams(value as Record<string, unknown>)
    if (normalized) next[name] = normalized
  })
  return next
}

function normalizeDefaultInferenceParams(input?: Record<string, unknown> | null): ModelDefaultInferenceParams | undefined {
  if (!input || typeof input !== 'object') return undefined

  const next: Partial<ModelDefaultInferenceParams> = {}
  const source = input as Record<string, unknown>

  const assignNumber = (targetKey: keyof ModelDefaultInferenceParams, ...candidateKeys: string[]) => {
    for (const candidateKey of candidateKeys) {
      const value = source[candidateKey]
      if (typeof value === 'number' && Number.isFinite(value)) {
        ;(next as Record<string, number | boolean | undefined>)[targetKey] = value
        return
      }
    }
  }

  const assignBoolean = (targetKey: keyof ModelDefaultInferenceParams, ...candidateKeys: string[]) => {
    for (const candidateKey of candidateKeys) {
      const value = source[candidateKey]
      if (typeof value === 'boolean') {
        ;(next as Record<string, number | boolean | undefined>)[targetKey] = value
        return
      }
    }
  }

  assignNumber('batch_size', 'batch_size', 'batchSize')
  assignNumber('overlap_size', 'overlap_size', 'overlapSize')
  assignNumber('num_overlap', 'num_overlap', 'numOverlap')
  assignNumber('chunk_size', 'chunk_size', 'chunkSize')
  assignBoolean('standardize', 'standardize')
  assignBoolean('normalize', 'normalize')
  assignNumber('window_size', 'window_size', 'windowSize')
  assignNumber('aggression', 'aggression')
  assignBoolean('enable_post_process', 'enable_post_process', 'enablePostProcess')
  assignNumber('post_process_threshold', 'post_process_threshold', 'postProcessThreshold')
  assignBoolean('high_end_process', 'high_end_process', 'highEndProcess')

  return Object.keys(next).length ? next : undefined
}

function normalizeModelEntry(model: ModelEntry): ModelEntry {
  const rawDefaults = model.defaultInferenceParams as Record<string, unknown> | undefined
  return {
    ...model,
    defaultInferenceParams: normalizeDefaultInferenceParams(rawDefaults),
    defaultInferenceParamsResolved: rawDefaults !== undefined,
  }
}

function mergeDefaultInferenceParams(
  defaults: ModelDefaultInferenceParams | undefined,
  overrides: ModelDefaultInferenceParams | undefined,
) {
  return normalizeDefaultInferenceParams({
    ...(defaults || {}),
    ...(overrides || {}),
  } as Record<string, unknown>)
}

export const useModelStore = defineStore('model', () => {
  const initialized = ref(false)
  const models = ref<ModelEntry[]>([])
  const categories = ref<string[]>([])
  const categoriesCn = ref<string[]>([])
  const modelDir = ref('')
  const selectedModel = ref('bs_roformer_voc_hyperacev2')
  const selectedInfo = ref<ModelEntry | null>(null)
  const isLoading = ref(false)
  const detailLoading = ref(false)
  const error = ref<string | null>(null)
  const search = ref('')
  const supportedOnly = ref(true)
  const category = ref('')
  const downloadStates = ref<Record<string, DownloadStatus>>({})
  const downloadErrors = ref<Record<string, string>>({})
  const downloadTasks = ref<Record<string, DownloadTask>>({})
  const modelInferenceOverrides = ref<Record<string, ModelDefaultInferenceParams>>({})
  const downloadTaskIndex = ref<Record<string, string>>({})
  const deleteTasks = ref<Record<string, DeleteTask>>({})
  const deleteTaskIndex = ref<Record<string, string>>({})
  const modelStorageSummary = ref<ModelStorageSummary | null>(null)
  const modelStorageSummaryLoadedAt = ref(0)
  const storageLoading = ref(false)
  const batchDeleteState = ref<BatchDeleteState>({
    active: false,
    totalModels: 0,
    completedModels: 0,
    currentModel: '',
    failedModels: [],
  })
  const residualCleanupState = ref<ResidualCleanupState>({
    taskId: '',
    active: false,
    status: 'idle',
    progress: 0,
    message: '',
    completedFiles: 0,
    totalFiles: 0,
    updatedAt: 0,
    notified: false,
  })

  let saveTimer: ReturnType<typeof setTimeout> | null = null

  const filteredModels = computed(() => {
    const q = search.value.trim().toLowerCase()
    return models.value.filter((model) => {
      const matchesQuery = !q
        || model.name.toLowerCase().includes(q)
        || model.aliases.some(alias => alias.toLowerCase().includes(q))
        || model.architecture.toLowerCase().includes(q)
        || model.modelType?.toLowerCase().includes(q)
        || model.targetStem.toLowerCase().includes(q)
        || model.category.toLowerCase().includes(q)
        || model.categoryCn.toLowerCase().includes(q)
      const selectedCategory = category.value.trim().toLowerCase()
      const matchesCategory = !selectedCategory
        || model.category.toLowerCase() === selectedCategory
        || model.primaryCategory.toLowerCase() === selectedCategory
        || model.secondaryCategory.toLowerCase() === selectedCategory
      const matchesSupported = !supportedOnly.value || model.supported
      return matchesQuery && matchesCategory && matchesSupported
    })
  })
  const downloadedModels = computed(() => models.value.filter((model) => model.supported && model.downloaded))

  async function persistState() {
    if (!initialized.value) return
    await saveAppStore('model-state', {
      models: models.value,
      categories: categories.value,
      categoriesCn: categoriesCn.value,
      count: models.value.length,
      modelDir: modelDir.value,
      downloadTasks: downloadTasks.value,
      modelInferenceOverrides: modelInferenceOverrides.value,
    } satisfies StoredModelState)
  }

  function queuePersist() {
    if (!initialized.value) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void persistState()
    }, 120)
  }

  async function initialize() {
    if (initialized.value) return
    const stored = await loadAppStore<StoredModelState>('model-state')
    modelInferenceOverrides.value = normalizeModelInferenceOverrides(stored?.modelInferenceOverrides)
    if (stored?.models?.length) {
      models.value = stored.models.map(normalizeModelEntryWithOverrides)
      categories.value = stored.categories || []
      categoriesCn.value = stored.categoriesCn || []
      modelDir.value = stored.modelDir || ''
    }
    downloadTasks.value = normalizeDownloadTasks(stored?.downloadTasks)
    Object.values(downloadTasks.value).forEach((task) => {
      downloadTaskIndex.value[task.taskId] = task.model
      if (task.status === 'downloading') downloadStates.value[task.model] = 'downloading'
      if (task.status === 'error') downloadStates.value[task.model] = 'error'
    })
    initialized.value = true
  }

  watch(downloadTasks, () => queuePersist(), { deep: true })
  watch(supportedOnly, () => {
    if (selectedInfo.value && !filteredModels.value.some((item) => item.name === selectedInfo.value?.name)) {
      selectedInfo.value = null
    }
  })

  function persistModelCache() {
    queuePersist()
  }

  function normalizeModelEntryWithOverrides(model: ModelEntry) {
    const normalized = normalizeModelEntry(model)
    const overrides = modelInferenceOverrides.value[normalized.name]
    if (!overrides) return normalized
    return {
      ...normalized,
      defaultInferenceParams: mergeDefaultInferenceParams(normalized.defaultInferenceParams, overrides),
      defaultInferenceParamsResolved: true,
    }
  }

  function setModelInferenceOverrides(name: string, overrides: ModelDefaultInferenceParams) {
    const normalized = normalizeDefaultInferenceParams(overrides as Record<string, unknown>)
    if (!normalized) return
    modelInferenceOverrides.value = {
      ...modelInferenceOverrides.value,
      [name]: normalized,
    }
    const index = models.value.findIndex((item) => item.name === name)
    if (index >= 0) models.value[index] = normalizeModelEntryWithOverrides(models.value[index])
    if (selectedInfo.value?.name === name) selectedInfo.value = normalizeModelEntryWithOverrides(selectedInfo.value)
    queuePersist()
  }

  function resetModelInferenceOverrides(name: string) {
    if (!modelInferenceOverrides.value[name]) return
    const { [name]: _, ...rest } = modelInferenceOverrides.value
    modelInferenceOverrides.value = rest
    const index = models.value.findIndex((item) => item.name === name)
    if (index >= 0) {
      models.value[index] = normalizeModelEntry(models.value[index])
      if (selectedInfo.value?.name === name) selectedInfo.value = models.value[index]
    } else if (selectedInfo.value?.name === name) {
      selectedInfo.value = normalizeModelEntry(selectedInfo.value)
    }
    queuePersist()
  }

  function getModelInferenceOverrides(name: string) {
    return modelInferenceOverrides.value[name]
  }

  function isDeleteTaskTerminal(task?: DeleteTask | null) {
    return task?.status === 'done' || task?.status === 'error' || task?.status === 'cancelled'
  }

  function clearDeleteTaskIndex(taskId?: string | null) {
    if (!taskId || !deleteTaskIndex.value[taskId]) return
    const { [taskId]: _, ...rest } = deleteTaskIndex.value
    deleteTaskIndex.value = rest
  }

  function upsertModel(modelInfo: ModelEntry) {
    const normalizedModel = normalizeModelEntryWithOverrides(modelInfo)
    const index = models.value.findIndex((item) => item.name === modelInfo.name)
    if (index >= 0) models.value[index] = normalizedModel
    else models.value.push(normalizedModel)
    if (selectedModel.value === modelInfo.name) selectedInfo.value = normalizedModel
    persistModelCache()
  }

  async function loadModels() {
    const settings = useSettingsStore()
    isLoading.value = true
    error.value = null
    try {
      const result = await invoke<ModelsPayload>('list_models', {
        payload: {
          category: null,
          supportedOnly: false,
          includeLocalState: true,
          modelDir: settings.modelDir || null,
        },
      })
      models.value = result.models.map(normalizeModelEntryWithOverrides)
      categories.value = result.categories
      categoriesCn.value = result.categoriesCn
      modelDir.value = result.modelDir
      const nextSelected = models.value.find((model) => model.name === selectedModel.value) || null
      if (nextSelected) selectedInfo.value = nextSelected
      else if (selectedInfo.value?.name === selectedModel.value) selectedInfo.value = null
      persistModelCache()
      const firstDownloaded = models.value.find((model) => model.supported && model.downloaded)
      if (!models.value.some((model) => model.name === selectedModel.value && model.downloaded)) {
        selectedModel.value = firstDownloaded?.name || ''
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      isLoading.value = false
    }
  }

  function selectModel(modelOrName: string | ModelEntry) {
    const settings = useSettingsStore()
    const name = typeof modelOrName === 'string' ? modelOrName : modelOrName.name
    selectedModel.value = name

    const listEntry = typeof modelOrName === 'string'
      ? models.value.find((item) => item.name === name) || null
      : modelOrName
    if (listEntry) selectedInfo.value = listEntry

    if (listEntry?.defaultInferenceParamsResolved) {
      detailLoading.value = false
      return Promise.resolve(listEntry)
    }

    detailLoading.value = true
    return invoke<ModelEntry>('get_model_info', {
      payload: {
        model: name,
        modelDir: settings.modelDir || null,
      },
    }).then((info) => {
      const normalizedInfo = normalizeModelEntryWithOverrides(info)
      if (selectedModel.value === name) selectedInfo.value = normalizedInfo
      return normalizedInfo
    }).catch((err) => {
      error.value = err instanceof Error ? err.message : String(err)
      throw err
    }).finally(() => {
      if (selectedModel.value === name) detailLoading.value = false
    })
  }

  function handleWorkerEvent(event: any) {
    const taskId = event?.taskId as string | undefined
    const payload = event.payload || {}

    if (taskId?.startsWith('download_')) {
      const modelName = payload.model || downloadTaskIndex.value[taskId] || Object.values(downloadTasks.value).find((task) => task.taskId === taskId)?.model
      if (!modelName) return
      const previous = downloadTasks.value[modelName] || {
        taskId,
        model: modelName,
        status: 'downloading',
        progress: 0,
        message: '',
        completedFiles: 0,
        totalFiles: 1,
        updatedAt: Date.now(),
      }
      const next: DownloadTask = { ...previous, taskId, updatedAt: Date.now() }
      if (event.type === 'download_started') {
        next.status = 'downloading'
        next.progress = payload.progress ?? 0
        next.message = 'Started'
        next.totalFiles = payload.totalFiles || next.totalFiles
        downloadStates.value = { ...downloadStates.value, [modelName]: 'downloading' }
      } else if (event.type === 'download_stage') {
        next.status = 'downloading'
        next.progress = payload.progress ?? Math.max(next.progress, 5)
        next.message = payload.message || payload.stage || 'Downloading'
      } else if (event.type === 'download_file') {
        next.status = 'downloading'
        next.progress = payload.progress ?? next.progress
        next.completedFiles = payload.completedFiles || next.completedFiles
        next.totalFiles = payload.totalFiles || next.totalFiles
        next.message = payload.status || 'Downloading'
      } else if (event.type === 'download_progress') {
        next.status = 'downloading'
        next.progress = payload.progress ?? next.progress
        next.completedFiles = payload.completedFiles || next.completedFiles
        next.totalFiles = payload.totalFiles || next.totalFiles
        next.message = payload.completedFiles ? 'Downloading' : (next.message || 'Downloading')
      } else if (event.type === 'download_done') {
        next.status = 'done'
        next.progress = 100
        next.message = 'Done'
        next.completedFiles = payload.downloaded?.length + payload.skipped?.length || next.completedFiles
        next.totalFiles = Math.max(next.totalFiles, next.completedFiles || 1)
        if (payload.modelInfo) upsertModel(payload.modelInfo)
        if (payload.modelDir) modelDir.value = payload.modelDir
        downloadStates.value = { ...downloadStates.value, [modelName]: 'done' }
      } else if (event.type === 'task_cancelled') {
        next.status = 'cancelled'
        next.message = 'Cancelled'
        downloadStates.value = { ...downloadStates.value, [modelName]: 'idle' }
      } else if (event.type === 'error') {
        if (previous.status === 'cancelled' || previous.status === 'paused') {
          downloadTasks.value = { ...downloadTasks.value, [modelName]: next }
          return
        }
        next.status = 'error'
        next.message = payload.message || 'Failed'
        downloadStates.value = { ...downloadStates.value, [modelName]: 'error' }
        downloadErrors.value = { ...downloadErrors.value, [modelName]: next.message }
      }
      downloadTasks.value = { ...downloadTasks.value, [modelName]: next }
      return
    }

    if (taskId?.startsWith('delete_')) {
      const modelName = payload.model || deleteTaskIndex.value[taskId] || Object.values(deleteTasks.value).find((task) => task.taskId === taskId)?.model
      if (!modelName) return
      const previous = deleteTasks.value[modelName] || {
        taskId,
        model: modelName,
        status: 'deleting' as const,
        progress: 0,
        message: '',
        completedFiles: 0,
        totalFiles: 1,
        updatedAt: Date.now(),
      }
      const next: DeleteTask = { ...previous, taskId, updatedAt: Date.now() }
      if (event.type === 'model_delete_started') {
        next.status = 'deleting'
        next.progress = payload.progress ?? 0
        next.message = payload.message || 'Deleting model files'
        next.completedFiles = payload.completedFiles ?? 0
        next.totalFiles = payload.totalFiles || next.totalFiles
      } else if (event.type === 'model_delete_progress') {
        next.status = 'deleting'
        next.progress = payload.progress ?? next.progress
        next.message = payload.message || 'Deleting model files'
        next.completedFiles = payload.completedFiles ?? next.completedFiles
        next.totalFiles = payload.totalFiles || next.totalFiles
      } else if (event.type === 'model_delete_done') {
        next.status = 'done'
        next.progress = 100
        next.message = payload.message || 'Deleting model files'
        next.completedFiles = payload.completedFiles ?? next.completedFiles
        next.totalFiles = payload.totalFiles || next.totalFiles
        next.resultModelInfo = payload.modelInfo || null
        if (payload.modelInfo) upsertModel(payload.modelInfo)
      } else if (event.type === 'model_delete_failed') {
        next.status = 'error'
        next.message = payload.message || 'Delete failed'
        next.resultModelInfo = payload.modelInfo || null
        if (payload.modelInfo) upsertModel(payload.modelInfo)
      } else if (event.type === 'error') {
        next.status = 'error'
        next.message = payload.message || 'Delete failed'
      }
      deleteTasks.value = { ...deleteTasks.value, [modelName]: next }
      return
    }

    if (taskId?.startsWith('cleanup_residual_')) {
      if (event.type === 'model_residual_cleanup_started') {
        residualCleanupState.value = {
          taskId,
          active: true,
          status: 'deleting',
          progress: payload.progress ?? 0,
          message: payload.message || 'Cleaning residual files',
          completedFiles: payload.completedFiles ?? 0,
          totalFiles: payload.totalFiles ?? 0,
          updatedAt: Date.now(),
        }
      } else if (event.type === 'model_residual_cleanup_progress') {
        residualCleanupState.value = {
          ...residualCleanupState.value,
          taskId,
          active: true,
          status: 'deleting',
          progress: payload.progress ?? residualCleanupState.value.progress,
          message: payload.message || residualCleanupState.value.message,
          completedFiles: payload.completedFiles ?? residualCleanupState.value.completedFiles,
          totalFiles: payload.totalFiles ?? residualCleanupState.value.totalFiles,
          updatedAt: Date.now(),
        }
      } else if (event.type === 'model_residual_cleanup_done') {
        residualCleanupState.value = {
          ...residualCleanupState.value,
          taskId,
          active: false,
          status: 'done',
          progress: 100,
          message: payload.message || residualCleanupState.value.message,
          completedFiles: payload.completedFiles ?? residualCleanupState.value.completedFiles,
          totalFiles: payload.totalFiles ?? residualCleanupState.value.totalFiles,
          updatedAt: Date.now(),
          notified: false,
        }
        const summary = payload.modelStorageSummary
        if (summary?.models) {
          modelStorageSummary.value = summary
          modelStorageSummaryLoadedAt.value = Date.now()
        }
      } else if (event.type === 'model_residual_cleanup_failed') {
        residualCleanupState.value = {
          ...residualCleanupState.value,
          taskId,
          active: false,
          status: 'error',
          message: payload.message || 'Cleanup failed',
          updatedAt: Date.now(),
          notified: false,
        }
        const summary = payload.modelStorageSummary
        if (summary?.models) {
          modelStorageSummary.value = summary
          modelStorageSummaryLoadedAt.value = Date.now()
        }
      } else if (event.type === 'error') {
        residualCleanupState.value = {
          ...residualCleanupState.value,
          taskId,
          active: false,
          status: 'error',
          message: payload.message || 'Cleanup failed',
          updatedAt: Date.now(),
          notified: false,
        }
      }
    }
  }

  async function downloadModel(name: string, force = false) {
    const settings = useSettingsStore()
    const taskId = `download_${Date.now()}`
    downloadStates.value = { ...downloadStates.value, [name]: 'downloading' }
    downloadErrors.value = { ...downloadErrors.value, [name]: '' }
    downloadTasks.value = {
      ...downloadTasks.value,
      [name]: {
        taskId,
        model: name,
        status: 'downloading',
        progress: 0,
        message: 'Queued',
        completedFiles: 0,
        totalFiles: 1,
        updatedAt: Date.now(),
      },
    }
    downloadTaskIndex.value = { ...downloadTaskIndex.value, [taskId]: name }
    try {
      await invoke<{ taskId: string; started: boolean }>('start_model_download', {
        payload: {
          taskId,
          model: name,
          modelDir: settings.modelDir || null,
          source: settings.downloadSource,
          endpoint: null,
          force,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      downloadStates.value = { ...downloadStates.value, [name]: 'error' }
      downloadErrors.value = { ...downloadErrors.value, [name]: message }
      const previous = downloadTasks.value[name]
      if (previous) {
        downloadTasks.value = { ...downloadTasks.value, [name]: { ...previous, status: 'error', message, updatedAt: Date.now() } }
      }
      throw err
    }
  }

  async function cancelDownload(name: string, pause = false) {
    const task = downloadTasks.value[name]
    if (!task || task.status !== 'downloading') return false
    const cancelled = await invoke<boolean>('cancel_task', { taskId: task.taskId })
    if (cancelled) {
      downloadTasks.value = {
        ...downloadTasks.value,
        [name]: { ...task, status: pause ? 'paused' : 'cancelled', message: pause ? 'Paused' : 'Cancelled', updatedAt: Date.now() },
      }
      downloadStates.value = { ...downloadStates.value, [name]: 'idle' }
    }
    return cancelled
  }

  async function deleteModel(name: string, source: 'single' | 'batch' = 'single') {
    const existingTask = deleteTasks.value[name]
    if (existingTask && !isDeleteTaskTerminal(existingTask)) {
      throw new Error('Model deletion already in progress')
    }
    const settings = useSettingsStore()
    const taskId = `delete_${Date.now()}`
    deleteTasks.value = {
      ...deleteTasks.value,
      [name]: {
        taskId,
        model: name,
        status: 'deleting',
        progress: 0,
        message: 'Deleting model files',
        completedFiles: 0,
        totalFiles: 1,
        updatedAt: Date.now(),
        source,
        resultModelInfo: null,
      },
    }
    deleteTaskIndex.value = { ...deleteTaskIndex.value, [taskId]: name }
    try {
      await invoke<{ taskId: string; started: boolean }>('start_model_delete', {
        payload: {
          taskId,
          model: name,
          modelDir: settings.modelDir || null,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const previous = deleteTasks.value[name]
      if (previous) {
        deleteTasks.value = {
          ...deleteTasks.value,
          [name]: { ...previous, status: 'error', message, updatedAt: Date.now(), resultModelInfo: null },
        }
      }
    }
  }

  function finalizeDeletedModel(name: string, modelInfo?: ModelEntry | null) {
    if (modelInfo) {
      upsertModel(modelInfo)
    } else {
      const idx = models.value.findIndex((m) => m.name === name)
      if (idx >= 0) {
        models.value[idx] = { ...models.value[idx], downloaded: false, missingPaths: [models.value[idx].modelPath] }
      }
      if (selectedInfo.value?.name === name) {
        selectedInfo.value = { ...selectedInfo.value, downloaded: false }
      }
      persistModelCache()
    }
    if (downloadTasks.value[name]) {
      const { [name]: _, ...rest } = downloadTasks.value
      downloadTasks.value = rest
    }
    const idxTask = deleteTasks.value[name]
    if (idxTask) clearDeleteTaskIndex(idxTask.taskId)
  }

  async function waitForDeleteTask(name: string, taskId: string) {
    return new Promise<DeleteTask>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const stop = watch(
        () => deleteTasks.value[name],
        (task) => {
          if (!task) return
          if (task.taskId !== taskId) return
          if (task.status === 'done') {
            if (timer) clearTimeout(timer)
            stop()
            resolve(task)
          } else if (task.status === 'error') {
            if (timer) clearTimeout(timer)
            stop()
            reject(new Error(task.message || 'Delete failed'))
          }
        },
        { deep: true, immediate: true },
      )
      timer = setTimeout(() => {
        stop()
        reject(new Error('Delete task timed out'))
      }, DELETE_TASK_TIMEOUT_MS)
    })
  }

  async function deleteModels(names: string[]) {
    batchDeleteState.value = {
      active: true,
      totalModels: names.length,
      completedModels: 0,
      currentModel: '',
      failedModels: [],
    }
    for (const name of names) {
      batchDeleteState.value = {
        ...batchDeleteState.value,
        currentModel: name,
      }
      try {
        await deleteModel(name, 'batch')
        const taskId = deleteTasks.value[name]?.taskId
        if (!taskId) throw new Error('Delete task was not created')
        const task = await waitForDeleteTask(name, taskId)
        finalizeDeletedModel(name, task.resultModelInfo ?? null)
        clearDeleteTask(name)
      } catch {
        batchDeleteState.value = {
          ...batchDeleteState.value,
          failedModels: [...batchDeleteState.value.failedModels, name],
        }
        clearDeleteTask(name)
      } finally {
        batchDeleteState.value = {
          ...batchDeleteState.value,
          completedModels: batchDeleteState.value.completedModels + 1,
        }
      }
    }
    batchDeleteState.value = {
      ...batchDeleteState.value,
      active: false,
      currentModel: '',
    }
    await loadModelStorageSummary({ force: true })
  }

  async function loadModelStorageSummary(options?: { force?: boolean }) {
    const settings = useSettingsStore()
    const requestedModelDir = String(settings.modelDir || '').trim()
    const cachedModelDir = String(modelStorageSummary.value?.modelDir || '').trim()
    const hasFreshCache = Boolean(
      modelStorageSummary.value
      && cachedModelDir
      && cachedModelDir === requestedModelDir
      && Date.now() - modelStorageSummaryLoadedAt.value < STORAGE_SUMMARY_CACHE_TTL_MS,
    )
    if (!options?.force && hasFreshCache) return modelStorageSummary.value
    storageLoading.value = true
    try {
      const result = await invoke<ModelStorageSummary>('get_model_storage_summary', {
        payload: { modelDir: settings.modelDir || null },
      })
      modelStorageSummary.value = result
      modelStorageSummaryLoadedAt.value = Date.now()
      return result
    } finally {
      storageLoading.value = false
    }
  }

  async function cleanupModelResidualFiles() {
    const settings = useSettingsStore()
    const taskId = `cleanup_residual_${Date.now()}`
    residualCleanupState.value = {
      taskId,
      active: true,
      status: 'deleting',
      progress: 0,
      message: 'Cleaning residual files',
      completedFiles: 0,
      totalFiles: 0,
      updatedAt: Date.now(),
      notified: false,
    }
    try {
      await invoke<any>('start_cleanup_model_residual_files', {
        payload: { taskId, modelDir: settings.modelDir || null },
      })
    } catch (err) {
      residualCleanupState.value = {
        ...residualCleanupState.value,
        active: false,
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
        updatedAt: Date.now(),
        notified: false,
      }
    }
  }

  function clearDeleteTask(name: string) {
    const task = deleteTasks.value[name]
    if (task) {
      clearDeleteTaskIndex(task.taskId)
      const { [name]: _, ...rest } = deleteTasks.value
      deleteTasks.value = rest
    }
  }

  function resetResidualCleanupState() {
    residualCleanupState.value = {
      taskId: '',
      active: false,
      status: 'idle',
      progress: 0,
      message: '',
      completedFiles: 0,
      totalFiles: 0,
      updatedAt: 0,
      notified: false,
    }
  }

  return {
    initialized,
    models,
    categories,
    categoriesCn,
    modelDir,
    selectedModel,
    selectedInfo,
    isLoading,
    detailLoading,
    error,
    search,
    supportedOnly,
    category,
    downloadStates,
    downloadErrors,
    downloadTasks,
    modelInferenceOverrides,
    deleteTasks,
    modelStorageSummary,
    storageLoading,
    batchDeleteState,
    residualCleanupState,
    filteredModels,
    downloadedModels,
    initialize,
    loadModels,
    selectModel,
    setModelInferenceOverrides,
    resetModelInferenceOverrides,
    getModelInferenceOverrides,
    deleteModel,
    downloadModel,
    cancelDownload,
    deleteModels,
    loadModelStorageSummary,
    cleanupModelResidualFiles,
    clearDeleteTask,
    resetResidualCleanupState,
    handleWorkerEvent,
  }
})
