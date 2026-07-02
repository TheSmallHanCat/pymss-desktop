import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import i18n from '@/i18n'
import { loadAppStore, saveAppStore } from '@/utils/appStore'
import { useSettingsStore } from '@/stores/settings'
import { useModelStore, type ModelDefaultInferenceParams } from '@/stores/model'
import { useAppStore } from '@/stores/app'

export type TaskStatus = 'queued' | 'preparing' | 'validating_input' | 'downloading_model' | 'ensuring_model' | 'loading_model' | 'separating' | 'writing_output' | 'done' | 'failed' | 'cancelled'

export type StemOutput = { stem: string; path: string }

export type SeparationRunConfig = {
  modelDir: string | null
  downloadSource: string
  modelType?: string | null
  device: string
  deviceIds: number[]
  outputFormat: string
  selectedStems: string[]
  useTta: boolean
  debug: boolean
  audioParams: Record<string, string | number>
  inferenceParamsVersion?: number
  inferenceParams: Record<string, unknown>
}


type ScanMediaPathsResult = {
  files: string[]
  warnings: string[]
}

export type SeparationTask = {
  id: string
  jobId?: string
  resultId?: string
  batchId?: string
  model: string
  input: string
  jobOutput?: string
  outputPrefix?: string
  output: string
  status: TaskStatus
  message: string
  createdAt: number
  updatedAt: number
  progress: number
  stageLabel: string
  progressCurrent?: number
  progressTotal?: number
  progressDetail?: string
  files: string[]
  outputs: StemOutput[]
  logs: string[]
  error?: string
  runConfig?: SeparationRunConfig
  taskHidden?: boolean
  resultHidden?: boolean
}

export type SeparationJob = {
  id: string
  output: string
  tasks: SeparationTask[]
  primary: SeparationTask
  model: string
  inputCount: number
  outputCount: number
  createdAt: number
  updatedAt: number
  status: TaskStatus
  progress: number
}

type PersistedTaskState = {
  tasks?: Partial<SeparationTask>[]
}

const AUDIO_EXTENSIONS = ['wav', 'mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus']
const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv']
const CURRENT_INFERENCE_PARAMS_VERSION = 3
const TERMINAL_STATUSES: TaskStatus[] = ['done', 'failed', 'cancelled']
const INTERRUPTIBLE_STATUSES: TaskStatus[] = ['queued', 'preparing', 'validating_input', 'downloading_model', 'ensuring_model', 'loading_model', 'separating', 'writing_output']
const NORMAL_LOG_LIMIT = 300
const DEVELOPER_LOG_LIMIT = 1200

const STAGE_META: Record<TaskStatus, { progress: number; label: string }> = {
  queued: { progress: 2, label: 'Queued' },
  preparing: { progress: 8, label: 'Preparing' },
  validating_input: { progress: 12, label: 'Validating input' },
  downloading_model: { progress: 22, label: 'Preparing model' },
  ensuring_model: { progress: 22, label: 'Preparing model' },
  loading_model: { progress: 35, label: 'Loading model' },
  separating: { progress: 0, label: 'Separating' },
  writing_output: { progress: 92, label: 'Collecting outputs' },
  done: { progress: 100, label: 'Done' },
  failed: { progress: 100, label: 'Failed' },
  cancelled: { progress: 100, label: 'Cancelled' },
}

function isSupportedInputPath(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  return AUDIO_EXTENSIONS.includes(ext) || VIDEO_EXTENSIONS.includes(ext)
}

const MAX_CONCURRENT_SEPARATIONS = 16

function normalizeStatus(status: unknown): TaskStatus {
  if (typeof status !== 'string') return 'queued'
  if (status in STAGE_META) return status as TaskStatus
  return 'preparing'
}

function normalizeOutputPath(value?: string | null) {
  return value && value.trim() ? value : 'outputs'
}

function joinOutputPath(base: string, child: string) {
  const separator = base.includes('\\') ? '\\' : '/'
  return `${base.replace(/[\\/]$/, '')}${separator}${child}`
}

function safeOutputSegment(value: string, fallback: string) {
  const name = value
    .split(/[/\\]/)
    .filter(Boolean)
    .pop()
    ?.replace(/\.[^/.\\]+$/, '')
    .trim() || fallback
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 80) || fallback
}

function createRunId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

function resolveJobOutputPath(base: string, jobId: string) {
  const outputDir = normalizeOutputPath(base)
  return joinOutputPath(outputDir, jobId)
}

function outputsFromFiles(outputDir: string, files: string[], outputFormat = 'wav', outputPrefix?: string): StemOutput[] {
  if (!files?.length) return []
  const separator = outputDir.includes('\\') ? '\\' : '/'
  const base = outputDir.replace(/[\\/]$/, '')
  return files.map((file) => {
    const stemName = file.replace(/\.[^/.\\]+$/, '')
    const fileName = outputPrefix ? `${outputPrefix}_${stemName}` : stemName
    return {
      stem: stemName,
      path: `${base}${separator}${fileName}.${outputFormat}`,
    }
  })
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}

function getLogLimit(developerMode: boolean) {
  return developerMode ? DEVELOPER_LOG_LIMIT : NORMAL_LOG_LIMIT
}

function resolveStageProgress(status: TaskStatus, current?: number, total?: number) {
  const meta = STAGE_META[status]
  if (status !== 'separating') return meta.progress
  if (
    typeof current !== 'number'
    || typeof total !== 'number'
    || !Number.isFinite(current)
    || !Number.isFinite(total)
    || total <= 0
  ) {
    return meta.progress
  }
  return Math.round(clamp(current / total, 0, 1) * 100)
}

function normalizeTask(task: Partial<SeparationTask>): SeparationTask {
  let status = normalizeStatus(task.status)
  let interrupted = false
  if (INTERRUPTIBLE_STATUSES.includes(status)) {
    status = 'failed'
    interrupted = true
  }
  const normalizedRunConfig = normalizeRunConfig(task.runConfig)
  const normalizedOutput = normalizeOutputPath(task.output)
  const normalizedFiles = task.files || []
  const normalizedOutputs = task.outputs?.length
    ? task.outputs
    : outputsFromFiles(normalizedOutput, normalizedFiles, normalizedRunConfig?.outputFormat || 'wav', task.outputPrefix)
  const meta = STAGE_META[status]
  const progress = typeof task.progress === 'number'
    ? Math.max(meta.progress, Math.min(100, task.progress))
    : meta.progress
  return {
    id: task.id || `task_${Date.now()}`,
    jobId: typeof task.jobId === 'string' && task.jobId.trim() ? task.jobId : undefined,
    resultId: typeof task.resultId === 'string' && task.resultId.trim() ? task.resultId : undefined,
    batchId: typeof task.batchId === 'string' && task.batchId.trim() ? task.batchId : undefined,
    model: task.model || '',
    input: task.input || '',
    jobOutput: typeof task.jobOutput === 'string' && task.jobOutput.trim() ? normalizeOutputPath(task.jobOutput) : undefined,
    outputPrefix: typeof task.outputPrefix === 'string' && task.outputPrefix.trim() ? task.outputPrefix : undefined,
    output: normalizedOutput,
    status,
    message: interrupted ? '上次运行未完成' : (task.message || meta.label),
    createdAt: task.createdAt || Date.now(),
    updatedAt: task.updatedAt || task.createdAt || Date.now(),
    progress: TERMINAL_STATUSES.includes(status) ? 100 : progress,
    stageLabel: interrupted ? '已中断' : (task.stageLabel || meta.label),
    progressCurrent: typeof task.progressCurrent === 'number' ? task.progressCurrent : undefined,
    progressTotal: typeof task.progressTotal === 'number' ? task.progressTotal : undefined,
    progressDetail: task.progressDetail || undefined,
    files: normalizedFiles,
    outputs: normalizedOutputs,
    logs: interrupted
      ? [...(task.logs || []), `${new Date().toLocaleTimeString()} 应用关闭或重启，任务已标记为中断。`].slice(-300)
      : (task.logs || []),
    error: interrupted ? '应用关闭或重启导致任务中断' : task.error,
    runConfig: normalizedRunConfig,
    taskHidden: task.taskHidden === true,
    resultHidden: task.resultHidden === true,
  }
}

function normalizeRunConfig(runConfig?: SeparationRunConfig): SeparationRunConfig | undefined {
  if (!runConfig) return undefined
  const next: SeparationRunConfig = {
    ...runConfig,
    selectedStems: Array.isArray(runConfig.selectedStems)
      ? runConfig.selectedStems.map(item => String(item || '').trim()).filter(Boolean)
      : [],
    audioParams: { ...(runConfig.audioParams || {}) },
    inferenceParams: { ...(runConfig.inferenceParams || {}) },
  }
  const version = next.inferenceParamsVersion || 0
  if (version >= CURRENT_INFERENCE_PARAMS_VERSION) {
    next.inferenceParamsVersion = CURRENT_INFERENCE_PARAMS_VERSION
    return next
  }

  const params = { ...(next.inferenceParams || {}) }
  const hasStandardize = Object.prototype.hasOwnProperty.call(params, 'standardize')
  const hasNormalize = Object.prototype.hasOwnProperty.call(params, 'normalize')

  if (!hasStandardize && !hasNormalize) {
    // Legacy desktop only omitted `normalize` when the old input-standardize
    // checkbox was enabled. Preserve that behavior on retry/history restore.
    params.standardize = true
    params.normalize = false
  } else if (!hasStandardize && hasNormalize) {
    // Legacy desktop used `normalize` to mean input standardization.
    params.standardize = Boolean(params.normalize)
    params.normalize = false
  } else if (hasStandardize && !hasNormalize) {
    // First compatibility pass already switched to `standardize`, but output
    // normalize had not been made explicit yet.
    params.normalize = false
  }

  next.inferenceParams = params
  next.inferenceParamsVersion = CURRENT_INFERENCE_PARAMS_VERSION
  return next
}

function isVrModelType(modelType?: string | null) {
  return String(modelType || '').trim().toLowerCase() === 'vr'
}

function isApolloModelType(modelType?: string | null) {
  return String(modelType || '').trim().toLowerCase() === 'apollo'
}

type InferenceNumberField =
  | 'batch_size'
  | 'overlap_size'
  | 'num_overlap'
  | 'chunk_size'
  | 'window_size'
  | 'aggression'
  | 'post_process_threshold'

const ZERO_AS_UNSET_FIELDS = new Set<InferenceNumberField>([
  'batch_size',
  'overlap_size',
  'num_overlap',
  'chunk_size',
  'window_size',
])

function normalizeEditableNumberValue(
  current: number | null | undefined,
  options: { zeroMeansUnset: boolean },
) {
  const { zeroMeansUnset } = options
  if (typeof current !== 'number' || !Number.isFinite(current)) return null
  if (zeroMeansUnset && current <= 0) return null
  return current
}

function resolveNumberOverride(
  defaults: ModelDefaultInferenceParams | undefined,
  key: keyof ModelDefaultInferenceParams,
  current: number | null | undefined,
  options?: { zeroMeansUnset?: boolean },
) {
  const zeroMeansUnset = options?.zeroMeansUnset ?? false
  const normalizedCurrent = normalizeEditableNumberValue(current, { zeroMeansUnset })
  if (normalizedCurrent === null) return null
  const defaultValue = defaults?.[key]
  if (typeof defaultValue === 'number') return normalizedCurrent === defaultValue ? null : normalizedCurrent
  return normalizedCurrent
}

function resolveBooleanOverride(defaults: ModelDefaultInferenceParams | undefined, key: keyof ModelDefaultInferenceParams, current: boolean) {
  const defaultValue = defaults?.[key]
  if (typeof defaultValue === 'boolean') return current === defaultValue ? null : current
  return current ? true : null
}

function applyModelDefaultsToUi(
  defaults: ModelDefaultInferenceParams | undefined,
  modelType?: string | null,
) {
  const vrModel = isVrModelType(modelType)
  const apolloModel = isApolloModelType(modelType)
  return {
    batch_size: defaults?.batch_size ?? (vrModel ? 2 : 1),
    overlap_size: vrModel ? 0 : (defaults?.overlap_size ?? 0),
    num_overlap: (vrModel || apolloModel) ? 0 : (defaults?.num_overlap ?? 0),
    chunk_size: vrModel ? 0 : (defaults?.chunk_size ?? 0),
    standardize: vrModel ? false : (defaults?.standardize ?? true),
    normalize: defaults?.normalize ?? false,
    window_size: vrModel ? (defaults?.window_size ?? 512) : 0,
    aggression: vrModel ? (defaults?.aggression ?? 5) : 0,
    enable_post_process: vrModel ? (defaults?.enable_post_process ?? false) : false,
    post_process_threshold: vrModel ? (defaults?.post_process_threshold ?? 0.2) : 0,
    high_end_process: vrModel ? (defaults?.high_end_process ?? false) : false,
  }
}

function resolveTaskErrorMessage(code: unknown, message: unknown, input?: string) {
  const detail = typeof message === 'string' ? message : ''
  const path = typeof input === 'string' ? input : ''
  if (code === 'INPUT_AUDIO_STREAM_MISSING') {
    return i18n.global.t('separate.inputAudioStreamMissing', { path })
  }
  if (code === 'INPUT_MEDIA_UNSUPPORTED') {
    return i18n.global.t('separate.inputMediaUnsupported', { path })
  }
  return detail || i18n.global.t('toast.taskFailed')
}

export const useTaskStore = defineStore('task', () => {
  const initialized = ref(false)
  const tasks = ref<SeparationTask[]>([])
  const activeTaskId = ref<string | null>(null)
  const focusedResultTaskId = ref<string | null>(null)
  const focusedTaskId = ref<string | null>(null)
  const inputFiles = ref<string[]>([])
  const useTta = ref(false)
  const debug = ref(false)
  const batch_size = ref<number | null>(1)
  const overlap_size = ref<number | null>(0)
  const num_overlap = ref<number | null>(0)
  const chunk_size = ref<number | null>(0)
  const standardize = ref(true)
  const normalize = ref(false)
  const selectedStems = ref<string[]>([])
  const window_size = ref<number | null>(0)
  const aggression = ref<number | null>(0)
  const enable_post_process = ref(false)
  const post_process_threshold = ref<number | null>(0)
  const high_end_process = ref(false)
  const selectedModelDefaults = ref<ModelDefaultInferenceParams>({})
  const selectedModelType = ref<string | null>(null)

  const inputPath = computed(() => inputFiles.value[0] || '')
  const activeTask = computed(() => tasks.value.find((task) => task.id === activeTaskId.value) || null)
  const completedTasks = computed(() => tasks.value.filter((task) => task.status === 'done'))
  const runningTasks = computed(() => tasks.value.filter((task) => !TERMINAL_STATUSES.includes(task.status)))
  const activeWorkerTasks = computed(() => tasks.value.filter((task) => !TERMINAL_STATUSES.includes(task.status) && task.status !== 'queued'))
  // 任务页可见任务：排除已在任务页隐藏的记录（结果页隐藏不影响任务页）
  const taskBoardTasks = computed(() => tasks.value.filter((task) => !task.taskHidden))
  // 结果页可见结果：仅含有输出且未在结果页隐藏的任务（任务页隐藏不影响结果页）
  const resultTasks = computed(() => completedTasks.value.filter((task) => !task.resultHidden && (task.outputs.length || task.files.length)))
  const queuedTasks = computed(() => tasks.value.filter((task) => task.status === 'queued'))
  const failedTasks = computed(() => tasks.value.filter((task) => task.status === 'failed'))
  const allJobs = computed(() => buildJobs(tasks.value))
  const resultJobs = computed(() => buildJobs(resultTasks.value))

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let progressPersistTimer: ReturnType<typeof setTimeout> | null = null

  function taskJobId(task: SeparationTask) {
    return task.jobId || task.batchId || task.id
  }

  function buildJobs(sourceTasks: SeparationTask[]): SeparationJob[] {
    const groups = new Map<string, SeparationTask[]>()
    sourceTasks.forEach((task) => {
      const id = taskJobId(task)
      groups.set(id, [...(groups.get(id) || []), task])
    })
    return [...groups.entries()].map(([id, items]) => {
      const sorted = [...items].sort((a, b) => a.createdAt - b.createdAt)
      const primary = sorted[0]
      const output = primary.jobOutput || primary.output
      const progressTotal = sorted.reduce((sum, item) => {
        if (TERMINAL_STATUSES.includes(item.status)) return sum + 100
        if (item.status === 'queued') return sum
        return sum + Math.max(0, Math.min(99, Number(item.progress || 0)))
      }, 0)
      const status = resolveJobStatus(sorted)
      return {
        id,
        output,
        tasks: sorted,
        primary,
        model: primary.model,
        inputCount: sorted.length,
        outputCount: sorted.reduce((sum, item) => sum + item.outputs.length, 0),
        createdAt: Math.min(...sorted.map(item => item.createdAt)),
        updatedAt: Math.max(...sorted.map(item => item.updatedAt)),
        status,
        progress: Math.round(progressTotal / sorted.length),
      }
    })
  }

  function resolveJobStatus(items: SeparationTask[]): TaskStatus {
    if (items.some(item => !TERMINAL_STATUSES.includes(item.status))) return 'separating'
    if (items.every(item => item.status === 'done')) return 'done'
    if (items.every(item => item.status === 'cancelled')) return 'cancelled'
    if (items.every(item => item.status === 'failed')) return 'failed'
    if (items.some(item => item.status === 'done')) return 'done'
    if (items.some(item => item.status === 'failed')) return 'failed'
    return 'cancelled'
  }

  function getJobById(id: string | null | undefined) {
    if (!id) return null
    return allJobs.value.find((job) => job.id === id) || null
  }

  async function persistTasks() {
    if (!initialized.value) return
    await saveAppStore('task-history', {
      tasks: tasks.value.slice(0, 80).map((task) => ({ ...task, logs: task.logs.slice(-120) })),
    } satisfies PersistedTaskState)
  }

  function queuePersist() {
    if (!initialized.value) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void persistTasks()
    }, 120)
  }

  function queueProgressPersist() {
    if (!initialized.value) return
    if (progressPersistTimer) return
    progressPersistTimer = setTimeout(() => {
      progressPersistTimer = null
      void persistTasks()
    }, 800)
  }

  async function initialize() {
    if (initialized.value) return
    const stored = await loadAppStore<PersistedTaskState>('task-history')
    tasks.value = (stored?.tasks || []).map((task) => normalizeTask(task))
    activeTaskId.value = tasks.value[0]?.id || null
    initialized.value = true
  }

  watch(() => useSettingsStore().maxConcurrentSeparations, () => {
    scheduleQueue()
  })

  function touch(task: SeparationTask) {
    task.updatedAt = Date.now()
  }

  function applySelectedModelDefaults(defaults: ModelDefaultInferenceParams | undefined, modelType?: string | null) {
    selectedModelDefaults.value = defaults ? { ...defaults } : {}
    selectedModelType.value = modelType ?? null
    const next = applyModelDefaultsToUi(defaults, modelType)
    batch_size.value = next.batch_size ?? 1
    overlap_size.value = next.overlap_size ?? 0
    num_overlap.value = next.num_overlap ?? 0
    chunk_size.value = next.chunk_size ?? 0
    standardize.value = next.standardize ?? !isVrModelType(modelType)
    normalize.value = next.normalize ?? false
    window_size.value = next.window_size ?? 0
    aggression.value = next.aggression ?? 0
    enable_post_process.value = next.enable_post_process ?? false
    post_process_threshold.value = next.post_process_threshold ?? 0
    high_end_process.value = next.high_end_process ?? false
  }

  function getCurrentUiInferenceDefaults() {
    return applyModelDefaultsToUi(selectedModelDefaults.value, selectedModelType.value)
  }

  function restoreInferenceNumberFallback(field: InferenceNumberField) {
    if (!ZERO_AS_UNSET_FIELDS.has(field)) return
    const defaults = getCurrentUiInferenceDefaults()
    const nextValue = defaults[field]
    if (typeof nextValue !== 'number' || !Number.isFinite(nextValue)) return
    switch (field) {
      case 'batch_size':
        if (normalizeEditableNumberValue(batch_size.value, { zeroMeansUnset: true }) === null) batch_size.value = nextValue
        break
      case 'overlap_size':
        if (normalizeEditableNumberValue(overlap_size.value, { zeroMeansUnset: true }) === null) overlap_size.value = nextValue
        break
      case 'num_overlap':
        if (normalizeEditableNumberValue(num_overlap.value, { zeroMeansUnset: true }) === null) num_overlap.value = nextValue
        break
      case 'chunk_size':
        if (normalizeEditableNumberValue(chunk_size.value, { zeroMeansUnset: true }) === null) chunk_size.value = nextValue
        break
      case 'window_size':
        if (normalizeEditableNumberValue(window_size.value, { zeroMeansUnset: true }) === null) window_size.value = nextValue
        break
      case 'aggression':
      case 'post_process_threshold':
        break
    }
  }

  function normalizeInferenceInputsBeforeSubmit() {
    restoreInferenceNumberFallback('batch_size')
    restoreInferenceNumberFallback('overlap_size')
    restoreInferenceNumberFallback('num_overlap')
    restoreInferenceNumberFallback('chunk_size')
    restoreInferenceNumberFallback('window_size')
  }

  function appendTaskLogs(task: SeparationTask, lines: string | string[]) {
    const settings = useSettingsStore()
    const values = Array.isArray(lines) ? lines : [lines]
    const normalized = values
      .flatMap((line) => String(line || '').split(/\r?\n/))
      .map((line) => line.trimEnd())
      .filter(Boolean)
    if (!normalized.length) return
    task.logs.push(...normalized)
    task.logs = task.logs.slice(-getLogLimit(settings.developerMode))
    touch(task)
    queuePersist()
  }

  function maxConcurrentSeparations() {
    const settings = useSettingsStore()
    const value = Number(settings.maxConcurrentSeparations || 1)
    if (!Number.isFinite(value)) return 1
    return Math.min(MAX_CONCURRENT_SEPARATIONS, Math.max(1, Math.trunc(value)))
  }

  function buildRunConfig(inferenceParams: Record<string, unknown>, modelType?: string | null): SeparationRunConfig {
    const settings = useSettingsStore()
    const app = useAppStore()
    const runtimeDevice = settings.getRuntimeDeviceConfig(app.envInfo)
    return {
      modelDir: settings.modelDir || null,
      downloadSource: settings.downloadSource,
      modelType: modelType ?? null,
      device: runtimeDevice.device,
      deviceIds: runtimeDevice.deviceIds,
      outputFormat: settings.defaultFormat,
      selectedStems: [...selectedStems.value],
      useTta: useTta.value,
      debug: debug.value,
      audioParams: settings.getAudioParams(),
      inferenceParamsVersion: CURRENT_INFERENCE_PARAMS_VERSION,
      inferenceParams,
    }
  }

  function createQueuedTask(input: string, model: string, inferenceParams: Record<string, unknown>, modelType?: string | null, jobId?: string, jobOutput?: string, outputPrefix?: string, outputChild?: string) {
    const settings = useSettingsStore()
    const id = createRunId('sep')
    const resultId = createRunId('result')
    const resolvedJobOutput = jobOutput || resolveJobOutputPath(settings.outputDir, jobId || id)
    const task: SeparationTask = {
      id,
      jobId,
      resultId,
      model,
      input,
      jobOutput: resolvedJobOutput,
      outputPrefix,
      output: joinOutputPath(resolvedJobOutput, outputChild || resultId),
      status: 'queued',
      message: 'Queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      progress: STAGE_META.queued.progress,
      stageLabel: STAGE_META.queued.label,
      files: [],
      outputs: [],
      logs: [`${new Date().toLocaleTimeString()} Queued`],
      runConfig: buildRunConfig(inferenceParams, modelType),
    }
    tasks.value.unshift(task)
    activeTaskId.value = id
    queuePersist()
    return task
  }

  async function startQueuedTask(taskId: string) {
    const task = tasks.value.find((item) => item.id === taskId)
    if (!task || task.status !== 'queued') return false
    const settings = useSettingsStore()
    const config = task.runConfig || buildRunConfig({})
    setTaskStatus(task.id, 'preparing', 'Preparing task')
    try {
      await invoke<{ taskId: string; started: boolean }>('start_separation', {
        payload: {
          taskId: task.id,
          model: task.model,
          input: task.input,
          output: task.output,
          outputPrefix: task.outputPrefix,
          modelDir: config.modelDir ?? (settings.modelDir || null),
          download: true,
          source: config.downloadSource || settings.downloadSource,
          endpoint: null,
          device: config.device,
          deviceIds: config.deviceIds,
          outputFormat: config.outputFormat,
          selectedStems: config.selectedStems || [],
          useTta: config.useTta,
          debug: config.debug,
          audioParams: config.audioParams,
          inferenceParamsVersion: config.inferenceParamsVersion ?? CURRENT_INFERENCE_PARAMS_VERSION,
          inferenceParams: config.inferenceParams || {},
        },
      })
      return true
    } catch (err) {
      task.status = 'failed'
      task.error = err instanceof Error ? err.message : String(err)
      task.message = task.error
      task.stageLabel = STAGE_META.failed.label
      task.progress = 100
      appendTaskLogs(task, `error: ${task.error}`)
      queuePersist()
      scheduleQueue()
      return false
    }
  }

  async function startBatchWorker(batchTasks: SeparationTask[]) {
    if (!batchTasks.length) return false
    const settings = useSettingsStore()
    const primary = batchTasks[0]
    const config = primary.runConfig || buildRunConfig({})
    batchTasks.forEach((task) => {
      setTaskStatus(task.id, 'preparing', 'Preparing batch task')
    })
    try {
      await invoke<{ taskId: string; started: boolean }>('start_separation', {
        payload: {
          taskId: primary.id,
          model: primary.model,
          output: primary.jobOutput || primary.output,
          tasks: batchTasks.map((task) => ({
            taskId: task.id,
            input: task.input,
            outputPrefix: task.outputPrefix,
            output: task.output,
          })),
          modelDir: config.modelDir ?? (settings.modelDir || null),
          download: true,
          source: config.downloadSource || settings.downloadSource,
          endpoint: null,
          device: config.device,
          deviceIds: config.deviceIds,
          outputFormat: config.outputFormat,
          selectedStems: config.selectedStems || [],
          useTta: config.useTta,
          debug: config.debug,
          audioParams: config.audioParams,
          inferenceParamsVersion: config.inferenceParamsVersion ?? CURRENT_INFERENCE_PARAMS_VERSION,
          inferenceParams: config.inferenceParams || {},
        },
      })
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      batchTasks.forEach((task) => {
        task.status = 'failed'
        task.error = message
        task.message = message
        task.stageLabel = STAGE_META.failed.label
        task.progress = 100
        appendTaskLogs(task, `error: ${message}`)
      })
      queuePersist()
      scheduleQueue()
      return false
    }
  }

  function scheduleQueue() {
    const available = maxConcurrentSeparations() - activeWorkerTasks.value.length
    if (available <= 0) return
    const nextTasks = tasks.value
      .filter((task) => task.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, available)
    nextTasks.forEach((task) => {
      void startQueuedTask(task.id)
    })
  }

  function setTaskStatus(id: string, status: TaskStatus, message?: string, progress?: number) {
    const settings = useSettingsStore()
    const task = tasks.value.find((item) => item.id === id)
    if (!task) return
    if (TERMINAL_STATUSES.includes(task.status) && !TERMINAL_STATUSES.includes(status)) return
    const meta = STAGE_META[status]
    task.status = status
    task.stageLabel = meta.label
    task.message = message || meta.label
    if (status !== 'separating') {
      task.progressCurrent = undefined
      task.progressTotal = undefined
      task.progressDetail = undefined
    }
    const nextProgress = progress ?? meta.progress
    const normalizedProgress = Math.min(99, Math.max(0, nextProgress))
    task.progress = status === 'done' || status === 'failed' || status === 'cancelled'
      ? 100
      : status === 'separating'
        ? normalizedProgress
        : Math.max(task.progress || 0, normalizedProgress)
    task.logs.push(`${new Date().toLocaleTimeString()} ${task.message}`)
    task.logs = task.logs.slice(-getLogLimit(settings.developerMode))
    touch(task)
    queuePersist()
  }

  function handleWorkerEvent(event: any) {
    const taskId = event?.taskId
    if (!taskId) return
    const task = tasks.value.find((item) => item.id === taskId)
    if (!task) return
    if (event.type === 'task_started') {
      setTaskStatus(taskId, 'preparing', 'Task started', 6)
    } else if (event.type === 'task_stage') {
      const stage = normalizeStatus(event.payload?.stage)
      setTaskStatus(taskId, stage, event.payload?.message || STAGE_META[stage].label, event.payload?.progress)
    } else if (event.type === 'task_progress') {
      const stage = normalizeStatus(event.payload?.stage)
      const done = Number(event.payload?.done)
      const total = Number(event.payload?.total)
      const detail = typeof event.payload?.message === 'string' ? event.payload.message : undefined
      task.status = stage
      task.stageLabel = STAGE_META[stage].label
      task.message = detail || STAGE_META[stage].label
      task.progressCurrent = Number.isFinite(done) ? done : undefined
      task.progressTotal = Number.isFinite(total) ? total : undefined
      task.progressDetail = detail
      const resolvedProgress = Math.min(99, resolveStageProgress(stage, task.progressCurrent, task.progressTotal))
      task.progress = stage === 'separating'
        ? resolvedProgress
        : Math.max(task.progress || 0, resolvedProgress)
      touch(task)
      queueProgressPersist()
    } else if (event.type === 'task_log') {
      const settings = useSettingsStore()
      const level = String(event.payload?.level || 'info')
      const message = String(event.payload?.message || '')
      appendTaskLogs(task, settings.developerMode ? `[${level}] ${message}` : `${level}: ${message}`)
    } else if (event.type === 'error') {
      if (task.status === 'cancelled') return
      const codeValue = event.payload?.code
      const code = codeValue ? `[${codeValue}] ` : ''
      const message = resolveTaskErrorMessage(codeValue, event.payload?.message, task.input)
      const detail = event.payload?.detail || ''
      const recoverable = Boolean(event.payload?.recoverable)
      task.error = message
      task.message = message
      task.progressCurrent = undefined
      task.progressTotal = undefined
      task.progressDetail = undefined
      if (recoverable) {
        task.stageLabel = task.stageLabel || STAGE_META.failed.label
        task.progress = Math.min(99, Math.max(task.progress || 0, 1))
      } else {
        task.status = 'failed'
        task.stageLabel = STAGE_META.failed.label
        task.progress = 100
      }
      appendTaskLogs(task, [`error: ${code}${message}`, detail ? `traceback:\n${detail}` : ''])
    } else if (event.type === 'task_done') {
      task.status = 'done'
      task.message = 'Done'
      task.stageLabel = STAGE_META.done.label
      task.progress = 100
      task.progressCurrent = undefined
      task.progressTotal = undefined
      task.progressDetail = undefined
      task.files = event.payload?.files || []
      if (event.payload?.outputDir) task.output = event.payload.outputDir
      task.outputs = event.payload?.outputs?.length
        ? event.payload.outputs
        : outputsFromFiles(task.output, task.files, event.payload?.outputFormat || 'wav', task.outputPrefix)
      task.error = undefined
      touch(task)
      queuePersist()
    } else if (event.type === 'task_cancelled') {
      task.status = 'cancelled'
      task.message = event.payload?.message || 'Cancelled'
      task.stageLabel = STAGE_META.cancelled.label
      task.progress = 100
      task.progressCurrent = undefined
      task.progressTotal = undefined
      task.progressDetail = undefined
      touch(task)
      queuePersist()
    }
    if (TERMINAL_STATUSES.includes(task.status)) scheduleQueue()
  }

  function addInputFiles(paths: string[]) {
    const valid = paths.filter((p) => p?.trim() && isSupportedInputPath(p))
    if (!valid.length) return 0
    const existing = new Set(inputFiles.value)
    const additions = valid.filter((p) => !existing.has(p))
    if (additions.length) inputFiles.value = [...inputFiles.value, ...additions]
    return additions.length
  }

  function removeInputFile(path: string) {
    inputFiles.value = inputFiles.value.filter((p) => p !== path)
  }

  function clearInputFiles() {
    inputFiles.value = []
  }

  async function pickFiles() {
    const files = await invoke<string[]>('pick_media_files')
    addInputFiles(files || [])
    return files?.length || 0
  }

  async function scanAndAddPaths(paths: string[]) {
    if (!paths?.length) return { added: 0, warnings: [] as string[] }
    const result = await invoke<ScanMediaPathsResult>('scan_media_paths', { paths })
    return { added: addInputFiles(result.files || []), warnings: result.warnings || [] }
  }

  async function pickInputFolder() {
    const folder = await invoke<string | null>('pick_input_folder')
    if (!folder) return 0
    const result = await scanAndAddPaths([folder])
    return result.added
  }

  async function addPaths(paths: string[]) {
    const result = await scanAndAddPaths(paths)
    return result.added
  }

  async function revealPath(path: string) {
    await invoke('reveal_path', { path })
  }

  async function trashPaths(paths: string[]) {
    const valid = paths.filter((p) => p?.trim())
    if (!valid.length) return { trashed: [] as string[], failed: [] as string[] }
    return invoke<{ trashed: string[]; failed: string[] }>('move_paths_to_trash', { paths: valid })
  }

  // 删除结果时始终仅回收当前结果对应的输出文件，避免误删共享目录、
  // 任务目录中的附加文件或后续派生产物。
  function resultTrashTargets(task: SeparationTask): string[] {
    const seen = new Set<string>()
    return task.outputs
      .map((output) => output.path?.trim())
      .filter((path): path is string => Boolean(path))
      .filter((path) => {
        if (seen.has(path)) return false
        seen.add(path)
        return true
      })
  }

  function primaryRevealPath(task: SeparationTask) {
    return task.output
  }

  function getTaskById(id: string) {
    return tasks.value.find((task) => task.id === id) || null
  }

  function focusResultTask(id: string | null) {
    focusedResultTaskId.value = id
  }

  function focusTask(id: string | null) {
    focusedTaskId.value = id
  }

  // 任务是否还会出现在结果页（done + 有输出 + 未被结果页隐藏）。
  // 不会出现在结果页的任务，其“结果维度”视为已不存在。
  function hasResultPresence(task: SeparationTask) {
    return task.status === 'done'
      && !task.resultHidden
      && (task.outputs.length > 0 || task.files.length > 0)
  }

  // 当一个任务在任务页与结果页都不再可见时，从底层数组彻底回收，避免无限堆积。
  function reclaimHiddenTasks() {
    tasks.value = tasks.value.filter((task) => !task.taskHidden || hasResultPresence(task))
  }

  function removeTask(id: string) {
    const target = tasks.value.find((task) => task.id === id)
    if (!target) return
    // 任务页删除仅隐藏日志记录，不影响结果页与磁盘文件
    target.taskHidden = true
    if (activeTaskId.value === id) activeTaskId.value = taskBoardTasks.value[0]?.id || null
    if (focusedTaskId.value === id) focusedTaskId.value = null
    reclaimHiddenTasks()
    queuePersist()
  }

  function removeTasks(ids: string[]) {
    const removeSet = new Set(ids)
    if (!removeSet.size) return 0
    let removed = 0
    tasks.value.forEach((task) => {
      if (removeSet.has(task.id) && !task.taskHidden) {
        task.taskHidden = true
        removed += 1
      }
    })
    if (!removed) return 0
    if (activeTaskId.value && removeSet.has(activeTaskId.value)) {
      activeTaskId.value = taskBoardTasks.value[0]?.id || null
    }
    if (focusedTaskId.value && removeSet.has(focusedTaskId.value)) {
      focusedTaskId.value = null
    }
    reclaimHiddenTasks()
    queuePersist()
    return removed
  }

  // 结果页删除：仅隐藏结果项，不影响任务页日志记录
  function removeResult(id: string) {
    const target = tasks.value.find((task) => task.id === id)
    if (!target) return
    target.resultHidden = true
    if (focusedResultTaskId.value === id) focusedResultTaskId.value = null
    reclaimHiddenTasks()
    queuePersist()
  }

  function removeResults(ids: string[]) {
    const removeSet = new Set(ids)
    if (!removeSet.size) return 0
    let removed = 0
    tasks.value.forEach((task) => {
      if (removeSet.has(task.id) && !task.resultHidden) {
        task.resultHidden = true
        removed += 1
      }
    })
    if (!removed) return 0
    if (focusedResultTaskId.value && removeSet.has(focusedResultTaskId.value)) {
      focusedResultTaskId.value = null
    }
    reclaimHiddenTasks()
    queuePersist()
    return removed
  }

  function clearHistory() {
    // 仅清空任务页的历史记录（标记 taskHidden），保留结果页数据
    tasks.value.forEach((task) => {
      if (TERMINAL_STATUSES.includes(task.status)) task.taskHidden = true
    })
    reclaimHiddenTasks()
    queuePersist()
  }

  // 结果页清空：将指定结果（或全部当前可见结果）标记为 resultHidden，不影响任务页与磁盘文件
  function clearResults(ids?: string[]) {
    const removeSet = ids?.length ? new Set(ids) : null
    let removed = 0
    tasks.value.forEach((task) => {
      if (task.resultHidden) return
      if (task.status !== 'done' || (!task.outputs.length && !task.files.length)) return
      if (removeSet && !removeSet.has(task.id)) return
      if (!task.resultHidden) {
        task.resultHidden = true
        removed += 1
      }
    })
    if (!removed) return 0
    focusedResultTaskId.value = null
    reclaimHiddenTasks()
    queuePersist()
    return removed
  }

  async function cancelAllTasks() {
    const currentRunning = [...runningTasks.value]
    if (!currentRunning.length) return { total: 0, cancelled: 0 }
    let cancelled = 0
    for (const item of currentRunning) {
      // 串行取消，避免同时调用底层取消造成竞态
      // eslint-disable-next-line no-await-in-loop
      const ok = await cancelTask(item.id)
      if (ok) cancelled += 1
    }
    return { total: currentRunning.length, cancelled }
  }

  async function cancelTask(id: string) {
    const task = tasks.value.find((item) => item.id === id)
    if (!task) return false
    if (task.status === 'queued') {
      task.status = 'cancelled'
      task.message = 'Cancelled'
      task.stageLabel = STAGE_META.cancelled.label
      task.progress = 100
      appendTaskLogs(task, 'Cancelled before execution')
      queuePersist()
      scheduleQueue()
      return true
    }
    const cancelled = await invoke<boolean>('cancel_task', { taskId: id })
    if (cancelled) {
      task.status = 'cancelled'
      task.message = 'Cancelled'
      task.stageLabel = STAGE_META.cancelled.label
      task.progress = 100
      touch(task)
      queuePersist()
      scheduleQueue()
    }
    return cancelled
  }

  function buildInferenceParams(modelType?: string | null): Record<string, unknown> {
    const inferenceParams: Record<string, unknown> = {}
    const defaults = selectedModelDefaults.value
    const vrModel = isVrModelType(modelType)
    const apolloModel = isApolloModelType(modelType)

    const batchSizeOverride = resolveNumberOverride(defaults, 'batch_size', batch_size.value, { zeroMeansUnset: true })
    if (batchSizeOverride !== null) inferenceParams.batch_size = batchSizeOverride

    if (vrModel) {
      const windowSizeOverride = resolveNumberOverride(defaults, 'window_size', window_size.value, { zeroMeansUnset: true })
      const aggressionOverride = resolveNumberOverride(defaults, 'aggression', aggression.value)
      const enablePostProcessOverride = resolveBooleanOverride(defaults, 'enable_post_process', enable_post_process.value)
      const postProcessThresholdOverride = resolveNumberOverride(defaults, 'post_process_threshold', post_process_threshold.value)
      const highEndProcessOverride = resolveBooleanOverride(defaults, 'high_end_process', high_end_process.value)
      const normalizeOverride = resolveBooleanOverride(defaults, 'normalize', normalize.value)

      if (windowSizeOverride !== null) inferenceParams.window_size = windowSizeOverride
      if (aggressionOverride !== null) inferenceParams.aggression = aggressionOverride
      if (enablePostProcessOverride !== null) inferenceParams.enable_post_process = enablePostProcessOverride
      if (postProcessThresholdOverride !== null) inferenceParams.post_process_threshold = postProcessThresholdOverride
      if (highEndProcessOverride !== null) inferenceParams.high_end_process = highEndProcessOverride
      if (normalizeOverride !== null) inferenceParams.normalize = normalizeOverride
      return inferenceParams
    }

    const overlapSizeOverride = resolveNumberOverride(defaults, 'overlap_size', overlap_size.value, { zeroMeansUnset: true })
    const numOverlapOverride = apolloModel
      ? null
      : resolveNumberOverride(defaults, 'num_overlap', num_overlap.value, { zeroMeansUnset: true })
    const chunkSizeOverride = resolveNumberOverride(defaults, 'chunk_size', chunk_size.value, { zeroMeansUnset: true })
    const standardizeOverride = resolveBooleanOverride(defaults, 'standardize', standardize.value)
    const normalizeOverride = resolveBooleanOverride(defaults, 'normalize', normalize.value)

    if (overlapSizeOverride !== null) inferenceParams.overlap_size = overlapSizeOverride
    if (numOverlapOverride !== null) inferenceParams.num_overlap = numOverlapOverride
    if (chunkSizeOverride !== null) inferenceParams.chunk_size = chunkSizeOverride
    if (standardizeOverride !== null) inferenceParams.standardize = standardizeOverride
    if (normalizeOverride !== null) inferenceParams.normalize = normalizeOverride
    return inferenceParams
  }

  function buildOutputPrefixes(inputs: string[]) {
    const counts = new Map<string, number>()
    return inputs.map((input, index) => {
      const base = safeOutputSegment(input, `input-${index + 1}`)
      const count = counts.get(base) || 0
      counts.set(base, count + 1)
      return count ? `${base}-${count + 1}` : base
    })
  }

  function submitOne(input: string, model: string, inferenceParams: Record<string, unknown>, modelType?: string | null, jobId?: string, jobOutput?: string, outputPrefix?: string, outputChild?: string) {
    return createQueuedTask(input, model, inferenceParams, modelType, jobId, jobOutput, outputPrefix, outputChild)
  }

  async function startSeparation(options: { outputDir?: string } = {}) {
    const modelStore = useModelStore()
    if (!inputFiles.value.length) {
      throw new Error('Input file is required')
    }
    if (!modelStore.selectedModel.trim()) {
      throw new Error('Model is required')
    }
    const model = modelStore.selectedModel
    const selectedEntry = modelStore.selectedInfo?.name === model
      ? modelStore.selectedInfo
      : modelStore.models.find((item) => item.name === model) || null
    const modelType = selectedEntry?.modelType || null
    normalizeInferenceInputsBeforeSubmit()
    const inferenceParams = buildInferenceParams(modelType)
    const targets = [...inputFiles.value]
    const jobId = createRunId('job')
    const settings = useSettingsStore()
    const jobOutput = resolveJobOutputPath(options.outputDir || settings.outputDir, jobId)
    const outputPrefixes = buildOutputPrefixes(targets)
    const batchMode = targets.length > 1
    const createdTasks = targets.map((input, index) => submitOne(
      input,
      model,
      inferenceParams,
      modelType,
      jobId,
      jobOutput,
      outputPrefixes[index],
      batchMode ? outputPrefixes[index] : undefined,
    ))
    if (batchMode) {
      void startBatchWorker(createdTasks)
    } else {
      scheduleQueue()
    }
    return { succeeded: targets.length, failed: 0, total: targets.length, jobId, tasks: createdTasks }
  }

  async function retryTask(taskId: string) {
    const existing = tasks.value.find((t) => t.id === taskId)
    if (!existing) return
    const modelStore = useModelStore()
    modelStore.selectedModel = existing.model
    const retryParams = existing.runConfig?.inferenceParams || {}
    const persistedModelType = existing.runConfig?.modelType ?? null
    const modelEntry = modelStore.models.find((item) => item.name === existing.model) || null
    const modelType = modelEntry?.modelType || persistedModelType || null
    const task = createQueuedTask(existing.input, existing.model, retryParams, modelType)
    scheduleQueue()
    return task
  }

  return {
    initialized,
    tasks,
    activeTaskId,
    activeTask,
    completedTasks,
    runningTasks,
    activeWorkerTasks,
    taskBoardTasks,
    resultTasks,
    allJobs,
    resultJobs,
    queuedTasks,
    failedTasks,
    focusedResultTaskId,
    focusedTaskId,
    inputFiles,
    inputPath,
    useTta,
    debug,
    batch_size,
    overlap_size,
    num_overlap,
    chunk_size,
    standardize,
    normalize,
    selectedStems,
    window_size,
    aggression,
    enable_post_process,
    post_process_threshold,
    high_end_process,
    restoreInferenceNumberFallback,
    initialize,
    handleWorkerEvent,
    pickFiles,
    pickInputFolder,
    addPaths,
    addInputFiles,
    removeInputFile,
    clearInputFiles,
    revealPath,
    trashPaths,
    resultTrashTargets,
    primaryRevealPath,
    getTaskById,
    getJobById,
    taskJobId,
    focusResultTask,
    focusTask,
    removeTask,
    removeTasks,
    removeResult,
    removeResults,
    clearResults,
    clearHistory,
    cancelTask,
    cancelAllTasks,
    startSeparation,
    retryTask,
    scheduleQueue,
    applySelectedModelDefaults,
    normalizeInferenceInputsBeforeSubmit,
  }
})
