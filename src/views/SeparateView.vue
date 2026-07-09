<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useDialog, useMessage } from 'naive-ui'
import { convertFileSrc } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import type { UnlistenFn } from '@tauri-apps/api/event'
import {
  CubeOutline,
  GitNetworkOutline,
  CheckmarkCircle,
  PlayOutline,
  MusicalNotesOutline,
  SearchOutline,
  FolderOutline,
  CloudUploadOutline,
  CloseOutline,
  OptionsOutline,
  SettingsOutline,
  OpenOutline,
  PauseOutline,
  TerminalOutline,
  TimeOutline,
} from '@vicons/ionicons5'
import { useModelStore } from '@/stores/model'
import { useTaskStore, type OutputLayout, type SeparationTask, type StemOutput } from '@/stores/task'
import { useWorkflowStore } from '@/stores/workflow'
import { useSettingsStore } from '@/stores/settings'
import { useAppStore } from '@/stores/app'
import { buildModelCategoryOptionsFromModels, getModelCategoryLabel } from '@/utils/modelCategory'
import AppBrandMark from '@/components/AppBrandMark.vue'

const { t, locale } = useI18n()
const message = useMessage()
const dialog = useDialog()
const router = useRouter()
const route = useRoute()
const task = useTaskStore()
const model = useModelStore()
const workflow = useWorkflowStore()
const settings = useSettingsStore()
const app = useAppStore()

const {
  inputFiles,
  useTta,
  debug,
  batch_size,
  overlap_size,
  num_overlap,
  chunk_size,
  standardize,
  normalize,
  window_size,
  aggression,
  enable_post_process,
  post_process_threshold,
  high_end_process,
  selectedStems,
} = storeToRefs(task)
const { selectedModel, downloadedModels, isLoading, detailLoading, modelPreferences } = storeToRefs(model)
const { workflows, selectedWorkflow, selectedWorkflowId } = storeToRefs(workflow)

const isDragging = ref(false)
const showSettingsDrawer = ref(false)
const showLogModal = ref(false)
const modelSearch = ref('')
const modelCategoryFilter = ref('')
const workflowSearch = ref('')
const runMode = ref<'model' | 'workflow'>(route.query.mode === 'workflow' ? 'workflow' : 'model')
const temporaryOutputDir = ref('')
const outputLayout = ref<OutputLayout>('folders')
const focusedSeparationJobId = ref<string | null>(null)
const cancellingTaskId = ref<string | null>(null)
const audioElements = new Map<string, HTMLAudioElement>()
const playingOutputPath = ref('')
const outputPlayback = ref<Record<string, { currentTime: number; duration: number }>>({})
let unlistenDragDrop: UnlistenFn | null = null

const formatOptions = [
  { label: 'WAV', value: 'wav' },
  { label: 'FLAC', value: 'flac' },
  { label: 'MP3', value: 'mp3' },
  { label: 'M4A', value: 'm4a' },
]

function getFileKindLabel(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  if (['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv'].includes(ext)) return t('separate.videoFile')
  return t('separate.audioFile')
}

const wavBitDepthOptions = computed(() => [
  { label: t('audio.pcm16'), value: 'PCM_16' },
  { label: t('audio.pcm24'), value: 'PCM_24' },
  { label: t('audio.float'), value: 'FLOAT' },
])
const flacBitDepthOptions = computed(() => [
  { label: t('audio.pcm16'), value: 'PCM_16' },
  { label: t('audio.pcm24'), value: 'PCM_24' },
])
const bitRateOptions = computed(() => [
  { label: t('audio.bitrate128'), value: '128k' },
  { label: t('audio.bitrate192'), value: '192k' },
  { label: t('audio.bitrate256'), value: '256k' },
  { label: t('audio.bitrate320'), value: '320k' },
  { label: t('audio.bitrate512'), value: '512k' },
])
const m4aCodecOptions = computed(() => [
  { label: t('audio.codecAac'), value: 'aac' },
])
const selectedModelName = computed(() => String(selectedModel.value || ''))
const runModeOptions = computed(() => [
  { label: t('separate.runModeModel'), value: 'model' },
  { label: t('separate.runModeWorkflow'), value: 'workflow' },
])
const outputLayoutOptions = computed(() => [
  { label: t('separate.outputLayoutFolders'), value: 'folders' },
  { label: t('separate.outputLayoutFlat'), value: 'flat' },
])
const canChooseOutputLayout = computed(() => inputFiles.value.length > 1)
const effectiveOutputLayout = computed<OutputLayout>(() => canChooseOutputLayout.value ? outputLayout.value : 'folders')
const listedDownloadedModels = computed(() => {
  return [...downloadedModels.value].sort((a, b) => {
    const favoriteDelta = Number(Boolean(modelPreferences.value[b.name]?.favorite)) - Number(Boolean(modelPreferences.value[a.name]?.favorite))
    if (favoriteDelta) return favoriteDelta
    return a.name.localeCompare(b.name, locale.value === 'zh-CN' ? 'zh-CN' : 'en')
  })
})
const selectedModelListItem = computed(() => listedDownloadedModels.value.find(item => item.name === selectedModelName.value) || null)
const modelDownloaded = computed(() => Boolean(selectedModelListItem.value))
const currentModelInfo = computed(() => {
  if (model.selectedInfo?.name === selectedModelName.value) return model.selectedInfo
  return selectedModelListItem.value
})
const currentModelDefaults = computed(() => currentModelInfo.value?.defaultInferenceParams || {})
const currentModelDefaultsResolved = computed(() => Boolean(currentModelInfo.value?.defaultInferenceParamsResolved))
const currentModelType = computed(() => String(currentModelInfo.value?.modelType || '').trim().toLowerCase())
const isVrModel = computed(() => currentModelType.value === 'vr')
const isApolloModel = computed(() => currentModelType.value === 'apollo')
const showStandardizeField = computed(() => Boolean(currentModelInfo.value) && !isVrModel.value)
const showNormalizeField = computed(() => Boolean(currentModelInfo.value))
const hasVisibleAdvancedFields = computed(() => (
  Object.keys(currentModelDefaults.value).some(key => !['standardize', 'normalize'].includes(key))
))
const shouldPrefetchAdvancedParams = computed(() => (
  Boolean(currentModelInfo.value?.downloaded)
  && (!currentModelDefaultsResolved.value || !String(currentModelInfo.value?.configInstruments || '').trim())
))
const advancedParamsLoading = computed(() => shouldPrefetchAdvancedParams.value && detailLoading.value)
function hasInferenceField(key: string) {
  if (key === 'standardize' || key === 'normalize') return false
  if (key === 'num_overlap' && isApolloModel.value) return false
  return Object.prototype.hasOwnProperty.call(currentModelDefaults.value, key)
}
function parseModelInstruments(value?: unknown) {
  const seen = new Set<string>()
  const rawItems = Array.isArray(value)
    ? value
    : (() => {
        const text = String(value || '').trim()
        if (!text) return []
        if (text.startsWith('[')) {
          try {
            const parsed = JSON.parse(text)
            if (Array.isArray(parsed)) return parsed
          } catch {
            // Fall through to delimiter parsing for Python-style list strings.
          }
        }
        return text.split(/[,，;；/|\n]+/)
      })()
  return rawItems
    .map(item => String(item || '').trim().replace(/^[\s"'[\](){}]+|[\s"'[\](){}]+$/g, ''))
    .filter((item) => {
      if (!item) return false
      const key = item.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
const availableStemNames = computed(() => parseModelInstruments(currentModelInfo.value?.configInstruments))
const selectedStemSummary = computed(() => {
  if (!selectedStems.value.length) return t('separate.allStems')
  return selectedStems.value.join(', ')
})
const checkedOutputStems = computed<string[]>({
  get() {
    if (!selectedStems.value.length) return [...availableStemNames.value]
    return selectedStems.value
  },
  set(value) {
    const allowed = new Set(availableStemNames.value)
    const next = value.filter(stem => allowed.has(stem))
    selectedStems.value = next.length === availableStemNames.value.length ? [] : next
  },
})
const selectedOutputStemCount = computed(() => checkedOutputStems.value.length)
const selectedStemDetail = computed(() => {
  if (selectedStems.value.length > 6) {
    return t('separate.selectedStemCount', {
      count: selectedOutputStemCount.value,
      total: availableStemNames.value.length,
    })
  }
  return selectedStemSummary.value
})
const startStatusText = computed(() => {
  if (!inputFiles.value.length) return t('separate.startHintNoInput')
  if (runMode.value === 'workflow' && !selectedWorkflow.value) return t('separate.startHintNoWorkflow')
  if (runMode.value === 'model' && !modelDownloaded.value) return t('separate.startHintModelMissing')
  return t('separate.readyToStart')
})
const modelCategoryOptions = computed(() => [
  { label: t('common.all'), value: '' },
  ...buildModelCategoryOptionsFromModels(listedDownloadedModels.value, locale.value),
])
const filteredDownloadedModels = computed(() => {
  const query = modelSearch.value.trim().toLowerCase()
  const selectedCategory = modelCategoryFilter.value.trim().toLowerCase()
  return listedDownloadedModels.value.filter((item) => {
    const matchesQuery = !query
      || item.name.toLowerCase().includes(query)
      || item.aliases.some(alias => alias.toLowerCase().includes(query))
      || item.architecture.toLowerCase().includes(query)
      || item.modelType?.toLowerCase().includes(query)
      || item.targetStem.toLowerCase().includes(query)
      || item.configTargetInstrument.toLowerCase().includes(query)
      || item.category.toLowerCase().includes(query)
      || item.categoryCn.toLowerCase().includes(query)
      || item.classificationBasis.toLowerCase().includes(query)
    const matchesCategory = !selectedCategory
      || item.category.toLowerCase() === selectedCategory
      || item.primaryCategory.toLowerCase() === selectedCategory
      || item.secondaryCategory.toLowerCase() === selectedCategory
    return matchesQuery && matchesCategory
  })
})
const filteredWorkflows = computed(() => {
  const query = workflowSearch.value.trim().toLowerCase()
  return [...workflows.value]
    .filter((item) => {
      if (!query) return true
      return item.name.toLowerCase().includes(query) || item.description.toLowerCase().includes(query)
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
})

const normalizedOutputDir = computed(() => (temporaryOutputDir.value || settings.outputDir || 'results').trim() || 'results')
const outputPreview = computed(() => {
  const base = normalizedOutputDir.value.replace(/[\\/]$/, '')
  const separator = base.includes('\\') ? '\\' : '/'
  if (effectiveOutputLayout.value === 'flat') {
    return `${base}${separator}${t('separate.taskIdPreview')}${separator}${t('separate.outputFilePreview')}`
  }
  return `${base}${separator}${t('separate.taskIdPreview')}${separator}${t('separate.resultIdPreview')}${separator}${t('separate.outputFilePreview')}`
})
const formatLabel = computed(() => String(settings.defaultFormat || 'wav').toUpperCase())
const outputLayoutLabel = computed(() => effectiveOutputLayout.value === 'flat'
  ? t('separate.outputLayoutFlat')
  : t('separate.outputLayoutFolders'))
const outputSummaryPath = computed(() => shortenMiddle(outputPreview.value, 60))
const canStart = computed(() => (
  inputFiles.value.length > 0
  && (runMode.value === 'workflow' ? Boolean(selectedWorkflow.value) : modelDownloaded.value)
))
const newestRunningJob = computed(() => {
  return [...task.allJobs]
    .filter(job => job.tasks.some(item => !['done', 'failed', 'cancelled'].includes(item.status)))
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null
})
const focusedJob = computed(() => task.getJobById(focusedSeparationJobId.value))
const currentJob = computed(() => focusedJob.value || newestRunningJob.value)
const focusedBatchTasks = computed(() => currentJob.value?.tasks || [])
const activeFocusedBatchTask = computed(() => {
  return [...focusedBatchTasks.value]
    .filter(item => !['done', 'failed', 'cancelled'].includes(item.status))
    .sort((a, b) => {
      const aQueued = a.status === 'queued' ? 1 : 0
      const bQueued = b.status === 'queued' ? 1 : 0
      if (aQueued !== bQueued) return aQueued - bQueued
      return a.createdAt - b.createdAt
    })[0] || null
})
const currentTask = computed(() => {
  if (focusedBatchTasks.value.length) return activeFocusedBatchTask.value || focusedBatchTasks.value[0] || null
  return null
})
const currentBatchTasks = computed(() => focusedBatchTasks.value.length ? focusedBatchTasks.value : currentTask.value ? [currentTask.value] : [])
const currentBatchTotal = computed(() => currentBatchTasks.value.length)
const currentBatchDoneCount = computed(() => currentBatchTasks.value.filter(item => item.status === 'done').length)
const currentBatchFailedCount = computed(() => currentBatchTasks.value.filter(item => item.status === 'failed').length)
const currentBatchCancelledCount = computed(() => currentBatchTasks.value.filter(item => item.status === 'cancelled').length)
const currentBatchFinishedCount = computed(() => currentBatchDoneCount.value + currentBatchFailedCount.value + currentBatchCancelledCount.value)
const currentBatchIsMulti = computed(() => currentBatchTotal.value > 1)
const taskPanelState = computed<'ready' | 'running' | 'done' | 'failed' | 'cancelled'>(() => {
  const items = currentBatchTasks.value
  if (!items.length) return 'ready'
  if (items.some(item => !['done', 'failed', 'cancelled'].includes(item.status))) return 'running'
  if (items.every(item => item.status === 'done')) return 'done'
  if (items.every(item => item.status === 'cancelled')) return 'cancelled'
  if (items.every(item => item.status === 'failed')) return 'failed'
  if (items.some(item => item.status === 'done')) return 'done'
  if (items.some(item => item.status === 'failed')) return 'failed'
  if (items.some(item => item.status === 'cancelled')) return 'cancelled'
  return 'running'
})
const isConfigCompact = computed(() => taskPanelState.value !== 'ready')
const inputCompactLine = computed(() => {
  if (currentBatchIsMulti.value && currentBatchTotal.value) return t('separate.batchInputCompact', { count: currentBatchTotal.value })
  if (currentTask.value) return getFileName(currentTask.value.input)
  if (!inputFiles.value.length) return t('separate.noInputSelected')
  const first = getFileName(inputFiles.value[0])
  if (inputFiles.value.length === 1) return first
  return t('separate.inputCompactMultiple', { count: inputFiles.value.length, name: first })
})
const modelCompactLine = computed(() => {
  if (currentTask.value?.model) return currentTask.value.model
  if (runMode.value === 'workflow') return selectedWorkflow.value?.name || t('separate.noWorkflowSelected')
  const name = selectedModelName.value || t('separate.noModelSelected')
  const category = currentModelInfo.value ? categoryLabel(currentModelInfo.value) : ''
  return category ? `${name} · ${category}` : name
})
const currentTaskFileName = computed(() => currentTask.value ? getFileName(currentTask.value.input) : '')
const currentTaskOutputPath = computed(() => currentJob.value?.output || currentTask.value?.output || normalizedOutputDir.value)
const currentTaskOutputSummary = computed(() => shortenMiddle(currentTaskOutputPath.value, 72))
const currentTaskDuration = computed(() => currentTask.value ? taskDuration(currentTask.value) : '')
const currentBatchProgress = computed(() => {
  const items = currentBatchTasks.value
  if (!items.length) return 0
  const total = items.reduce((sum, item) => {
    if (item.status === 'done' || item.status === 'failed' || item.status === 'cancelled') return sum + 100
    if (item.status === 'queued') return sum
    return sum + Math.max(0, Math.min(99, Number(item.progress || 0)))
  }, 0)
  return Math.round(total / items.length)
})
const currentBatchActiveIndex = computed(() => {
  if (!currentBatchTotal.value) return 0
  if (taskPanelState.value !== 'running') return currentBatchFinishedCount.value
  return Math.min(currentBatchTotal.value, currentBatchFinishedCount.value + 1)
})
const currentBatchTitle = computed(() => {
  if (!currentBatchIsMulti.value) return t('separate.taskRunningTitle')
  if (taskPanelState.value === 'running') {
    return t('separate.batchRunningTitle', { current: currentBatchActiveIndex.value, total: currentBatchTotal.value })
  }
  if (taskPanelState.value === 'done') return t('separate.batchDoneTitle', { count: currentBatchDoneCount.value })
  return statusLabel(taskPanelState.value)
})
const currentBatchLine = computed(() => {
  if (!currentBatchIsMulti.value) return currentTaskFileName.value
  if (taskPanelState.value === 'running' && currentTask.value) {
    return t('separate.batchCurrentInput', { name: getFileName(currentTask.value.input) })
  }
  return t('separate.batchFinishedSummary', {
    done: currentBatchDoneCount.value,
    failed: currentBatchFailedCount.value,
    cancelled: currentBatchCancelledCount.value,
    total: currentBatchTotal.value,
  })
})
const currentBatchOutputSummary = computed(() => {
  if (!currentBatchIsMulti.value) return currentTaskOutputSummary.value
  return t('separate.batchResultSummary', { count: currentBatchDoneCount.value, total: currentBatchTotal.value })
})
const playableOutputGroups = computed(() => currentBatchTasks.value
  .filter(item => item.status === 'done' && item.outputs.some(output => Boolean(output.path)))
  .map(item => ({
    task: item,
    outputs: item.outputs.filter(output => Boolean(output.path)),
  })))
const playableOutputs = computed(() => playableOutputGroups.value.flatMap(group => group.outputs))

function getFileName(path: string) {
  return path.split(/[/\\]/).filter(Boolean).pop() || path
}

function categoryLabel(item: { categoryCn?: string; category?: string; primaryCategoryCn?: string; primaryCategory?: string } | null | undefined) {
  return getModelCategoryLabel(item, locale.value, t('common.notSet'))
}

function modelTargetLabel(item: {
  targetStem?: string
  configTargetInstrument?: string
} | null | undefined) {
  return item?.targetStem || item?.configTargetInstrument || t('common.notSet')
}

function modelArchitectureLabel(item: {
  architecture?: string
  modelType?: string | null
} | null | undefined) {
  return item?.architecture || item?.modelType || t('common.notSet')
}

function modelMetaLine(item: {
  targetStem?: string
  configTargetInstrument?: string
  architecture?: string
  modelType?: string | null
}) {
  return `${modelTargetLabel(item)} · ${modelArchitectureLabel(item)}`
}

function shortenMiddle(text: string, maxLength = 48) {
  if (text.length <= maxLength) return text
  const keep = Math.max(8, Math.floor((maxLength - 3) / 2))
  return `${text.slice(0, keep)}...${text.slice(-keep)}`
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    queued: t('tasks.statusQueued'),
    preparing: t('tasks.statusPreparing'),
    validating_input: t('tasks.statusValidatingInput'),
    downloading_model: t('tasks.statusCheckingModel'),
    ensuring_model: t('tasks.statusCheckingModel'),
    loading_model: t('tasks.statusLoadingModel'),
    separating: t('tasks.statusSeparating'),
    writing_output: t('tasks.statusWritingOutput'),
    done: t('tasks.statusDone'),
    failed: t('tasks.statusFailed'),
    cancelled: t('tasks.statusCancelled'),
  }
  return labels[status] || status
}

function statusType(status: string) {
  switch (status) {
    case 'done': return 'success' as const
    case 'failed': return 'error' as const
    case 'cancelled': return 'warning' as const
    default: return 'info' as const
  }
}

function normalizeProgressMessage(value?: string) {
  const message = (value || '').trim()
  const key = message.toLowerCase()
  const mapped: Record<string, string> = {
    'task started': t('tasks.progressPreparingTask'),
    'validating input': t('tasks.progressValidatingInput'),
    'checking model files': t('tasks.progressCheckingModel'),
    'loading model': t('tasks.progressLoadingModel'),
    'separating audio': t('tasks.progressSeparatingHint'),
    'processing audio chunks': t('tasks.progressProcessingChunks'),
    'processing vr batches': t('tasks.progressProcessingVrBatches'),
    'collecting outputs': t('tasks.progressCollectingOutputs'),
  }
  return mapped[key] || message
}

function progressStatus(status: string) {
  switch (status) {
    case 'done': return 'success' as const
    case 'failed': return 'error' as const
    case 'cancelled': return 'warning' as const
    default: return 'info' as const
  }
}

function progressTitle(item: SeparationTask) {
  if (item.status === 'separating') return t('tasks.progressTitleSeparating')
  return statusLabel(item.status)
}

function progressDetail(item: SeparationTask) {
  if (
    item.status === 'separating'
    && typeof item.progressCurrent === 'number'
    && typeof item.progressTotal === 'number'
    && item.progressTotal > 0
  ) {
    return `${Math.round(item.progressCurrent)} / ${Math.round(item.progressTotal)}`
  }
  return ''
}

function taskSubMessage(item: SeparationTask) {
  if (item.error) return item.error
  return normalizeProgressMessage(item.progressDetail || item.message)
}

function taskDuration(item: SeparationTask) {
  const seconds = Math.max(0, Math.round((item.updatedAt - item.createdAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}m ${rest}s`
}

function formatPlaybackTime(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '00:00'
  const total = Math.floor(value)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function getOutputPlayback(path: string) {
  return outputPlayback.value[path] || { currentTime: 0, duration: 0 }
}

function setOutputPlayback(path: string, patch: Partial<{ currentTime: number; duration: number }>) {
  const previous = getOutputPlayback(path)
  outputPlayback.value = {
    ...outputPlayback.value,
    [path]: { ...previous, ...patch },
  }
}

function getAudio(path: string) {
  const cached = audioElements.get(path)
  if (cached) return cached
  const audio = new Audio(convertFileSrc(path))
  audio.preload = 'metadata'
  audio.addEventListener('loadedmetadata', () => {
    setOutputPlayback(path, { duration: audio.duration || 0 })
  })
  audio.addEventListener('timeupdate', () => {
    setOutputPlayback(path, { currentTime: audio.currentTime || 0, duration: audio.duration || 0 })
  })
  audio.addEventListener('ended', () => {
    if (playingOutputPath.value === path) playingOutputPath.value = ''
    setOutputPlayback(path, { currentTime: 0, duration: audio.duration || 0 })
  })
  audio.addEventListener('error', () => {
    if (playingOutputPath.value === path) playingOutputPath.value = ''
  })
  audioElements.set(path, audio)
  return audio
}

async function toggleOutputPlayback(output: StemOutput) {
  if (!output.path) return
  const audio = getAudio(output.path)
  if (playingOutputPath.value === output.path && !audio.paused) {
    audio.pause()
    playingOutputPath.value = ''
    return
  }
  audioElements.forEach((item, path) => {
    if (path !== output.path) item.pause()
  })
  try {
    await audio.play()
    playingOutputPath.value = output.path
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('separate.previewPlayFailed'))
  }
}

function seekOutput(path: string, value: number) {
  const audio = getAudio(path)
  const next = Number(value || 0)
  audio.currentTime = next
  setOutputPlayback(path, { currentTime: next, duration: audio.duration || getOutputPlayback(path).duration })
}

function stopAllPreviewAudio() {
  audioElements.forEach((audio) => {
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
  })
  audioElements.clear()
  playingOutputPath.value = ''
}

function handleSelectModel(item: (typeof listedDownloadedModels.value)[number]) {
  model.selectModel(item).catch(() => {})
}

function prefetchSelectedModelAdvancedParams() {
  if (runMode.value !== 'model') return
  if (!shouldPrefetchAdvancedParams.value || detailLoading.value || isLoading.value || !selectedModelName.value) return
  model.selectModel(selectedModelName.value).catch(() => {})
}

watch(selectedModelName, () => {
  selectedStems.value = []
})

watch(
  canChooseOutputLayout,
  (canChoose) => {
    if (!canChoose) outputLayout.value = 'folders'
  },
  { immediate: true },
)

watch(
  availableStemNames,
  (stems) => {
    if (!selectedStems.value.length) return
    const allowed = new Set(stems)
    selectedStems.value = selectedStems.value.filter(stem => allowed.has(stem))
  },
  { immediate: true },
)

watch(
  currentModelInfo,
  (info) => {
    if (!info || info.name !== selectedModelName.value) return
    task.applySelectedModelDefaults(info.defaultInferenceParams, info.modelType)
  },
  { immediate: true },
)

watch(
  shouldPrefetchAdvancedParams,
  (shouldPrefetch) => {
    if (!shouldPrefetch) return
    prefetchSelectedModelAdvancedParams()
  },
  { immediate: true },
)

watch(
  [listedDownloadedModels, selectedModel, isLoading],
  ([list, current, loading]) => {
    if (loading) return
    if (!list.length) return
    const valid = current && list.some((item) => item.name === current)
    if (!valid) {
      selectedModel.value = list[0].name
      model.selectModel(list[0]).catch(() => {})
    }
  },
  { immediate: true },
)
watch(
  [workflows, selectedWorkflowId],
  ([list, current]) => {
    if (!list.length) return
    if (!current || !list.some(item => item.id === current)) {
      workflow.selectWorkflow(list[0].id)
    }
  },
  { immediate: true },
)

onMounted(async () => {
  if (!app.envInfo && !app.envLoading) {
    app.checkEnvInBackground().catch(() => {})
  }
  try {
    unlistenDragDrop = await getCurrentWebview().onDragDropEvent(async (event) => {
      const type = event.payload.type
      if (type === 'over' || type === 'enter') {
        isDragging.value = true
      } else if (type === 'drop') {
        isDragging.value = false
        const paths = (event.payload as { paths?: string[] }).paths || []
        const added = await task.addPaths(paths)
        if (added > 0) message.success(t('separate.addedFiles', { count: added }))
        else message.warning(t('separate.noAudioAdded'))
      } else {
        isDragging.value = false
      }
    })
  } catch {
    // 非 Tauri 环境静默降级
  }
})

onBeforeUnmount(() => {
  if (unlistenDragDrop) unlistenDragDrop()
  stopAllPreviewAudio()
})

async function handlePickFiles() {
  const before = inputFiles.value.length
  await task.pickFiles()
  const added = inputFiles.value.length - before
  if (added > 0) message.success(t('separate.addedFiles', { count: added }))
}

async function handlePickFolder() {
  const count = await task.pickInputFolder()
  if (count > 0) message.success(t('separate.folderScanned', { count }))
  else message.warning(t('separate.folderEmpty'))
}

async function pickTemporaryOutputDir() {
  const folder = await settings.pickFolder()
  if (folder) temporaryOutputDir.value = folder
}

async function start() {
  if (!inputFiles.value.length) {
    message.warning(t('separate.startHintNoInput'))
    return
  }
  if (runMode.value === 'workflow' && !selectedWorkflow.value) {
    message.warning(t('separate.startHintNoWorkflow'))
    return
  }
  if (runMode.value === 'model' && !modelDownloaded.value) {
    message.warning(t('separate.startHintModelMissing'))
    return
  }
  try {
    const result = runMode.value === 'workflow' && selectedWorkflow.value
      ? await task.startWorkflowInference(selectedWorkflow.value, { outputDir: normalizedOutputDir.value, outputLayout: effectiveOutputLayout.value })
      : await task.startSeparation({ outputDir: normalizedOutputDir.value, outputLayout: effectiveOutputLayout.value })
    focusedSeparationJobId.value = result?.jobId || newestRunningJob.value?.id || focusedSeparationJobId.value
    task.clearInputFiles()
    if (result && result.failed > 0) {
      message.warning(t('separate.batchPartial', { succeeded: result.succeeded, failed: result.failed }))
    } else {
      message.success(t('separate.batchStarted', { count: result?.succeeded ?? 1 }))
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : t('toast.taskFailed'))
  }
}

function resetForNextSeparation() {
  stopAllPreviewAudio()
  showLogModal.value = false
  focusedSeparationJobId.value = null
}

function openCurrentLogs() {
  if (!currentTask.value) return
  showLogModal.value = true
}

function handleCancelCurrentTask() {
  const targets = currentBatchTasks.value.filter(item => !['done', 'failed', 'cancelled'].includes(item.status))
  if (!targets.length) return
  dialog.warning({
    title: t('tasks.cancelConfirmTitle'),
    content: t('tasks.cancelConfirmContent'),
    positiveText: t('tasks.cancelAction'),
    negativeText: t('common.cancel'),
    positiveButtonProps: { type: 'error' },
    negativeButtonProps: { secondary: true },
    onPositiveClick: async () => {
      if (cancellingTaskId.value) return
      cancellingTaskId.value = targets.length > 1 ? 'batch' : targets[0].id
      try {
        const results = await Promise.all(targets.map(item => task.cancelTask(item.id)))
        if (results.some(Boolean)) message.success(t('tasks.cancelSuccess'))
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error))
      } finally {
        cancellingTaskId.value = null
      }
    },
  })
}

async function retryCurrentTask() {
  const item = currentTask.value
  if (!item) return
  try {
    const next = await task.retryTask(item.id)
    focusedSeparationJobId.value = next?.jobId || next?.id || focusedSeparationJobId.value
    message.success(t('toast.taskRetried'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}
</script>

<template>
  <div class="page separate-page">
    <div class="page-header-compact separate-header">
      <div class="separate-header__brand">
        <AppBrandMark :size="38" variant="compact" shadow />
        <div>
          <h1>Pymss-Studio</h1>
        </div>
      </div>
    </div>

    <div class="workspace-grid" :class="{ 'workspace-grid--compact': isConfigCompact }">
      <section class="config-panel config-panel--input">
        <div class="panel-heading">
          <div class="panel-heading__icon"><n-icon :component="MusicalNotesOutline" /></div>
          <div>
            <h2>{{ t('separate.input') }}</h2>
            <p :title="isConfigCompact ? inputCompactLine : t('separate.inputPanelHint')">
              {{ isConfigCompact ? inputCompactLine : t('separate.inputPanelHint') }}
            </p>
          </div>
        </div>
        <n-collapse-transition :show="!isConfigCompact">
          <div class="config-rollup-content config-rollup-content--input">
            <div class="button-row">
              <n-button secondary @click="handlePickFiles">
                <template #icon><n-icon :component="MusicalNotesOutline" /></template>
                {{ t('separate.chooseFiles') }}
              </n-button>
              <n-button secondary @click="handlePickFolder">
                <template #icon><n-icon :component="FolderOutline" /></template>
                {{ t('separate.chooseFolder') }}
              </n-button>
            </div>

            <div class="candidate" :class="{ 'candidate--dragging': isDragging }">
              <div class="candidate__head">
                <strong>{{ t('separate.candidateTitle') }}</strong>
                <span>{{ t('separate.candidateCount', { count: inputFiles.length }) }}</span>
                <n-button
                  v-if="inputFiles.length"
                  text
                  size="small"
                  type="error"
                  @click="task.clearInputFiles()"
                >
                  {{ t('separate.clearAll') }}
                </n-button>
              </div>

              <div v-if="inputFiles.length" class="candidate__list">
                <div v-for="path in inputFiles" :key="path" class="candidate__item">
                  <n-icon :component="MusicalNotesOutline" class="candidate__item-icon" />
                  <div class="candidate__item-main">
                    <strong :title="getFileName(path)">{{ getFileName(path) }}</strong>
                    <span class="candidate__item-kind">{{ getFileKindLabel(path) }}</span>
                    <code :title="path">{{ shortenMiddle(path, 56) }}</code>
                  </div>
                  <n-button quaternary circle size="tiny" :title="t('separate.remove')" @click="task.removeInputFile(path)">
                    <template #icon><n-icon :component="CloseOutline" /></template>
                  </n-button>
                </div>
              </div>

              <div v-else class="candidate__empty">
                <div class="candidate__empty-icon"><n-icon :component="CloudUploadOutline" /></div>
                <span>{{ isDragging ? t('separate.dropHere') : t('separate.candidateEmpty') }}</span>
              </div>
            </div>
          </div>
        </n-collapse-transition>
      </section>

      <section class="config-panel config-panel--model" :class="{ 'config-panel--workflow': runMode === 'workflow' }">
        <div class="panel-heading">
          <div class="panel-heading__icon"><n-icon :component="runMode === 'workflow' ? GitNetworkOutline : CubeOutline" /></div>
          <div class="panel-heading__main">
            <h2>{{ t('separate.runTarget') }}</h2>
            <p :title="isConfigCompact ? modelCompactLine : (runMode === 'workflow' ? t('separate.workflowPanelHint') : t('separate.modelPanelHint'))">
              {{ isConfigCompact ? modelCompactLine : (runMode === 'workflow' ? t('separate.workflowPanelHint') : t('separate.modelPanelHint')) }}
            </p>
          </div>
          <n-button text class="panel-heading__action" @click="router.push(runMode === 'workflow' ? '/workflows' : '/models')">
            {{ runMode === 'workflow' ? t('separate.manageWorkflowsInline') : t('separate.manageModelsInline') }}
          </n-button>
        </div>
        <n-collapse-transition :show="!isConfigCompact">
          <div class="config-rollup-content config-rollup-content--model">
            <div class="model-panel__body">
              <n-radio-group v-model:value="runMode" class="run-mode-toggle">
                <n-radio-button
                  v-for="option in runModeOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </n-radio-button>
              </n-radio-group>
              <transition name="run-mode-content" mode="out-in">
                <div v-if="runMode === 'model'" key="model" class="run-mode-content">
                  <div v-if="downloadedModels.length" class="model-picker">
                <div class="model-picker__toolbar">
                  <n-input
                    v-model:value="modelSearch"
                    clearable
                    :placeholder="t('separate.modelSearchPlaceholder')"
                  >
                    <template #prefix>
                      <n-icon :component="SearchOutline" />
                    </template>
                  </n-input>
                  <n-select
                    class="model-picker__category-select"
                    v-model:value="modelCategoryFilter"
                    :menu-props="{ class: 'model-picker__category-menu' }"
                    :options="modelCategoryOptions"
                  />
                </div>

                <div class="model-picker__divider" />

                <div v-if="filteredDownloadedModels.length" class="model-picker__list" role="listbox" :aria-label="t('separate.model')">
                  <button
                    v-for="item in filteredDownloadedModels"
                    :key="item.name"
                    type="button"
                    role="option"
                    :aria-selected="selectedModelName === item.name"
                    class="model-picker__item"
                    :class="{ 'model-picker__item--active': selectedModelName === item.name }"
                    @click="handleSelectModel(item)"
                  >
                    <div class="model-picker__item-main">
                      <div class="model-picker__item-title">
                        <strong :title="item.name">{{ item.name }}</strong>
                        <span class="model-picker__item-tag" :title="categoryLabel(item)">{{ categoryLabel(item) }}</span>
                      </div>
                      <div class="model-picker__item-sub" :title="modelMetaLine(item)">
                        {{ modelMetaLine(item) }}
                      </div>
                    </div>
                    <n-icon v-if="selectedModelName === item.name" class="model-picker__item-check" :component="CheckmarkCircle" />
                  </button>
                </div>
                <div v-else class="model-picker__empty">
                  {{ t('separate.modelSearchEmpty') }}
                </div>
              </div>
              <div v-if="selectedModelName && !modelDownloaded" class="model-info-card model-info-card--warn">
                {{ t('separate.startHintModelMissing') }}
              </div>
              <div v-else-if="!downloadedModels.length" class="model-panel__empty-state" :class="{ 'model-panel__empty-state--loading': isLoading }">
                <div class="model-panel__empty-visual">
                  <n-spin v-if="isLoading" size="large" />
                  <n-icon v-else :component="CubeOutline" />
                </div>
                <div class="model-panel__empty-main">
                  <strong>{{ isLoading ? t('separate.modelPanelLoadingTitle') : t('separate.modelPanelEmptyTitle') }}</strong>
                  <p>{{ isLoading ? t('separate.modelPanelLoadingDesc') : t('separate.modelPanelEmptyDesc') }}</p>
                </div>
                <div class="model-panel__empty-actions">
                  <n-button secondary :loading="isLoading" @click="model.loadModels()">
                    {{ t('separate.modelPanelPrimaryAction') }}
                  </n-button>
                </div>
              </div>
                </div>
                <div v-else key="workflow" class="run-mode-content">
                  <div class="model-picker model-picker--workflow">
                <div class="model-picker__toolbar">
                  <n-input
                    v-model:value="workflowSearch"
                    clearable
                    :placeholder="t('separate.workflowSearchPlaceholder')"
                  >
                    <template #prefix>
                      <n-icon :component="SearchOutline" />
                    </template>
                  </n-input>
                </div>
                <div class="model-picker__divider" />
                <div v-if="filteredWorkflows.length" class="model-picker__list" role="listbox" :aria-label="t('separate.workflow')">
                  <button
                    v-for="item in filteredWorkflows"
                    :key="item.id"
                    type="button"
                    role="option"
                    :aria-selected="selectedWorkflowId === item.id"
                    class="model-picker__item"
                    :class="{ 'model-picker__item--active': selectedWorkflowId === item.id }"
                    @click="workflow.selectWorkflow(item.id)"
                  >
                    <div class="model-picker__item-main">
                      <div class="model-picker__item-title">
                        <strong :title="item.name">{{ item.name }}</strong>
                        <span class="model-picker__item-tag">{{ t('separate.workflow') }}</span>
                      </div>
                      <div class="model-picker__item-sub" :title="item.description">
                        {{ item.description || t('separate.workflowNoDescription') }}
                      </div>
                    </div>
                    <n-icon v-if="selectedWorkflowId === item.id" class="model-picker__item-check" :component="CheckmarkCircle" />
                  </button>
                </div>
                <div v-else class="model-panel__empty-state">
                  <div class="model-panel__empty-visual">
                    <n-icon :component="GitNetworkOutline" />
                  </div>
                  <div class="model-panel__empty-main">
                    <strong>{{ t('separate.workflowEmptyTitle') }}</strong>
                    <p>{{ t('separate.workflowEmptyDesc') }}</p>
                  </div>
                  <div class="model-panel__empty-actions">
                    <n-button secondary @click="router.push('/workflows')">
                      {{ t('separate.workflowCreateAction') }}
                    </n-button>
                  </div>
                </div>
              </div>
                </div>
              </transition>
            </div>
          </div>
        </n-collapse-transition>
      </section>
    </div>

    <section
      v-if="currentBatchTasks.length && currentTask && taskPanelState !== 'ready'"
      class="separation-task-panel"
      :class="`separation-task-panel--${taskPanelState}`"
    >
      <template v-if="taskPanelState === 'running'">
        <div class="task-running-head">
          <div>
            <strong>{{ currentBatchTitle }}</strong>
            <span>{{ currentBatchLine }}</span>
          </div>
          <n-tag :bordered="false" :type="statusType(currentTask.status)">{{ statusLabel(currentTask.status) }}</n-tag>
        </div>
        <div class="task-progress-block">
          <div class="task-progress-head">
            <span>
              {{ currentBatchIsMulti ? t('separate.batchOverallProgress') : progressTitle(currentTask) }}
              <template v-if="!currentBatchIsMulti && progressDetail(currentTask)"> · {{ progressDetail(currentTask) }}</template>
            </span>
            <strong>{{ currentBatchProgress }}%</strong>
          </div>
          <n-progress
            type="line"
            :percentage="currentBatchProgress"
            :status="progressStatus(currentTask.status)"
            processing
            :height="9"
            :show-indicator="false"
          />
          <p v-if="taskSubMessage(currentTask)" class="task-panel-message">{{ taskSubMessage(currentTask) }}</p>
        </div>
        <div class="task-panel-meta">
          <span><n-icon :component="TimeOutline" /> {{ currentTaskDuration }}</span>
          <span :title="currentTaskOutputPath">{{ t('separate.outputTo') }} {{ currentTaskOutputSummary }}</span>
        </div>
        <div class="task-panel-actions">
          <n-button secondary :disabled="!currentTask.logs.length" @click="openCurrentLogs">
            <template #icon><n-icon :component="TerminalOutline" /></template>
            {{ t('tasks.logs') }}
          </n-button>
          <n-button
            secondary
            type="error"
            :loading="cancellingTaskId === currentTask.id || cancellingTaskId === 'batch'"
            :disabled="cancellingTaskId === currentTask.id || cancellingTaskId === 'batch'"
            @click="handleCancelCurrentTask"
          >
            {{ t('tasks.cancelAction') }}
          </n-button>
        </div>
      </template>
      <template v-else-if="currentTask">
        <div class="task-done-main">
          <div>
            <strong>{{ currentBatchIsMulti ? currentBatchTitle : statusLabel(currentTask.status) }}</strong>
            <span>
              {{ currentBatchLine }}
              <template v-if="taskPanelState === 'done' && !currentBatchIsMulti"> · {{ currentTask.outputs.length }} {{ t('separate.previewStemUnit') }} · {{ currentTaskDuration }}</template>
            </span>
            <code v-if="taskPanelState === 'done'" :title="currentTaskOutputPath">{{ currentBatchOutputSummary }}</code>
            <small v-else-if="taskSubMessage(currentTask)">{{ taskSubMessage(currentTask) }}</small>
          </div>
        </div>
        <div class="task-panel-actions">
          <n-button v-if="taskPanelState === 'done'" secondary @click="task.revealPath(currentJob?.output || currentTask.output)">
            <template #icon><n-icon :component="OpenOutline" /></template>
            {{ t('separate.openOutput') }}
          </n-button>
          <n-button v-if="currentTask.logs.length" secondary @click="openCurrentLogs">
            <template #icon><n-icon :component="TerminalOutline" /></template>
            {{ t('tasks.logs') }}
          </n-button>
          <n-button type="primary" secondary @click="retryCurrentTask">
            <template #icon><n-icon :component="PlayOutline" /></template>
            {{ t('common.retry') }}
          </n-button>
          <n-button v-if="taskPanelState === 'done'" type="primary" @click="resetForNextSeparation">
            {{ t('separate.newSeparation') }}
          </n-button>
        </div>
      </template>
    </section>

    <transition name="result-preview" appear>
      <section v-if="taskPanelState === 'done' && playableOutputGroups.length" class="result-preview-panel">
        <div class="result-preview-panel__head">
          <strong>{{ t('separate.previewTitle') }}</strong>
          <span>{{ playableOutputGroups.length }} {{ t('separate.previewResultUnit') }} · {{ playableOutputs.length }} {{ t('separate.previewStemUnit') }}</span>
        </div>
        <div class="preview-result-list">
          <section v-for="group in playableOutputGroups" :key="group.task.id" class="preview-result-card">
            <div class="preview-result-card__head">
              <strong>{{ getFileName(group.task.input) }}</strong>
              <span>{{ group.outputs.length }} {{ t('separate.previewStemUnit') }}</span>
            </div>
            <div class="preview-track-list">
              <div v-for="output in group.outputs" :key="output.path" class="preview-track">
                <div class="preview-track__title">
                  <strong>{{ output.stem }}</strong>
                  <small :title="output.path">{{ shortenMiddle(output.path, 68) }}</small>
                </div>
                <n-button circle secondary size="small" @click="toggleOutputPlayback(output)">
                  <template #icon>
                    <n-icon :component="playingOutputPath === output.path ? PauseOutline : PlayOutline" />
                  </template>
                </n-button>
                <n-slider
                  class="preview-track__slider"
                  :value="getOutputPlayback(output.path).currentTime"
                  :min="0"
                  :max="Math.max(getOutputPlayback(output.path).duration, 1)"
                  :step="0.1"
                  :tooltip="false"
                  @update:value="(value: number) => seekOutput(output.path, value)"
                />
                <span class="preview-track__time">
                  {{ formatPlaybackTime(getOutputPlayback(output.path).currentTime) }} / {{ formatPlaybackTime(getOutputPlayback(output.path).duration) }}
                </span>
              </div>
            </div>
          </section>
        </div>
      </section>
    </transition>

    <section class="summary-bar">
      <div class="summary-bar__content">
        <div class="summary-bar__topline">
          <div class="summary-bar__heading">
            <span class="summary-bar__heading-icon">
              <n-icon :component="OptionsOutline" />
            </span>
            <div>
              <strong>{{ t('separate.outputSummaryTitle') }}</strong>
              <span>{{ t('separate.outputSummaryHint') }}</span>
            </div>
          </div>
        </div>
        <div class="summary-bar__body">
          <div class="summary-bar__options">
            <div class="summary-config-grid" :class="{ 'summary-config-grid--batch': canChooseOutputLayout }">
              <div class="field-block field-block--wide">
                <label>{{ t('separate.temporaryOutputDir') }}</label>
                <n-input-group>
                  <n-input v-model:value="temporaryOutputDir" :placeholder="settings.outputDir || t('separate.outputDefault')" clearable />
                  <n-button secondary @click="pickTemporaryOutputDir">{{ t('separate.chooseOutput') }}</n-button>
                </n-input-group>
              </div>
              <div class="field-block">
                <label>{{ t('settings.defaultFormat') }}</label>
                <n-select v-model:value="settings.defaultFormat" :options="formatOptions" />
              </div>
              <div v-if="canChooseOutputLayout" class="field-block">
                <label>{{ t('separate.outputLayout') }}</label>
                <n-select v-model:value="outputLayout" :options="outputLayoutOptions" />
              </div>
              <n-button class="summary-bar__advanced" secondary @click="showSettingsDrawer = true">
                <template #icon><n-icon :component="SettingsOutline" /></template>
                {{ t('separate.configParams') }}
              </n-button>
            </div>
          </div>

          <transition name="summary-stems">
            <div v-if="runMode === 'model'" class="summary-stems-shell">
              <div class="summary-stems-row">
                <div class="summary-stems-row__head">
                  <label>{{ t('separate.outputStems') }}</label>
                </div>
                <div v-if="availableStemNames.length" class="stem-toggle-list">
                  <n-checkbox-group v-model:value="checkedOutputStems">
                    <n-checkbox
                      v-for="stem in availableStemNames"
                      :key="stem"
                      :value="stem"
                      :label="stem"
                    />
                  </n-checkbox-group>
                </div>
                <div v-else class="stem-toggle-empty">{{ t('separate.allStems') }}</div>
              </div>
            </div>
          </transition>
        </div>
        <div class="summary-bar__execution">
          <div class="summary-bar__output-line" :title="outputPreview">
            <span class="summary-bar__path">{{ outputSummaryPath }}</span>
            <div class="summary-bar__details">
              <span>{{ t('separate.currentFormat') }} · {{ formatLabel }}</span>
              <span>{{ t('separate.outputLayout') }} · {{ outputLayoutLabel }}</span>
              <span>{{ t('separate.outputStems') }} · {{ selectedStemDetail }}</span>
            </div>
          </div>
          <div class="summary-bar__footer">
            <div class="summary-bar__status">
              <div class="summary-bar__ready" :class="{ 'summary-bar__ready--disabled': !canStart }">
                <n-icon :component="CheckmarkCircle" />
                <strong>{{ startStatusText }}</strong>
              </div>
            </div>
            <div class="summary-bar__actions">
              <n-button secondary size="large" @click="task.revealPath(normalizedOutputDir)">
                <template #icon><n-icon :component="OpenOutline" /></template>
                {{ t('separate.openOutput') }}
              </n-button>
              <n-button type="primary" size="large" :disabled="!canStart" @click="start">
                <template #icon><n-icon :component="PlayOutline" /></template>
                {{ t('separate.startTask') }}
              </n-button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <n-modal v-model:show="showSettingsDrawer">
      <n-card
        class="settings-modal"
        :title="t('separate.settingsDrawerTitle')"
        :bordered="false"
        closable
        role="dialog"
        aria-modal="true"
        @close="showSettingsDrawer = false"
      >
        <div class="settings-drawer__content">
          <div class="settings-group">
            <div class="settings-group__head">
              <strong>{{ t('separate.runOptionsTitle') }}</strong>
              <span>{{ t('separate.runOptionsHint') }}</span>
            </div>
            <div class="check-list">
              <n-checkbox v-model:checked="useTta">{{ t('separate.tta') }}</n-checkbox>
              <n-checkbox v-model:checked="debug">{{ t('separate.debug') }}</n-checkbox>
            </div>
          </div>

          <div class="settings-group">
            <div class="settings-group__head">
              <strong>{{ t('separate.audioQualityTitle') }} · {{ formatLabel }}</strong>
              <span>{{ t('separate.audioQualityEditable') }}</span>
            </div>
            <n-grid :cols="2" :x-gap="16" :y-gap="16" responsive="screen">
              <n-grid-item v-if="settings.defaultFormat === 'wav'">
                <div class="field-block">
                  <label>{{ t('audio.wavBitDepth') }}</label>
                  <n-select v-model:value="settings.wavBitDepth" :options="wavBitDepthOptions" />
                </div>
              </n-grid-item>
              <n-grid-item v-if="settings.defaultFormat === 'flac'">
                <div class="field-block">
                  <label>{{ t('audio.flacBitDepth') }}</label>
                  <n-select v-model:value="settings.flacBitDepth" :options="flacBitDepthOptions" />
                </div>
              </n-grid-item>
              <n-grid-item v-if="settings.defaultFormat === 'mp3'">
                <div class="field-block">
                  <label>{{ t('audio.mp3BitRate') }}</label>
                  <n-select v-model:value="settings.mp3BitRate" :options="bitRateOptions" />
                </div>
              </n-grid-item>
              <n-grid-item v-if="settings.defaultFormat === 'm4a'">
                <div class="field-block">
                  <label>{{ t('audio.m4aBitRate') }}</label>
                  <n-select v-model:value="settings.m4aBitRate" :options="bitRateOptions" />
                </div>
              </n-grid-item>
              <n-grid-item v-if="settings.defaultFormat === 'm4a'">
                <div class="field-block">
                  <label>{{ t('audio.m4aCodec') }}</label>
                  <n-select v-model:value="settings.m4aCodec" :options="m4aCodecOptions" />
                </div>
              </n-grid-item>
            </n-grid>
          </div>

          <div class="settings-group">
            <n-collapse :default-expanded-names="[]">
              <n-collapse-item :title="t('inference.advancedParams')" name="inference">
                <p class="advanced-hint">{{ t('separate.advancedPanelHint') }}</p>
                <div v-if="advancedParamsLoading" class="advanced-loading">
                  <n-spin size="small" />
                  <span>{{ t('separate.advancedPanelLoading') }}</span>
                </div>
                <n-grid v-if="runMode === 'model'" :cols="2" :x-gap="16" :y-gap="16" responsive="screen">
                  <n-grid-item v-if="hasInferenceField('batch_size')">
                    <div class="field-block">
                      <label>{{ t('inference.batchSize') }}</label>
                      <n-input-number v-model:value="batch_size" :min="0" :max="32" style="width:100%" @blur="task.restoreInferenceNumberFallback('batch_size')" />
                    </div>
                  </n-grid-item>
                  <n-grid-item v-if="hasInferenceField('overlap_size')">
                    <div class="field-block">
                      <label>{{ t('inference.overlapSize') }}</label>
                      <n-input-number v-model:value="overlap_size" :min="0" :max="1048576" style="width:100%" @blur="task.restoreInferenceNumberFallback('overlap_size')" />
                    </div>
                  </n-grid-item>
                  <n-grid-item v-if="hasInferenceField('num_overlap')">
                    <div class="field-block">
                      <label>{{ t('inference.numOverlap') }}</label>
                      <n-input-number v-model:value="num_overlap" :min="0" :max="128" style="width:100%" @blur="task.restoreInferenceNumberFallback('num_overlap')" />
                    </div>
                  </n-grid-item>
                  <n-grid-item v-if="hasInferenceField('chunk_size')">
                    <div class="field-block">
                      <label>{{ t('inference.chunkSize') }}</label>
                      <n-input-number v-model:value="chunk_size" :min="0" :max="1048576" :step="1024" style="width:100%" @blur="task.restoreInferenceNumberFallback('chunk_size')" />
                    </div>
                  </n-grid-item>
                  <n-grid-item v-if="hasInferenceField('window_size')">
                    <div class="field-block">
                      <label>{{ t('inference.vrWindowSize') }}</label>
                      <n-input-number v-model:value="window_size" :min="0" :max="4096" style="width:100%" @blur="task.restoreInferenceNumberFallback('window_size')" />
                    </div>
                  </n-grid-item>
                  <n-grid-item v-if="hasInferenceField('aggression')">
                    <div class="field-block">
                      <label>{{ t('inference.vrAggression') }}</label>
                      <n-input-number v-model:value="aggression" :min="0" :max="100" style="width:100%" />
                    </div>
                  </n-grid-item>
                  <n-grid-item v-if="hasInferenceField('post_process_threshold')">
                    <div class="field-block">
                      <label>{{ t('inference.vrPostProcessThreshold') }}</label>
                      <n-input-number v-model:value="post_process_threshold" :min="0" :max="1" :step="0.05" style="width:100%" />
                    </div>
                  </n-grid-item>
                </n-grid>
                <div class="check-list check-list--spaced">
                  <n-checkbox v-if="runMode === 'workflow' || showStandardizeField" v-model:checked="standardize">{{ t('inference.standardize') }}</n-checkbox>
                  <n-checkbox v-if="runMode === 'workflow' || showNormalizeField" v-model:checked="normalize">{{ t('inference.normalize') }}</n-checkbox>
                  <n-checkbox v-if="runMode === 'model' && hasInferenceField('enable_post_process')" v-model:checked="enable_post_process">{{ t('inference.vrEnablePostProcess') }}</n-checkbox>
                  <n-checkbox v-if="runMode === 'model' && hasInferenceField('high_end_process')" v-model:checked="high_end_process">{{ t('inference.vrHighEndProcess') }}</n-checkbox>
                </div>
                <p v-if="runMode === 'model' && !advancedParamsLoading && !hasVisibleAdvancedFields" class="advanced-empty">
                  {{ t('separate.advancedPanelEmpty') }}
                </p>
              </n-collapse-item>
            </n-collapse>
          </div>
        </div>

        <template #footer>
          <div class="drawer-footer">
            <n-button type="primary" @click="showSettingsDrawer = false">{{ t('common.close') }}</n-button>
          </div>
        </template>
      </n-card>
    </n-modal>
    <n-modal v-model:show="showLogModal" style="width:min(900px, 92vw)">
      <n-card
        :title="currentTask ? `${currentTaskFileName} - ${t('tasks.logs')}` : t('tasks.logs')"
        :bordered="false"
        size="small"
        role="dialog"
        aria-modal="true"
      >
        <div v-if="currentTask?.logs.length" class="log-console">
          <div v-for="(line, index) in currentTask.logs" :key="`${index}-${line}`" class="log-line">
            <span class="log-line-number">{{ String(index + 1).padStart(3, '0') }}</span>
            <span class="log-line-text">{{ line }}</span>
          </div>
        </div>
        <div v-else class="log-empty">{{ t('tasks.noLogs') }}</div>
      </n-card>
    </n-modal>
  </div>
</template>

<style scoped>
.separate-page {
  position: relative;
  display: grid;
  gap: 14px;
  min-height: 0;
}

.separate-header {
  margin-bottom: 2px;
}

.separate-header__brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.separate-header__brand :deep(.app-brand-mark) {
  transform-origin: center center;
  will-change: transform, filter;
}

.separate-header__brand:hover :deep(.app-brand-mark) {
  animation: separate-brand-jelly 780ms cubic-bezier(0.22, 1, 0.36, 1);
}

.separate-header__brand:hover :deep(.app-brand-mark__image) {
  filter:
    drop-shadow(0 1px 1px rgba(255,255,255,0.08))
    drop-shadow(0 10px 20px rgba(98, 126, 255, 0.18));
}

@keyframes separate-brand-jelly {
  0% {
    transform: translateY(0) scale3d(1, 1, 1);
  }
  18% {
    transform: translateY(-1px) scale3d(1.12, 0.9, 1);
  }
  34% {
    transform: translateY(0) scale3d(0.92, 1.08, 1);
  }
  50% {
    transform: translateY(-0.5px) scale3d(1.04, 0.96, 1);
  }
  66% {
    transform: translateY(0) scale3d(0.985, 1.02, 1);
  }
  82% {
    transform: translateY(0) scale3d(1.01, 0.995, 1);
  }
  100% {
    transform: translateY(0) scale3d(1, 1, 1);
  }
}

.separate-header h1 {
  font-size: 24px;
  letter-spacing: -0.035em;
}

.separate-page :deep(.n-button) {
  letter-spacing: -0.01em;
}

.separate-page :deep(.n-button:not(.n-button--text-type)) {
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.05);
}

.separate-page :deep(.n-button--primary-type) {
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.18),
    0 12px 28px color-mix(in srgb, var(--primary-glow) 28%, transparent);
}

.separate-page :deep(.n-input),
.separate-page :deep(.n-base-selection) {
  background: color-mix(in srgb, var(--surface-2) 72%, transparent);
}

.run-mode-toggle {
  width: fit-content;
  display: inline-flex;
  align-items: center;
  padding: 3px;
  border: 1px solid color-mix(in srgb, var(--outline) 54%, transparent);
  border-radius: 13px;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.07), transparent 52%, rgba(0,0,0,0.08)),
    color-mix(in srgb, var(--surface) 34%, transparent);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.08),
    inset 0 -1px 0 rgba(0,0,0,0.18),
    0 1px 2px rgba(0,0,0,0.16);
  overflow: hidden;
}

.run-mode-toggle :deep(.n-radio-button) {
  height: 28px;
  line-height: 28px;
  border: 0;
  border-radius: 10px;
  background: transparent;
}

.run-mode-toggle :deep(.n-radio-group__splitor) {
  display: none;
}

.run-mode-toggle :deep(.n-radio-button--checked) {
  background: var(--n-button-color-active);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.16);
}

.run-mode-toggle :deep(.n-radio-button__state-border) {
  display: none;
}

.workspace-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.16fr) minmax(380px, 0.84fr);
  gap: 14px;
  align-items: stretch;
  height: clamp(420px, calc(330px + 20vh), 620px);
  min-height: 0;
}

.workspace-grid--compact {
  height: auto;
}

.config-panel {
  display: grid;
  gap: 12px;
  padding: 18px;
  border: 1px solid color-mix(in srgb, var(--outline) 64%, transparent);
  border-radius: 22px;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.035), transparent 40%),
    color-mix(in srgb, var(--surface-1) 90%, transparent);
  min-height: 0;
  height: 100%;
  overflow: hidden;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.05),
    0 18px 42px rgba(0, 0, 0, 0.055);
  transition: box-shadow 220ms cubic-bezier(0.22, 1, 0.36, 1), transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}

.workspace-grid--compact .config-panel {
  height: auto;
  min-height: 72px;
  padding: 14px 16px;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.04),
    0 10px 26px rgba(0, 0, 0, 0.04);
}

.config-panel--input {
  grid-template-rows: auto minmax(0, 1fr);
}

.config-panel--model {
  grid-template-rows: auto minmax(0, 1fr);
}

.workspace-grid--compact .config-panel--input,
.workspace-grid--compact .config-panel--model {
  grid-template-rows: auto;
}

.config-rollup-content {
  min-height: 0;
  display: grid;
  gap: 12px;
  animation: rollup-content-enter 420ms cubic-bezier(0.22, 1, 0.36, 1);
}

.config-rollup-content--input {
  height: 100%;
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
}

.config-rollup-content--model {
  height: 100%;
  min-height: 0;
  grid-template-rows: minmax(0, 1fr);
  overflow: hidden;
}

.panel-heading {
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.panel-heading > div:not(.panel-heading__icon) {
  min-width: 0;
}

.panel-heading__main {
  min-width: 0;
  flex: 1;
}

.panel-heading__action {
  min-width: 0;
  max-width: min(210px, 34%);
  flex: 0 1 auto;
  margin-left: auto;
  color: color-mix(in srgb, var(--on-surface-muted) 82%, var(--on-surface));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.panel-heading__action :deep(.n-button__content) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel-heading__icon {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  border-radius: 14px;
  font-size: 19px;
  color: color-mix(in srgb, var(--primary-strong) 88%, var(--on-surface));
  background:
    linear-gradient(180deg, rgba(255,255,255,0.08), transparent 58%),
    color-mix(in srgb, var(--primary-soft) 58%, var(--surface-2));
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 45%, transparent),
    inset 0 1px 0 rgba(255,255,255,0.08);
}

.panel-heading h2 {
  margin: 0;
  font-size: 16px;
  letter-spacing: -0.025em;
}

.panel-heading p {
  margin: 2px 0 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.5;
}

.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
}

.candidate {
  position: relative;
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 10px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--outline) 62%, transparent);
  border-radius: 18px;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--surface-2) 26%, transparent), transparent),
    color-mix(in srgb, var(--surface) 42%, transparent);
  transition: border-color 140ms ease, background 140ms ease, box-shadow 140ms ease;
}

.candidate::before {
  content: '';
  position: absolute;
  inset: 58px 18px 28px;
  opacity: 0.22;
  pointer-events: none;
  background:
    linear-gradient(90deg, transparent 0 5%, color-mix(in srgb, var(--primary) 34%, transparent) 5% 5.5%, transparent 5.5% 9.5%),
    repeating-linear-gradient(90deg, transparent 0 22px, color-mix(in srgb, var(--on-surface-muted) 18%, transparent) 22px 23px, transparent 23px 44px);
  mask-image: linear-gradient(180deg, transparent, black 18%, black 78%, transparent);
}

.candidate--dragging {
  border-color: color-mix(in srgb, var(--primary) 78%, var(--outline));
  border-style: dashed;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--primary-soft) 20%, transparent), transparent),
    color-mix(in srgb, var(--surface-2) 44%, transparent);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--primary-border) 34%, transparent),
    0 16px 30px color-mix(in srgb, var(--primary-glow) 10%, transparent);
}

.candidate__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.candidate__head strong {
  font-size: 13px;
}

.candidate__head span {
  flex: 1;
  color: var(--on-surface-muted);
  font-size: 12px;
}

.candidate__list {
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  gap: 8px;
  max-height: 100%;
  overflow-y: auto;
  padding-right: 2px;
}

.candidate__list,
.model-picker__list {
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--outline) 70%, transparent) transparent;
}

.candidate__list::-webkit-scrollbar,
.model-picker__list::-webkit-scrollbar {
  width: 6px;
}

.candidate__list::-webkit-scrollbar-thumb,
.model-picker__list::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--outline) 80%, transparent);
}

.candidate__list::-webkit-scrollbar-thumb:hover,
.model-picker__list::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--on-surface-muted) 50%, transparent);
}

.candidate__list::-webkit-scrollbar-track,
.model-picker__list::-webkit-scrollbar-track {
  background: transparent;
}

.candidate__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, var(--outline) 58%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface-1) 76%, transparent);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.035);
}

.candidate__item-icon {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--primary-strong);
}

.candidate__item-main {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 2px;
}

.candidate__item-kind {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.4;
  color: color-mix(in srgb, var(--primary-strong) 78%, var(--on-surface-muted));
  background: color-mix(in srgb, var(--primary-soft) 22%, var(--surface-2));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 18%, transparent);
}

.candidate__item-main strong,
.candidate__item-main code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.candidate__item-main strong {
  font-size: 13px;
}

.candidate__item-main code {
  color: var(--on-surface-muted);
  font-size: 11px;
}

.candidate__empty {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px 16px;
  text-align: center;
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.6;
}

.candidate__empty-icon {
  width: 50px;
  height: 50px;
  display: grid;
  place-items: center;
  border-radius: 16px;
  font-size: 24px;
  color: var(--primary-strong);
  background:
    linear-gradient(180deg, rgba(255,255,255,0.08), transparent 64%),
    color-mix(in srgb, var(--primary-soft) 40%, var(--surface-2));
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 28%, transparent),
    0 12px 24px rgba(0, 0, 0, 0.08);
}

.model-panel__body {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  overflow: hidden;
}

.model-picker {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: hidden;
}

.run-mode-content {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: hidden;
}

.run-mode-content-enter-active {
  transition: opacity 220ms cubic-bezier(0.22, 1, 0.36, 1), transform 240ms cubic-bezier(0.22, 1, 0.36, 1);
  will-change: opacity, transform;
}

.run-mode-content-leave-active {
  transition: opacity 150ms cubic-bezier(0.4, 0, 1, 1), transform 150ms cubic-bezier(0.4, 0, 1, 1);
  will-change: opacity, transform;
}

.run-mode-content-enter-from {
  opacity: 0;
  transform: translateX(10px);
}

.run-mode-content-leave-to {
  opacity: 0;
  transform: translateX(-8px);
}

.model-picker__toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(180px, 0.7fr);
  gap: 10px;
}
.model-picker--workflow .model-picker__toolbar {
  grid-template-columns: minmax(0, 1fr);
}

.model-picker__divider {
  height: 1px;
  background: color-mix(in srgb, var(--outline) 52%, transparent);
}

.model-picker__list {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-auto-rows: max-content;
  align-content: start;
  gap: 5px;
  overflow-y: auto;
  max-height: min(340px, 42vh);
  padding: 7px;
  padding-right: 5px;
  border: 1px solid color-mix(in srgb, var(--outline) 58%, transparent);
  border-radius: 16px;
  background: color-mix(in srgb, var(--surface) 34%, transparent);
}

.model-picker__item {
  min-width: 0;
  min-height: 46px;
  width: 100%;
  max-width: 100%;
  overflow: hidden;
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px 8px 12px;
  border: 1px solid transparent;
  border-radius: 13px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease, color 140ms ease, box-shadow 140ms ease;
}

.model-picker__item:hover {
  background: color-mix(in srgb, var(--surface-2) 42%, transparent);
}

.model-picker__item--active {
  border-color: color-mix(in srgb, var(--primary) 26%, transparent);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--primary-soft) 34%, transparent), transparent 72%),
    color-mix(in srgb, var(--surface-2) 60%, transparent);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.055),
    0 10px 22px color-mix(in srgb, var(--primary-glow) 7%, transparent);
}

.model-picker__item-main {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 2px;
}

.model-picker__item-title {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  display: flex;
  align-items: center;
  gap: 8px;
}

.model-picker__item-title strong {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
}

.model-picker__item--active .model-picker__item-title strong {
  color: color-mix(in srgb, var(--primary-strong) 78%, var(--on-surface));
}

.model-picker__item-tag {
  flex: 0 0 auto;
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--primary) 18%, transparent);
  background: color-mix(in srgb, var(--primary-soft) 18%, var(--surface-2));
  color: color-mix(in srgb, var(--primary-strong) 72%, var(--on-surface-muted));
  font-size: 9px;
  line-height: 1.4;
}

.model-picker__item-sub {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--on-surface-muted);
  font-size: 11px;
}

.model-picker__item--active .model-picker__item-tag {
  background: color-mix(in srgb, var(--primary-soft) 34%, var(--surface-2));
  color: color-mix(in srgb, var(--primary-strong) 78%, var(--on-surface-muted));
}

.model-picker__item--active .model-picker__item-sub {
  color: color-mix(in srgb, var(--primary-strong) 72%, var(--on-surface-muted));
}

.model-picker__item-check {
  flex: 0 0 auto;
  font-size: 15px;
  color: color-mix(in srgb, var(--primary-strong) 86%, var(--primary));
}
@media (max-width: 1080px) {
  .config-panel--workflow .panel-heading {
    display: grid;
    grid-template-columns: 38px minmax(0, 1fr);
  }
  .config-panel--workflow .panel-heading__action {
    grid-column: 2;
    justify-self: start;
    max-width: 100%;
    margin-left: 0;
  }
}

.model-picker__empty {
  padding: 14px 12px;
  border: 1px dashed color-mix(in srgb, var(--outline) 74%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface-1) 72%, transparent);
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
}

.model-picker__category-select {
  min-width: 0;
}

.model-picker__category-select :deep(.n-base-selection) {
  border-radius: 12px;
}

.model-picker__category-select :deep(.n-base-selection.n-base-selection--active) {
  border-bottom-left-radius: 12px;
  border-bottom-right-radius: 12px;
}

:deep(.model-picker__category-menu) {
  margin-top: 6px;
  border-radius: 12px;
  overflow: hidden;
}

.model-info-card {
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--outline) 64%, transparent);
  border-radius: 12px;
}

.model-info-card--warn {
  color: var(--warning);
  border-color: color-mix(in srgb, var(--warning) 34%, var(--outline));
  background: color-mix(in srgb, var(--warning) 8%, transparent);
  font-size: 12px;
  line-height: 1.6;
}

.model-panel__empty-state {
  position: relative;
  overflow: hidden;
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  min-height: 270px;
  padding: 28px 24px;
  border: 1px dashed color-mix(in srgb, var(--outline) 68%, var(--primary-border));
  border-radius: 20px;
  background:
    radial-gradient(circle at top, color-mix(in srgb, var(--primary-soft) 7%, transparent), transparent 54%),
    color-mix(in srgb, var(--surface) 28%, transparent);
  text-align: center;
}

.model-panel__empty-state::before {
  content: '';
  position: absolute;
  inset: -30% -20%;
  background:
    radial-gradient(circle at 20% 20%, color-mix(in srgb, var(--primary-soft) 11%, transparent), transparent 32%),
    radial-gradient(circle at 72% 28%, color-mix(in srgb, var(--primary) 6%, transparent), transparent 34%);
  opacity: 0.76;
  pointer-events: none;
}

.model-panel__empty-state--loading::before {
  opacity: 0.7;
}

.model-panel__empty-visual {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 68px;
  height: 68px;
  border: 1px solid color-mix(in srgb, var(--primary) 18%, var(--outline));
  border-radius: 22px;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.08), transparent 60%),
    color-mix(in srgb, var(--surface-1) 82%, var(--primary-soft));
  color: var(--primary);
  box-shadow: 0 14px 30px color-mix(in srgb, var(--primary) 7%, transparent);
}

.model-panel__empty-visual :deep(.n-spin-body) {
  color: var(--primary);
}

.model-panel__empty-visual .n-icon {
  font-size: 30px;
}

.model-panel__empty-main {
  position: relative;
  z-index: 1;
  max-width: 340px;
}

.model-panel__empty-main strong {
  display: block;
  font-size: 15px;
  line-height: 1.4;
}

.model-panel__empty-main p {
  margin-top: 8px;
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.75;
}

.model-panel__empty-actions {
  position: relative;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.model-panel__empty-actions .n-button {
  min-width: 130px;
}

.summary-bar {
  padding: 16px;
  border: 1px solid color-mix(in srgb, var(--outline) 58%, transparent);
  border-radius: 18px;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.032), transparent 42%),
    color-mix(in srgb, var(--surface-1) 82%, transparent);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.045),
    0 16px 36px rgba(0, 0, 0, 0.045);
}

.summary-bar__content {
  min-width: 0;
  display: grid;
  gap: 12px;
}

.summary-bar__topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.summary-bar__heading {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
}

.summary-bar__heading-icon {
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  font-size: 19px;
  color: color-mix(in srgb, var(--primary-strong) 88%, var(--on-surface));
  background:
    linear-gradient(180deg, rgba(255,255,255,0.08), transparent 58%),
    color-mix(in srgb, var(--primary-soft) 58%, var(--surface-2));
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 45%, transparent),
    inset 0 1px 0 rgba(255,255,255,0.08);
}

.summary-bar__heading > div {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.summary-bar__topline strong {
  font-size: 14px;
  letter-spacing: -0.01em;
}

.summary-bar__heading > div > span {
  color: var(--on-surface-muted);
  font-size: 12px;
}

.summary-bar__body {
  min-width: 0;
  display: grid;
  gap: 12px;
}

.summary-bar__options {
  min-width: 0;
  display: grid;
  gap: 12px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--outline) 58%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface-2) 36%, transparent);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.035);
}

.summary-bar__execution {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px 16px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--outline) 58%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface-2) 30%, transparent);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.035);
}

.summary-bar__output-line {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
}

.summary-bar__path {
  min-width: 0;
  flex: 0 1 auto;
  max-width: 520px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: color-mix(in srgb, var(--on-surface) 90%, var(--on-surface-muted));
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.summary-config-grid {
  display: grid;
  grid-template-columns: minmax(260px, 460px) minmax(104px, 132px) max-content;
  gap: 12px;
  align-items: end;
  justify-content: start;
}

.summary-config-grid--batch {
  grid-template-columns: minmax(260px, 460px) minmax(104px, 132px) minmax(132px, 180px) max-content;
}

.summary-config-grid .field-block {
  min-width: 0;
}

.summary-bar__advanced {
  justify-self: start;
}

.summary-checks {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  min-height: 34px;
  padding-bottom: 2px;
}

.stem-toggle-list {
  min-height: 28px;
  min-width: 0;
  max-height: 96px;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 4px;
  overscroll-behavior: contain;
}

.stem-toggle-list :deep(.n-checkbox-group) {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.stem-toggle-list :deep(.n-checkbox) {
  max-width: 190px;
  min-height: 30px;
  align-items: center;
  padding: 5px 10px 5px 8px;
  border: 1px solid color-mix(in srgb, var(--outline) 62%, transparent);
  border-radius: 12px;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.04), transparent),
    color-mix(in srgb, var(--surface-2) 58%, transparent);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.035);
}

.stem-toggle-list :deep(.n-checkbox:hover) {
  border-color: color-mix(in srgb, var(--primary) 42%, var(--outline));
  background: color-mix(in srgb, var(--primary) 12%, var(--surface-2));
}

.stem-toggle-list :deep(.n-checkbox--checked) {
  border-color: color-mix(in srgb, var(--primary) 58%, var(--outline));
  background: color-mix(in srgb, var(--primary) 16%, var(--surface-2));
}

.stem-toggle-list :deep(.n-checkbox-box-wrapper) {
  width: 16px;
  height: 16px;
}

.stem-toggle-list :deep(.n-checkbox-box) {
  width: 16px;
  height: 16px;
  border-radius: 5px;
  background-color: color-mix(in srgb, var(--surface-2) 82%, transparent);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
}

.stem-toggle-list :deep(.n-checkbox-box__border) {
  border: 1px solid color-mix(in srgb, var(--outline) 72%, transparent);
}

.stem-toggle-list :deep(.n-checkbox--checked .n-checkbox-box) {
  background-color: color-mix(in srgb, var(--primary) 82%, white);
}

.stem-toggle-list :deep(.n-checkbox--checked .n-checkbox-box__border) {
  border-color: color-mix(in srgb, var(--primary-border) 72%, transparent);
}

.stem-toggle-list :deep(.n-checkbox__label) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.summary-stems-shell {
  min-height: 0;
  overflow: hidden;
}

.summary-stems-shell > .summary-stems-row {
  min-height: 0;
  transform-origin: top center;
}

.summary-stems-enter-active {
  transition: opacity 180ms cubic-bezier(0.22, 1, 0.36, 1), transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
  will-change: opacity, transform;
}

.summary-stems-leave-active {
  transition: opacity 120ms cubic-bezier(0.4, 0, 1, 1), transform 140ms cubic-bezier(0.4, 0, 1, 1);
  will-change: opacity, transform;
}

.summary-stems-enter-from,
.summary-stems-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.stem-toggle-empty {
  min-height: 34px;
  display: flex;
  align-items: center;
  color: var(--on-surface-muted);
  font-size: 13px;
}

.summary-stems-row {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: start;
  gap: 10px 14px;
  min-height: 26px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--outline) 58%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface-2) 34%, transparent);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.035);
}

.summary-stems-row__head {
  min-width: 0;
  display: flex;
  align-self: center;
  align-items: center;
  gap: 10px;
}

.summary-stems-row__head label {
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.4;
}

.summary-stems-row__head span {
  color: var(--on-surface-muted);
  font-size: 12px;
}

.summary-bar__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.summary-bar__status {
  min-width: 0;
  display: grid;
  gap: 5px;
}

.summary-bar__ready {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--success);
}

.summary-bar__ready strong {
  color: color-mix(in srgb, var(--success) 82%, var(--on-surface));
  font-size: 13px;
}

.summary-bar__ready--disabled,
.summary-bar__ready--disabled strong {
  color: var(--on-surface-muted);
}

.summary-bar__details {
  min-width: 0;
  flex: 1 1 360px;
  display: flex;
  flex-wrap: wrap;
  gap: 7px 12px;
  color: color-mix(in srgb, var(--on-surface-muted) 92%, var(--on-surface));
  font-size: 11px;
}

.summary-bar__actions {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: flex-end;
  flex-wrap: wrap;
}

.summary-bar__actions :deep(.n-button--primary-type) {
  min-width: 138px;
}

.separation-task-panel,
.result-preview-panel {
  border: 1px solid color-mix(in srgb, var(--outline) 64%, transparent);
  border-radius: 22px;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.03), transparent 44%),
    color-mix(in srgb, var(--surface-1) 82%, transparent);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.04),
    0 14px 34px rgba(0, 0, 0, 0.055);
}

:global(.light-theme) .config-panel,
:global(.light-theme) .summary-bar,
:global(.light-theme) .separation-task-panel,
:global(.light-theme) .result-preview-panel {
  background:
    linear-gradient(180deg, rgba(255,255,255,0.76), rgba(255,255,255,0.42) 44%, rgba(255,255,255,0.18)),
    color-mix(in srgb, var(--surface-1) 88%, transparent);
  border-color: color-mix(in srgb, var(--outline) 72%, transparent);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.86),
    0 18px 46px rgba(37, 49, 77, 0.08);
}

:global(.dark-theme) .config-panel,
:global(.dark-theme) .summary-bar,
:global(.dark-theme) .separation-task-panel,
:global(.dark-theme) .result-preview-panel {
  background:
    linear-gradient(180deg, rgba(255,255,255,0.035), transparent 42%),
    color-mix(in srgb, var(--surface-1) 84%, transparent);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.045),
    0 18px 52px rgba(0, 0, 0, 0.18);
}

.separation-task-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 86px;
  padding: 16px 18px;
  animation: task-panel-pop-in 420ms cubic-bezier(0.22, 1, 0.36, 1);
  transition:
    min-height 520ms cubic-bezier(0.22, 1, 0.36, 1),
    padding 520ms cubic-bezier(0.22, 1, 0.36, 1),
    transform 420ms cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow 420ms cubic-bezier(0.22, 1, 0.36, 1);
}

.separation-task-panel--running {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  min-height: 220px;
  padding: 20px;
}

.separation-task-panel--done,
.separation-task-panel--failed,
.separation-task-panel--cancelled {
  min-height: 104px;
  padding: 16px 18px;
  transform: translateY(-2px);
}

.task-ready-main,
.task-done-main,
.task-running-head,
.task-panel-meta,
.task-panel-actions {
  min-width: 0;
}

.task-ready-main,
.task-done-main {
  display: flex;
  align-items: center;
  gap: 12px;
}

.task-ready-main {
  display: grid;
  gap: 4px;
}

.task-ready-main strong,
.task-running-head strong,
.task-done-main strong {
  font-size: 15px;
  letter-spacing: -0.01em;
}

.task-ready-main span,
.task-done-main span,
.task-panel-meta,
.task-panel-message {
  color: var(--on-surface-muted);
  font-size: 12px;
}

.task-ready-main code,
.task-done-main code {
  min-width: 0;
  max-width: min(62vw, 720px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--on-surface-muted);
  font-size: 12px;
}

.task-running-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  grid-column: 1 / -1;
}

.task-running-head > div,
.task-done-main > div {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.task-running-head span,
.task-done-main small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--on-surface-muted);
  font-size: 12px;
}

.task-progress-block {
  display: grid;
  gap: 10px;
  align-self: stretch;
}

.task-progress-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}

.task-progress-head strong {
  font-size: 20px;
  letter-spacing: -0.03em;
}

.task-panel-message {
  margin: 0;
}

.task-panel-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  grid-column: 1 / -1;
}

.task-panel-meta span {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.task-panel-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px;
}

.separation-task-panel--running .task-panel-actions {
  align-self: end;
}

.separation-task-panel--done .task-done-main,
.separation-task-panel--failed .task-done-main,
.separation-task-panel--cancelled .task-done-main,
.separation-task-panel--done .task-panel-actions,
.separation-task-panel--failed .task-panel-actions,
.separation-task-panel--cancelled .task-panel-actions {
  animation: task-compact-content-enter 460ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.separation-task-panel--done .task-panel-actions,
.separation-task-panel--failed .task-panel-actions,
.separation-task-panel--cancelled .task-panel-actions {
  animation-delay: 80ms;
}

.result-preview-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 12px;
  max-height: clamp(260px, 38vh, 520px);
  padding: 16px 18px;
  overflow: hidden;
}

.result-preview-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.result-preview-panel__head strong {
  font-size: 14px;
}

.result-preview-panel__head span {
  color: var(--on-surface-muted);
  font-size: 12px;
}

.preview-result-list {
  min-height: 0;
  display: grid;
  align-content: start;
  gap: 10px;
  overflow-y: auto;
  padding-right: 4px;
}

.preview-result-card {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--outline) 70%, transparent);
  border-radius: 16px;
  background: color-mix(in srgb, var(--surface-2) 30%, transparent);
}

.preview-result-card__head {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.preview-result-card__head strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.preview-result-card__head span {
  flex: 0 0 auto;
  color: var(--on-surface-muted);
  font-size: 11px;
}

.preview-track-list {
  display: grid;
  gap: 8px;
}

.preview-track {
  display: grid;
  grid-template-columns: minmax(160px, 0.9fr) auto minmax(180px, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--outline) 78%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface-2) 44%, transparent);
}

.preview-track__title {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.preview-track__title strong,
.preview-track__title small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-track__title strong {
  font-size: 13px;
}

.preview-track__title small,
.preview-track__time {
  color: var(--on-surface-muted);
  font-size: 11px;
}

.preview-track__slider {
  min-width: 0;
}

.preview-track__time {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.result-preview-enter-active,
.result-preview-leave-active {
  transition: opacity 420ms cubic-bezier(0.22, 1, 0.36, 1), transform 460ms cubic-bezier(0.22, 1, 0.36, 1);
}

.result-preview-enter-from,
.result-preview-leave-to {
  opacity: 0;
  transform: translateY(-14px) scale(0.985);
}

.preview-track {
  animation: panel-soft-enter 320ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.preview-track:nth-child(2) {
  animation-delay: 55ms;
}

.preview-track:nth-child(3) {
  animation-delay: 110ms;
}

.preview-track:nth-child(4) {
  animation-delay: 165ms;
}

.preview-track:nth-child(n + 5) {
  animation-delay: 220ms;
}

@keyframes panel-roll-enter {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes rollup-content-enter {
  from {
    opacity: 0;
    transform: translateY(-12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes task-panel-pop-in {
  from {
    opacity: 0;
    transform: translateY(18px) scale(0.99);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes task-compact-content-enter {
  from {
    opacity: 0;
    transform: translateY(-16px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes panel-soft-enter {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.log-console {
  max-height: min(62vh, 520px);
  overflow: auto;
  display: grid;
  gap: 2px;
  padding: 12px;
  border-radius: 12px;
  background: #0b1020;
  color: #dbeafe;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
}

.log-line {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr);
  gap: 10px;
}

.log-line-number {
  color: #64748b;
  text-align: right;
  user-select: none;
}

.log-line-text {
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.log-empty {
  padding: 18px;
  color: var(--on-surface-muted);
  text-align: center;
}

.settings-drawer__content {
  display: grid;
  gap: 14px;
  min-height: 0;
  padding-top: 18px;
  padding-bottom: 8px;
}

.settings-modal {
  width: min(760px, calc(100vw - 48px));
  max-height: min(760px, calc(100vh - 64px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 20px;
}

.settings-modal :deep(.n-card-header) {
  flex: 0 0 auto;
  padding: 18px 22px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--outline) 86%, transparent);
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
}

.settings-modal :deep(.n-card-header__main) {
  font-size: 15px;
  font-weight: 600;
}

.settings-modal :deep(.n-card-content),
.settings-modal :deep(.n-card__content) {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 0 22px 20px;
}

.settings-modal :deep(.n-card-footer),
.settings-modal :deep(.n-card__footer) {
  flex: 0 0 auto;
  padding: 14px 22px 16px;
  border-top: 1px solid color-mix(in srgb, var(--outline) 86%, transparent);
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
}

.field-block {
  display: grid;
  gap: 6px;
}

.field-block label {
  font-size: 12px;
  color: var(--on-surface-muted);
}

.field-block__hint {
  font-size: 11px;
  line-height: 1.45;
  color: var(--on-surface-muted);
}

.output-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 180px;
  gap: 12px;
}

.settings-group {
  display: grid;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--outline);
  border-radius: 16px;
  background: color-mix(in srgb, var(--surface-2) 62%, transparent);
}

.settings-group__head {
  display: grid;
  gap: 3px;
}

.settings-group__head strong {
  font-size: 13px;
}

.settings-group__head span {
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.5;
}

.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--outline);
  border-radius: 12px;
  background: var(--surface-1);
}

.settings-row__copy {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.settings-row__copy strong {
  font-size: 13px;
}

.settings-row__copy span {
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.5;
}

.output-preview {
  display: grid;
  gap: 4px;
  padding: 12px 14px;
  border: 1px solid var(--outline);
  border-radius: 12px;
  background: var(--surface-1);
}

.output-preview span {
  color: var(--on-surface-muted);
  font-size: 12px;
}

.output-preview code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.advanced-hint {
  margin: 0 0 12px;
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.5;
}

.advanced-loading,
.advanced-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.5;
}

.advanced-empty {
  margin-top: 14px;
}

.check-list {
  display: flex;
  flex-wrap: wrap;
  gap: 14px 18px;
}

.check-list--spaced {
  margin-top: 14px;
}

.drawer-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

@media (max-width: 1100px) {
  .workspace-grid,
  .output-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .workspace-grid {
    height: auto;
  }

  .model-picker__toolbar {
    grid-template-columns: minmax(0, 1fr);
  }

  .summary-config-grid {
    grid-template-columns: minmax(0, 160px) max-content;
  }

  .summary-config-grid--batch {
    grid-template-columns: minmax(0, 160px) minmax(0, 180px) max-content;
  }

  .summary-config-grid .field-block--wide {
    grid-column: 1 / -1;
    max-width: 520px;
  }

  .summary-bar__execution {
    grid-template-columns: minmax(0, 1fr);
  }

  .summary-checks {
    grid-column: 1 / -1;
  }

  .summary-bar__footer {
    align-items: flex-start;
    flex-direction: column;
  }

  .summary-bar__actions {
    justify-content: flex-end;
    flex-wrap: wrap;
  }

  .separation-task-panel,
  .separation-task-panel--running {
    grid-template-columns: minmax(0, 1fr);
    align-items: stretch;
  }

  .task-panel-actions {
    justify-content: flex-start;
  }

  .preview-track {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .preview-track__slider,
  .preview-track__time {
    grid-column: 1 / -1;
  }
}

@media (max-width: 620px) {
  .summary-config-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .summary-bar__advanced {
    justify-self: stretch;
  }

  .summary-bar__topline {
    flex-direction: column;
    align-items: stretch;
  }

  .summary-bar__heading {
    justify-content: space-between;
  }

  .summary-bar__actions {
    justify-content: stretch;
  }

  .summary-stems-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }

  .summary-stems-row__head label {
    line-height: 1.4;
  }

  .summary-bar__actions .n-button {
    flex: 1 1 160px;
  }

  .settings-modal {
    width: calc(100vw - 28px);
    max-height: calc(100vh - 40px);
  }

  .settings-drawer__content,
  .settings-modal :deep(.n-card-content),
  .settings-modal :deep(.n-card__content) {
    padding-left: 16px;
    padding-right: 16px;
  }

  .settings-modal :deep(.n-card-header),
  .settings-modal :deep(.n-card-footer),
  .settings-modal :deep(.n-card__footer) {
    padding-left: 16px;
    padding-right: 16px;
  }
}

@media (max-width: 720px) {
  .candidate {
    height: 300px;
  }

  .model-picker {
    height: 300px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .config-rollup-content,
  .separation-task-panel,
  .preview-track,
  .separation-task-panel--done .task-done-main,
  .separation-task-panel--failed .task-done-main,
  .separation-task-panel--cancelled .task-done-main,
  .separation-task-panel--done .task-panel-actions,
  .separation-task-panel--failed .task-panel-actions,
  .separation-task-panel--cancelled .task-panel-actions {
    animation: none;
  }

  .separate-header__brand:hover :deep(.app-brand-mark) {
    animation: none;
  }

  .result-preview-enter-active,
  .result-preview-leave-active,
  .run-mode-content-enter-active,
  .run-mode-content-leave-active,
  .summary-stems-enter-active,
  .summary-stems-leave-active {
    transition: none;
  }
}
</style>
