<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useDialog, useMessage } from 'naive-ui'
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
  SettingsOutline,
  OpenOutline,
  PauseOutline,
  TerminalOutline,
  TimeOutline,
} from '@vicons/ionicons5'
import { useModelStore } from '@/stores/model'
import { useTaskStore, type OutputLayout, type SeparationTask } from '@/stores/task'
import { useWorkflowStore } from '@/stores/workflow'
import { useSettingsStore } from '@/stores/settings'
import { useAppStore } from '@/stores/app'
import { buildModelCategoryOptionsFromModels, getModelCategoryLabel } from '@/utils/modelCategory'
import { getWorkflowBatchInputConfigs, getWorkflowValidationSummary, type WorkflowValidationSummary } from '@/utils/workflowDefinition'
import { getWorkflowDefinitionDefaults } from '@/utils/workflowGraph'
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
const saveAsFolder = computed({
  get: () => outputLayout.value === 'folders',
  set: (value: boolean) => {
    outputLayout.value = value ? 'folders' : 'flat'
  },
})
const effectiveOutputLayout = computed<OutputLayout>(() => outputLayout.value)
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
const selectedWorkflowValidation = computed(() => selectedWorkflow.value
  ? getWorkflowValidationSummary(selectedWorkflow.value.definition)
  : null)
const selectedWorkflowBatchConfigs = computed(() => selectedWorkflow.value
  ? getWorkflowBatchInputConfigs(selectedWorkflow.value.definition)
  : [])
const workflowUsesBatchInput = computed(() => (
  runMode.value === 'workflow'
  && Boolean(selectedWorkflow.value)
  && Boolean(selectedWorkflowValidation.value?.batchInputCount)
))
const workflowBatchInputInvalid = computed(() => (
  runMode.value === 'workflow'
  && Boolean(selectedWorkflow.value)
  && Boolean(selectedWorkflowValidation.value?.batchInputMultipleUnsupported)
))
const workflowBatchInputMissingFolder = computed(() => (
  runMode.value === 'workflow'
  && Boolean(selectedWorkflow.value)
  && Boolean(selectedWorkflowValidation.value?.batchInputMissingFolderCount)
))
const workflowUtilityInputInvalid = computed(() => (
  runMode.value === 'workflow'
  && Boolean(selectedWorkflow.value)
  && Boolean(selectedWorkflowValidation.value?.utilityInputMissingCount)
))
function workflowValidationError(summary: WorkflowValidationSummary | null | undefined) {
  if (!summary) return ''
  if (summary.batchInputMultipleUnsupported) return t('separate.startHintWorkflowBatchMultiple')
  if (summary.batchInputMissingFolderCount > 0) return t('workflows.batchInputFolderRequired')
  if (summary.utilityInputMissingCount > 0) return t('workflows.utilityInputsRequired', { count: summary.utilityInputMissingCount })
  if (summary.danglingConnectionCount > 0) return t('workflows.workflowDanglingConnections', { count: summary.danglingConnectionCount })
  if (summary.invalidConnectionCount > 0) return t('workflows.workflowInvalidConnections', { count: summary.invalidConnectionCount })
  if (summary.duplicateInputConnectionCount > 0) return t('workflows.workflowDuplicateInputConnections', { count: summary.duplicateInputConnectionCount })
  if (summary.graphCycleDetected) return t('workflows.workflowCycleDetected')
  if (summary.noSaveOutputs) return t('workflows.workflowNoSaveOutputs')
  return ''
}
const workflowStructureInvalid = computed(() => (
  runMode.value === 'workflow'
  && Boolean(selectedWorkflow.value)
  && Boolean(workflowValidationError(selectedWorkflowValidation.value))
))
const startStatusText = computed(() => {
  if (runMode.value === 'workflow' && !selectedWorkflow.value) return t('separate.startHintNoWorkflow')
  const validationError = workflowValidationError(selectedWorkflowValidation.value)
  if (validationError) return validationError
  if (workflowUsesBatchInput.value) return t('separate.startHintWorkflowBatchFolder')
  if (!inputFiles.value.length) return t('separate.startHintNoInput')
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
    return `${base}${separator}${t('separate.outputFilePreview')}`
  }
  return `${base}${separator}${t('separate.resultFolderPreview')}${separator}${t('separate.outputStemPreview')}`
})
const effectiveFormat = computed(() => {
  if (runMode.value === 'workflow' && selectedWorkflow.value) {
    const defaults = getWorkflowDefinitionDefaults(selectedWorkflow.value.definition)
    return String(defaults.output_format || settings.defaultFormat || 'wav').trim().toLowerCase() || 'wav'
  }
  return String(settings.defaultFormat || 'wav').trim().toLowerCase() || 'wav'
})
const formatLabel = computed(() => effectiveFormat.value.toUpperCase())
const outputSummaryPath = computed(() => shortenMiddle(outputPreview.value, 60))
const canStart = computed(() => (
  (workflowUsesBatchInput.value || inputFiles.value.length > 0)
  && !workflowBatchInputInvalid.value
  && !workflowBatchInputMissingFolder.value
  && !workflowUtilityInputInvalid.value
  && !workflowStructureInvalid.value
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
const isTerminalState = computed(() => ['done', 'failed', 'cancelled'].includes(taskPanelState.value))
const isRunModeLocked = computed(() => taskPanelState.value === 'running')
const inputCompactLine = computed(() => {
  if (currentBatchIsMulti.value && currentBatchTotal.value) return t('separate.batchInputCompact', { count: currentBatchTotal.value })
  if (currentTask.value) return getFileName(currentTask.value.input)
  if (workflowUsesBatchInput.value) {
    if (selectedWorkflowBatchConfigs.value.length > 1) {
      return t('separate.batchInputFolderMultipleCompact', { count: selectedWorkflowBatchConfigs.value.length })
    }
    return t('separate.batchInputFolderCompact', { name: getFileName(selectedWorkflowBatchConfigs.value[0]?.folder || '') })
  }
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
  if (runMode.value === 'workflow' && !selectedWorkflow.value) {
    message.warning(t('separate.startHintNoWorkflow'))
    return
  }
  if (workflowBatchInputInvalid.value) {
    message.warning(t('separate.startHintWorkflowBatchMultiple'))
    return
  }
  if (workflowBatchInputMissingFolder.value) {
    message.warning(t('workflows.batchInputFolderRequired'))
    return
  }
  if (workflowUtilityInputInvalid.value) {
    message.warning(t('workflows.utilityInputsRequired', { count: selectedWorkflowValidation.value?.utilityInputMissingCount || 0 }))
    return
  }
  const validationError = workflowValidationError(selectedWorkflowValidation.value)
  if (validationError) {
    message.warning(validationError)
    return
  }
  if (!workflowUsesBatchInput.value && !inputFiles.value.length) {
    message.warning(t('separate.startHintNoInput'))
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
  showLogModal.value = false
  focusedSeparationJobId.value = null
}

function goToResults() {
  router.push('/results')
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
  dialog.warning({
    title: t('tasks.confirmRetryTitle'),
    content: t('tasks.confirmRetry'),
    positiveText: t('common.retry'),
    negativeText: t('common.cancel'),
    negativeButtonProps: { secondary: true },
    onPositiveClick: async () => {
      try {
        const next = await task.retryTask(item.id)
        focusedSeparationJobId.value = next?.jobId || next?.id || focusedSeparationJobId.value
        message.success(t('toast.taskRetried'))
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error))
      }
    },
  })
}
</script>

<template>
  <div class="page separate-page">
    <header class="console-topbar">
      <div class="console-topbar__brand">
        <AppBrandMark :size="30" variant="compact" shadow />
        <div class="console-topbar__title">
          <h1>Pymss-Studio</h1>
          <span>{{ t('separate.subtitle') }}</span>
        </div>
      </div>
      <div class="console-topbar__controls">
        <n-radio-group
          v-model:value="runMode"
          class="mode-switch"
          :disabled="isRunModeLocked"
        >
          <n-radio-button
            v-for="option in runModeOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </n-radio-button>
        </n-radio-group>
        <n-button text class="console-topbar__manage" @click="router.push(runMode === 'workflow' ? '/workflows' : '/models')">
          {{ runMode === 'workflow' ? t('separate.manageWorkflowsInline') : t('separate.manageModelsInline') }}
        </n-button>
      </div>
    </header>

    <div class="console" :class="[`console--${taskPanelState}`, { 'console--busy': isConfigCompact }]">
      <aside class="console__rail">
        <section class="rail-card rail-card--input">
          <div class="rail-card__head">
            <span class="rail-card__index">01</span>
            <div class="rail-card__label">
              <strong>{{ t('separate.input') }}</strong>
              <small>{{ t('separate.candidateCount', { count: inputFiles.length }) }}</small>
            </div>
            <n-button
              v-if="inputFiles.length"
              text
              size="tiny"
              class="rail-card__clear"
              :disabled="isRunModeLocked"
              @click="task.clearInputFiles()"
            >
              {{ t('separate.clearAll') }}
            </n-button>
          </div>
          <div class="rail-card__body">
            <div class="picker-buttons">
              <button type="button" class="picker-btn" :disabled="isRunModeLocked" @click="handlePickFiles">
                <n-icon :component="MusicalNotesOutline" />
                <span>{{ t('separate.chooseFiles') }}</span>
              </button>
              <button type="button" class="picker-btn" :disabled="isRunModeLocked" @click="handlePickFolder">
                <n-icon :component="FolderOutline" />
                <span>{{ t('separate.chooseFolder') }}</span>
              </button>
            </div>

            <div
              class="dropzone"
              :class="{ 'dropzone--dragging': isDragging, 'dropzone--filled': inputFiles.length, 'dropzone--clickable': !inputFiles.length && !isRunModeLocked }"
              @click="(!inputFiles.length && !isRunModeLocked) ? handlePickFiles() : undefined"
            >
              <div v-if="inputFiles.length" class="file-list">
                <div v-for="path in inputFiles" :key="path" class="file-chip">
                  <span class="file-chip__glyph"><n-icon :component="MusicalNotesOutline" /></span>
                  <div class="file-chip__main">
                    <strong :title="getFileName(path)">{{ getFileName(path) }}</strong>
                    <div class="file-chip__sub">
                      <span class="file-chip__kind">{{ getFileKindLabel(path) }}</span>
                      <code :title="path">{{ shortenMiddle(path, 60) }}</code>
                    </div>
                  </div>
                  <n-button quaternary circle size="tiny" class="file-chip__remove" :title="t('separate.remove')" :disabled="isRunModeLocked" @click="task.removeInputFile(path)">
                    <template #icon><n-icon :component="CloseOutline" /></template>
                  </n-button>
                </div>
              </div>
              <div v-else class="dropzone__empty">
                <div class="dropzone__glyph"><n-icon :component="CloudUploadOutline" /></div>
                <strong>{{ isDragging ? t('separate.dropHere') : t('separate.candidateEmpty') }}</strong>
              </div>
            </div>
          </div>
        </section>

        <section class="rail-card rail-card--output">
          <div class="rail-card__head">
            <span class="rail-card__index">02</span>
            <div class="rail-card__label">
              <strong>{{ t('separate.output') }}</strong>
              <small>{{ t('separate.outputSummaryHint') }}</small>
            </div>
            <n-button text size="tiny" class="rail-card__more" :disabled="isRunModeLocked" @click="showSettingsDrawer = true">
              <template #icon><n-icon :component="SettingsOutline" /></template>
              {{ t('separate.configParams') }}
            </n-button>
          </div>
          <div class="rail-card__body rail-card__body--output">
            <label class="ofield">
              <span class="ofield__label">{{ t('separate.temporaryOutputDir') }}</span>
              <div class="dir-input">
                <n-input v-model:value="temporaryOutputDir" size="small" :placeholder="settings.outputDir || t('separate.outputDefault')" :disabled="isRunModeLocked" clearable />
                <n-button secondary size="small" class="dir-input__browse" :title="t('separate.chooseOutput')" :disabled="isRunModeLocked" @click="pickTemporaryOutputDir">
                  <template #icon><n-icon :component="FolderOutline" /></template>
                </n-button>
              </div>
            </label>

            <div class="ofield-row">
              <label class="ofield">
                <span class="ofield__label">{{ runMode === 'workflow' ? t('separate.currentFormat') : t('settings.defaultFormat') }}</span>
                <n-select v-if="runMode === 'model'" v-model:value="settings.defaultFormat" size="small" :options="formatOptions" :disabled="isRunModeLocked" />
                <div v-else class="ofield__static">{{ formatLabel }}</div>
              </label>
              <div class="ofield">
                <span class="ofield__label">{{ t('separate.saveMode') }}</span>
                <div class="seg" :class="{ 'seg--locked': isRunModeLocked }">
                  <button
                    type="button"
                    class="seg__btn"
                    :class="{ 'seg__btn--active': saveAsFolder }"
                    :disabled="isRunModeLocked"
                    @click="saveAsFolder = true"
                  >{{ t('separate.saveModeFolderName') }}</button>
                  <button
                    type="button"
                    class="seg__btn"
                    :class="{ 'seg__btn--active': !saveAsFolder }"
                    :disabled="isRunModeLocked"
                    @click="saveAsFolder = false"
                  >{{ t('separate.saveModeFlatName') }}</button>
                </div>
              </div>
            </div>

            <div v-if="runMode === 'model'" class="ofield ofield--stems">
              <span class="ofield__label">{{ t('separate.outputStems') }}</span>
              <div v-if="availableStemNames.length" class="stem-chips">
                <n-checkbox-group v-model:value="checkedOutputStems" :disabled="isRunModeLocked">
                  <n-checkbox
                    v-for="stem in availableStemNames"
                    :key="stem"
                    :value="stem"
                    :label="stem"
                  />
                </n-checkbox-group>
              </div>
              <div v-else class="ofield__static ofield__static--muted">{{ t('separate.allStems') }}</div>
            </div>
          </div>
        </section>
      </aside>

      <main class="console__stage">
        <transition name="stage-swap" mode="out-in">
          <section v-if="taskPanelState === 'running' && currentTask" key="running" class="stage-view stage-view--running">
            <div class="stage-hero">
              <div class="stage-hero__top">
                <span class="stage-badge stage-badge--running">
                  <span class="stage-badge__dot"></span>
                  {{ statusLabel(currentTask.status) }}
                </span>
                <n-button text size="small" :disabled="!currentTask.logs.length" @click="openCurrentLogs">
                  <template #icon><n-icon :component="TerminalOutline" /></template>
                  {{ t('tasks.logs') }}
                </n-button>
              </div>
              <div class="stage-hero__title">
                <h2>{{ currentBatchTitle }}</h2>
                <p>{{ currentBatchLine }}</p>
              </div>
              <div class="progress-ring-block">
                <div class="progress-ring" :style="{ '--pct': currentBatchProgress }">
                  <div class="progress-ring__center">
                    <strong>{{ currentBatchProgress }}</strong>
                    <span>%</span>
                  </div>
                </div>
                <div class="progress-ring__meta">
                  <div class="progress-meta-line">
                    <span class="progress-meta-line__label">
                      {{ currentBatchIsMulti ? t('separate.batchOverallProgress') : progressTitle(currentTask) }}
                    </span>
                    <span v-if="!currentBatchIsMulti && progressDetail(currentTask)" class="progress-meta-line__detail">{{ progressDetail(currentTask) }}</span>
                  </div>
                  <p v-if="taskSubMessage(currentTask)" class="progress-submessage">{{ taskSubMessage(currentTask) }}</p>
                  <div class="progress-facts">
                    <span><n-icon :component="TimeOutline" /> {{ currentTaskDuration }}</span>
                    <span :title="currentTaskOutputPath">{{ t('separate.outputTo') }} {{ currentTaskOutputSummary }}</span>
                  </div>
                </div>
              </div>
            </div>
            <div class="stage-actions">
              <n-button
                strong
                size="large"
                type="error"
                secondary
                class="stage-actions__primary"
                :loading="cancellingTaskId === currentTask.id || cancellingTaskId === 'batch'"
                :disabled="cancellingTaskId === currentTask.id || cancellingTaskId === 'batch'"
                @click="handleCancelCurrentTask"
              >
                {{ t('tasks.cancelAction') }}
              </n-button>
            </div>
          </section>

          <section v-else-if="isTerminalState && currentTask" key="terminal" :class="['stage-view', 'stage-view--terminal', `stage-view--${taskPanelState}`]">
            <div class="stage-hero stage-hero--result">
              <div class="stage-hero__top">
                <span class="stage-badge" :class="`stage-badge--${taskPanelState}`">
                  <n-icon :component="taskPanelState === 'done' ? CheckmarkCircle : (taskPanelState === 'failed' ? CloseOutline : PauseOutline)" />
                  {{ statusLabel(currentTask.status) }}
                </span>
                <n-button v-if="currentTask.logs.length" text size="small" @click="openCurrentLogs">
                  <template #icon><n-icon :component="TerminalOutline" /></template>
                  {{ t('tasks.logs') }}
                </n-button>
              </div>
              <div class="stage-hero__title">
                <h2>{{ currentBatchIsMulti ? currentBatchTitle : statusLabel(currentTask.status) }}</h2>
                <p>
                  {{ currentBatchLine }}
                  <template v-if="taskPanelState === 'done' && !currentBatchIsMulti"> · {{ currentTask.outputs.length }} {{ t('separate.previewStemUnit') }} · {{ currentTaskDuration }}</template>
                </p>
              </div>
              <div v-if="taskPanelState === 'done'" class="result-path" :title="currentTaskOutputPath">
                <n-icon :component="FolderOutline" />
                <code>{{ currentBatchOutputSummary }}</code>
              </div>
              <div v-else-if="taskSubMessage(currentTask)" class="result-note">{{ taskSubMessage(currentTask) }}</div>
            </div>
            <div class="stage-actions">
              <n-button v-if="taskPanelState === 'done'" secondary size="large" @click="task.revealPath(currentJob?.output || currentTask.output)">
                <template #icon><n-icon :component="OpenOutline" /></template>
                {{ t('separate.openOutput') }}
              </n-button>
              <n-button secondary size="large" @click="retryCurrentTask">
                <template #icon><n-icon :component="PlayOutline" /></template>
                {{ t('common.retry') }}
              </n-button>
              <n-button secondary size="large" @click="resetForNextSeparation">
                {{ t('separate.newSeparation') }}
              </n-button>
              <n-button v-if="taskPanelState === 'done'" type="primary" size="large" class="stage-actions__primary" @click="goToResults">
                {{ t('separate.viewResults') }}
              </n-button>
            </div>
          </section>

          <section v-else key="ready" class="stage-view stage-view--ready">
            <div class="stage-head">
              <div class="stage-head__label">
                <n-icon :component="runMode === 'workflow' ? GitNetworkOutline : CubeOutline" />
                <div>
                  <h2>{{ t('separate.runTarget') }}</h2>
                  <p>{{ runMode === 'workflow' ? t('separate.workflowPanelHint') : t('separate.modelPanelHint') }}</p>
                </div>
              </div>
            </div>

            <transition name="stage-swap" mode="out-in">
              <div v-if="runMode === 'model'" key="model" class="target-pane">
                <template v-if="downloadedModels.length">
                  <div class="target-toolbar">
                    <n-input
                      v-model:value="modelSearch"
                      clearable
                      :placeholder="t('separate.modelSearchPlaceholder')"
                    >
                      <template #prefix><n-icon :component="SearchOutline" /></template>
                    </n-input>
                    <n-select
                      class="target-toolbar__filter"
                      v-model:value="modelCategoryFilter"
                      :menu-props="{ class: 'model-picker__category-menu' }"
                      :options="modelCategoryOptions"
                    />
                  </div>
                  <div v-if="filteredDownloadedModels.length" class="target-list" role="listbox" :aria-label="t('separate.model')">
                    <button
                      v-for="item in filteredDownloadedModels"
                      :key="item.name"
                      type="button"
                      role="option"
                      :aria-selected="selectedModelName === item.name"
                      class="target-row"
                      :class="{ 'target-row--active': selectedModelName === item.name }"
                      @click="handleSelectModel(item)"
                    >
                      <span class="target-row__radio"></span>
                      <span class="target-row__body">
                        <span class="target-row__name" :title="item.name">{{ item.name }}</span>
                        <span class="target-row__meta">
                          <span class="target-row__tag" :title="categoryLabel(item)">{{ categoryLabel(item) }}</span>
                          <span class="target-row__desc" :title="modelMetaLine(item)">{{ modelMetaLine(item) }}</span>
                        </span>
                      </span>
                      <n-icon v-if="selectedModelName === item.name" class="target-row__check" :component="CheckmarkCircle" />
                    </button>
                  </div>
                  <div v-else class="stage-empty">
                    <div class="stage-empty__glyph"><n-icon :component="SearchOutline" /></div>
                    <strong>{{ t('separate.modelSearchEmpty') }}</strong>
                  </div>
                  <div v-if="selectedModelName && !modelDownloaded" class="stage-alert">
                    {{ t('separate.startHintModelMissing') }}
                  </div>
                </template>
                <div v-else class="stage-empty" :class="{ 'stage-empty--loading': isLoading }">
                  <div class="stage-empty__glyph">
                    <n-spin v-if="isLoading" size="medium" />
                    <n-icon v-else :component="CubeOutline" />
                  </div>
                  <strong>{{ isLoading ? t('separate.modelPanelLoadingTitle') : t('separate.modelPanelEmptyTitle') }}</strong>
                  <p>{{ isLoading ? t('separate.modelPanelLoadingDesc') : t('separate.modelPanelEmptyDesc') }}</p>
                  <n-button secondary :loading="isLoading" @click="model.loadModels()">
                    {{ t('separate.modelPanelPrimaryAction') }}
                  </n-button>
                </div>
              </div>

              <div v-else key="workflow" class="target-pane">
                <div class="target-toolbar target-toolbar--single">
                  <n-input
                    v-model:value="workflowSearch"
                    clearable
                    :placeholder="t('separate.workflowSearchPlaceholder')"
                  >
                    <template #prefix><n-icon :component="SearchOutline" /></template>
                  </n-input>
                </div>
                <div v-if="filteredWorkflows.length" class="target-list" role="listbox" :aria-label="t('separate.workflow')">
                  <button
                    v-for="item in filteredWorkflows"
                    :key="item.id"
                    type="button"
                    role="option"
                    :aria-selected="selectedWorkflowId === item.id"
                    class="target-row"
                    :class="{ 'target-row--active': selectedWorkflowId === item.id }"
                    @click="workflow.selectWorkflow(item.id)"
                  >
                    <span class="target-row__radio"></span>
                    <span class="target-row__body">
                      <span class="target-row__name" :title="item.name">{{ item.name }}</span>
                      <span class="target-row__meta">
                        <span class="target-row__tag">{{ t('separate.workflow') }}</span>
                        <span class="target-row__desc" :title="item.description">{{ item.description || t('separate.workflowNoDescription') }}</span>
                      </span>
                    </span>
                    <n-icon v-if="selectedWorkflowId === item.id" class="target-row__check" :component="CheckmarkCircle" />
                  </button>
                </div>
                <div v-else class="stage-empty">
                  <div class="stage-empty__glyph"><n-icon :component="GitNetworkOutline" /></div>
                  <strong>{{ t('separate.workflowEmptyTitle') }}</strong>
                  <p>{{ t('separate.workflowEmptyDesc') }}</p>
                  <n-button secondary @click="router.push('/workflows')">
                    {{ t('separate.workflowCreateAction') }}
                  </n-button>
                </div>
              </div>
            </transition>

            <footer class="launch-bar" :class="`launch-bar--${canStart ? 'ready' : 'idle'}`">
              <div class="launch-bar__status">
                <span class="launch-bar__glyph"><n-icon :component="CheckmarkCircle" /></span>
                <div class="launch-bar__text">
                  <strong>{{ startStatusText }}</strong>
                  <span :title="outputPreview">{{ outputSummaryPath }}</span>
                </div>
              </div>
              <div class="launch-bar__actions">
                <n-button quaternary class="launch-bar__reveal" :title="t('separate.openOutput')" @click="task.revealPath(normalizedOutputDir)">
                  <template #icon><n-icon :component="OpenOutline" /></template>
                  {{ t('separate.openOutput') }}
                </n-button>
                <n-button type="primary" size="large" class="launch-bar__go" :disabled="!canStart" @click="start">
                  <template #icon><n-icon :component="PlayOutline" /></template>
                  {{ t('separate.startTask') }}
                </n-button>
              </div>
            </footer>
          </section>
        </transition>
      </main>
    </div>

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
              <n-grid-item v-if="effectiveFormat === 'wav'">
                <div class="field-block">
                  <label>{{ t('audio.wavBitDepth') }}</label>
                  <n-select v-model:value="settings.wavBitDepth" :options="wavBitDepthOptions" />
                </div>
              </n-grid-item>
              <n-grid-item v-if="effectiveFormat === 'flac'">
                <div class="field-block">
                  <label>{{ t('audio.flacBitDepth') }}</label>
                  <n-select v-model:value="settings.flacBitDepth" :options="flacBitDepthOptions" />
                </div>
              </n-grid-item>
              <n-grid-item v-if="effectiveFormat === 'mp3'">
                <div class="field-block">
                  <label>{{ t('audio.mp3BitRate') }}</label>
                  <n-select v-model:value="settings.mp3BitRate" :options="bitRateOptions" />
                </div>
              </n-grid-item>
              <n-grid-item v-if="effectiveFormat === 'm4a'">
                <div class="field-block">
                  <label>{{ t('audio.m4aBitRate') }}</label>
                  <n-select v-model:value="settings.m4aBitRate" :options="bitRateOptions" />
                </div>
              </n-grid-item>
              <n-grid-item v-if="effectiveFormat === 'm4a'">
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
/* ============ Workstation shell ============ */
.separate-page {
  max-width: 1140px;
  margin: 0 auto;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.console-topbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}

.console-topbar__brand {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.console-topbar__brand :deep(.app-brand-mark) {
  transform-origin: center center;
}

.console-topbar__title {
  display: grid;
  gap: 1px;
  min-width: 0;
}

.console-topbar__title h1 {
  margin: 0;
  font-size: 19px;
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1.15;
}

.console-topbar__title span {
  font-size: 12px;
  color: var(--on-surface-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.console-topbar__controls {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.console-topbar__manage {
  color: color-mix(in srgb, var(--on-surface-muted) 84%, var(--on-surface));
  white-space: nowrap;
  font-size: 12px;
}

/* segmented mode switch */
.mode-switch {
  display: inline-flex;
  padding: 3px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 60%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--outline) 90%, transparent);
}

.mode-switch :deep(.n-radio-button) {
  height: 30px;
  line-height: 30px;
  padding: 0 16px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  font-size: 12.5px;
  color: var(--on-surface-muted);
  transition: color 160ms ease, background 200ms ease, box-shadow 200ms ease;
}

.mode-switch :deep(.n-radio-group__splitor) { display: none; }
.mode-switch :deep(.n-radio-button__state-border) { display: none; }

.mode-switch :deep(.n-radio-button--checked) {
  color: var(--on-surface);
  background: color-mix(in srgb, var(--surface) 70%, var(--surface-1));
  box-shadow:
    0 1px 2px rgba(0,0,0,0.28),
    inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 40%, transparent);
}

/* ============ Console grid: rail + stage ============ */
.console {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(420px, 480px) minmax(0, 1fr);
  gap: 16px;
}

.console__rail {
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 12px;
}

.console__stage {
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* ============ Rail cards ============ */
.rail-card {
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 12px;
  padding: 15px 16px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--surface-1) 78%, transparent);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--outline) 80%, transparent),
    inset 0 1px 0 rgba(255,255,255,0.03);
}

.rail-card--output {
  grid-template-rows: auto auto;
}

.rail-card__head {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
}

.rail-card__index {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--primary-strong);
  background: var(--primary-soft);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 40%, transparent);
}

.rail-card__label {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 1px;
}

.rail-card__label strong {
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.rail-card__label small {
  font-size: 11px;
  color: var(--on-surface-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rail-card__clear {
  color: var(--danger);
  font-size: 11px;
}

.rail-card__more {
  color: var(--on-surface-muted);
  font-size: 11px;
}

.rail-card__body {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* pick buttons */
.picker-buttons {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.picker-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 36px;
  border: 0;
  border-radius: 11px;
  background: color-mix(in srgb, var(--surface-2) 62%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--outline) 88%, transparent);
  color: var(--on-surface);
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
  transition: background 150ms ease, box-shadow 150ms ease, transform 120ms ease;
}

.picker-btn .n-icon { font-size: 15px; color: var(--primary-strong); }
.picker-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--primary-soft) 26%, var(--surface-2));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 52%, transparent);
}
.picker-btn:active:not(:disabled) { transform: translateY(1px); }
.picker-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* dropzone / file list */
.dropzone {
  flex: 1 1 auto;
  min-height: 0;
  border-radius: 13px;
  border: 1px dashed color-mix(in srgb, var(--outline) 130%, transparent);
  background: color-mix(in srgb, var(--surface) 40%, transparent);
  transition: border-color 150ms ease, background 150ms ease, box-shadow 150ms ease;
  overflow: hidden;
}

.dropzone--filled {
  border-style: solid;
  border-color: color-mix(in srgb, var(--outline) 90%, transparent);
}

.dropzone--dragging {
  border-color: var(--primary);
  background: color-mix(in srgb, var(--primary-soft) 18%, var(--surface-1));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 60%, transparent);
}

.dropzone--clickable { cursor: pointer; }
.dropzone--clickable:hover {
  border-color: color-mix(in srgb, var(--primary) 70%, var(--outline));
  background: color-mix(in srgb, var(--primary-soft) 12%, var(--surface));
}
.dropzone--clickable:hover .dropzone__glyph {
  color: var(--primary);
  background: color-mix(in srgb, var(--primary-soft) 46%, var(--surface-2));
}

.file-list {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--outline) 120%, transparent) transparent;
}
.file-list::-webkit-scrollbar { width: 6px; }
.file-list::-webkit-scrollbar-thumb { border-radius: 999px; background: color-mix(in srgb, var(--outline) 130%, transparent); }
.file-list::-webkit-scrollbar-track { background: transparent; }

.file-chip {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 8px 7px 9px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-2) 50%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--outline) 76%, transparent);
}

.file-chip__glyph {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  font-size: 14px;
  color: var(--primary-strong);
  background: var(--primary-soft);
}

.file-chip__main {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 3px;
}

.file-chip__main strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 600;
}

.file-chip__sub {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
}

.file-chip__sub code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--on-surface-muted);
}

.file-chip__kind {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  color: color-mix(in srgb, var(--primary-strong) 76%, var(--on-surface-muted));
  background: color-mix(in srgb, var(--primary-soft) 30%, var(--surface-2));
}

.file-chip__remove { flex: 0 0 auto; color: var(--on-surface-muted); }

.dropzone__empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 18px;
  text-align: center;
}

.dropzone__glyph {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 13px;
  font-size: 21px;
  color: var(--primary-strong);
  background: color-mix(in srgb, var(--primary-soft) 34%, var(--surface-2));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 30%, transparent);
  margin-bottom: 2px;
}

.dropzone__empty strong { font-size: 13px; color: var(--on-surface-muted); font-weight: 500; max-width: 240px; }

/* output fields */
.rail-card__body--output { gap: 12px; }

.ofield { display: grid; gap: 6px; min-width: 0; }

.ofield__label {
  font-size: 11px;
  color: var(--on-surface-muted);
  font-weight: 500;
}

.ofield__static {
  min-height: 30px;
  display: flex;
  align-items: center;
  padding: 0 11px;
  border-radius: 9px;
  font-size: 12.5px;
  font-weight: 600;
  background: color-mix(in srgb, var(--surface-2) 56%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--outline) 80%, transparent);
}
.ofield__static--muted { font-weight: 400; color: var(--on-surface-muted); }

.ofield-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
  align-items: start;
}

.dir-input {
  display: flex;
  gap: 8px;
}
.dir-input .n-input { flex: 1 1 auto; min-width: 0; }
.dir-input__browse { flex: 0 0 auto; }

/* save-mode segmented control */
.seg {
  display: inline-flex;
  width: 100%;
  padding: 2px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--surface-2) 46%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--outline) 82%, transparent);
}
.seg--locked { opacity: 0.55; pointer-events: none; }

.seg__btn {
  flex: 1 1 0;
  min-width: 0;
  height: 28px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--on-surface-muted);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: color 140ms ease, background 180ms ease, box-shadow 180ms ease;
}
.seg__btn--active {
  color: var(--on-surface);
  background: color-mix(in srgb, var(--surface) 72%, var(--surface-1));
  box-shadow:
    0 1px 2px rgba(0,0,0,0.24),
    inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 38%, transparent);
}

.ofield--stems .stem-chips {
  max-height: 108px;
  overflow-y: auto;
  padding: 2px 2px 2px 0;
  overscroll-behavior: contain;
}

.stem-chips :deep(.n-checkbox-group) {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.stem-chips :deep(.n-checkbox) {
  min-height: 28px;
  align-items: center;
  padding: 4px 10px 4px 8px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--surface-2) 52%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--outline) 78%, transparent);
  font-size: 12px;
  transition: background 140ms ease, box-shadow 140ms ease;
}
.stem-chips :deep(.n-checkbox:hover) {
  background: color-mix(in srgb, var(--primary-soft) 22%, var(--surface-2));
}
.stem-chips :deep(.n-checkbox--checked) {
  background: color-mix(in srgb, var(--primary-soft) 34%, var(--surface-2));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 60%, transparent);
}

/* ============ Launch bar (stage bottom) ============ */
.launch-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  border-radius: 15px;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--primary-soft) 12%, transparent), transparent),
    color-mix(in srgb, var(--surface-2) 34%, transparent);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--outline) 84%, transparent),
    inset 0 1px 0 rgba(255,255,255,0.04);
}
.launch-bar--ready {
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--success) 30%, transparent),
    inset 0 1px 0 rgba(255,255,255,0.04);
}

.launch-bar__status {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 11px;
}

.launch-bar__glyph {
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  font-size: 19px;
  color: var(--success);
  background: color-mix(in srgb, var(--success) 14%, var(--surface-2));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--success) 32%, transparent);
}
.launch-bar--idle .launch-bar__glyph {
  color: var(--on-surface-muted);
  background: color-mix(in srgb, var(--surface-2) 60%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--outline) 80%, transparent);
}

.launch-bar__text {
  min-width: 0;
  display: grid;
  gap: 1px;
}

.launch-bar__text strong {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.launch-bar--idle .launch-bar__text strong { color: var(--on-surface-muted); }

.launch-bar__text span {
  font-size: 11px;
  color: var(--on-surface-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.launch-bar__actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

.launch-bar__reveal { color: var(--on-surface-muted); }

.launch-bar__go {
  min-width: 156px;
  font-weight: 600;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.2),
    0 12px 28px color-mix(in srgb, var(--primary-glow) 42%, transparent);
}

/* ============ Stage ============ */
.stage-view {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
  border-radius: 20px;
  background:
    radial-gradient(120% 90% at 50% -10%, color-mix(in srgb, var(--primary-glow) 10%, transparent), transparent 60%),
    color-mix(in srgb, var(--surface-1) 74%, transparent);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--outline) 76%, transparent),
    inset 0 1px 0 rgba(255,255,255,0.03);
}

.stage-view--running {
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 48%, transparent),
    0 0 0 1px color-mix(in srgb, var(--primary-glow) 16%, transparent);
}
.stage-view--done { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--success) 40%, transparent); }
.stage-view--failed { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 40%, transparent); }
.stage-view--cancelled { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--warning) 40%, transparent); }

.stage-swap-enter-active { transition: opacity 260ms cubic-bezier(0.22,1,0.36,1), transform 300ms cubic-bezier(0.22,1,0.36,1); }
.stage-swap-leave-active { transition: opacity 160ms ease, transform 160ms ease; }
.stage-swap-enter-from { opacity: 0; transform: translateY(10px) scale(0.99); }
.stage-swap-leave-to { opacity: 0; transform: translateY(-6px) scale(0.995); }

/* stage: ready target selection */
.stage-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.stage-head__label {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.stage-head__label > .n-icon {
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  font-size: 19px;
  color: var(--primary-strong);
  background: color-mix(in srgb, var(--primary-soft) 40%, var(--surface-2));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 34%, transparent);
}

.stage-head__label h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.stage-head__label p {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--on-surface-muted);
  line-height: 1.4;
}

.target-pane {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.target-toolbar {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 190px;
  gap: 10px;
}
.target-toolbar--single { grid-template-columns: minmax(0, 1fr); }
.target-toolbar__filter { min-width: 0; }

.target-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 2px;
  padding-right: 6px;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--outline) 120%, transparent) transparent;
}
.target-list::-webkit-scrollbar { width: 7px; }
.target-list::-webkit-scrollbar-thumb { border-radius: 999px; background: color-mix(in srgb, var(--outline) 130%, transparent); }
.target-list::-webkit-scrollbar-track { background: transparent; }

.target-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 11px 14px;
  border-radius: 12px;
  border: 0;
  text-align: left;
  cursor: pointer;
  background: color-mix(in srgb, var(--surface-2) 38%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--outline) 78%, transparent);
  transition: background 150ms ease, box-shadow 150ms ease;
  font-family: inherit;
  color: inherit;
}

.target-row:hover {
  background: color-mix(in srgb, var(--surface-2) 62%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 40%, transparent);
}

.target-row--active {
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--primary-soft) 42%, transparent), color-mix(in srgb, var(--surface-2) 52%, transparent) 60%);
  box-shadow:
    inset 0 0 0 1.5px color-mix(in srgb, var(--primary) 54%, transparent),
    0 8px 22px color-mix(in srgb, var(--primary-glow) 18%, transparent);
}

.target-row__radio {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--on-surface-muted) 60%, transparent);
  transition: box-shadow 150ms ease, background 150ms ease;
}
.target-row--active .target-row__radio {
  background: var(--primary);
  box-shadow:
    inset 0 0 0 1.5px var(--primary),
    inset 0 0 0 4px var(--surface-1);
}

.target-row__body {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 3px;
}

.target-row__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.target-row--active .target-row__name { color: var(--primary-strong); }

.target-row__meta {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.target-row__tag {
  flex: 0 0 auto;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 10px;
  color: color-mix(in srgb, var(--primary-strong) 74%, var(--on-surface-muted));
  background: color-mix(in srgb, var(--primary-soft) 26%, var(--surface-2));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 26%, transparent);
}

.target-row__desc {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--on-surface-muted);
  line-height: 1.4;
}

.target-row__check { flex: 0 0 auto; font-size: 18px; color: var(--primary); }

.stage-empty {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-align: center;
  padding: 32px;
}

.stage-empty__glyph {
  width: 56px;
  height: 56px;
  display: grid;
  place-items: center;
  border-radius: 16px;
  font-size: 26px;
  color: var(--primary-strong);
  background: color-mix(in srgb, var(--primary-soft) 30%, var(--surface-2));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 26%, transparent);
  margin-bottom: 4px;
}

.stage-empty strong { font-size: 14px; }
.stage-empty p { margin: 0; font-size: 12px; color: var(--on-surface-muted); line-height: 1.5; max-width: 320px; }
.stage-empty .n-button { margin-top: 8px; }

.stage-alert {
  flex: 0 0 auto;
  padding: 11px 13px;
  border-radius: 12px;
  font-size: 12px;
  line-height: 1.5;
  color: color-mix(in srgb, var(--warning) 78%, var(--on-surface));
  background: color-mix(in srgb, var(--warning) 12%, var(--surface-2));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--warning) 34%, transparent);
}

/* stage: hero (running + terminal) */
.stage-hero {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.stage-hero__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.stage-badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 12px 5px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.stage-badge .n-icon { font-size: 14px; }

.stage-badge--running {
  color: var(--primary-strong);
  background: var(--primary-soft);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 50%, transparent);
}
.stage-badge--done {
  color: color-mix(in srgb, var(--success) 84%, var(--on-surface));
  background: color-mix(in srgb, var(--success) 14%, var(--surface-2));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--success) 40%, transparent);
}
.stage-badge--failed {
  color: color-mix(in srgb, var(--danger) 84%, var(--on-surface));
  background: color-mix(in srgb, var(--danger) 14%, var(--surface-2));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 40%, transparent);
}
.stage-badge--cancelled {
  color: color-mix(in srgb, var(--warning) 84%, var(--on-surface));
  background: color-mix(in srgb, var(--warning) 14%, var(--surface-2));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--warning) 40%, transparent);
}

.stage-badge__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--primary);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--primary) 60%, transparent);
  animation: pulse-dot 1.6s ease-out infinite;
}

@keyframes pulse-dot {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--primary) 55%, transparent); }
  70% { box-shadow: 0 0 0 7px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}

.stage-hero__title h2 {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1.15;
}

.stage-hero__title p {
  margin: 5px 0 0;
  font-size: 13px;
  color: var(--on-surface-muted);
  line-height: 1.45;
}

/* progress ring */
.progress-ring-block {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  gap: 28px;
  padding: 8px 0;
}

.progress-ring {
  --pct: 0;
  flex: 0 0 auto;
  width: 148px;
  height: 148px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background:
    radial-gradient(closest-side, var(--surface-1) 74%, transparent 75% 100%),
    conic-gradient(
      var(--primary) calc(var(--pct) * 1%),
      color-mix(in srgb, var(--outline) 130%, transparent) 0
    );
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--outline) 60%, transparent);
  transition: background 500ms cubic-bezier(0.22,1,0.36,1);
}

.progress-ring__center {
  display: flex;
  align-items: baseline;
  gap: 2px;
  color: var(--on-surface);
}
.progress-ring__center strong {
  font-size: 40px;
  font-weight: 600;
  letter-spacing: -0.04em;
  font-variant-numeric: tabular-nums;
}
.progress-ring__center span { font-size: 16px; color: var(--on-surface-muted); }

.progress-ring__meta {
  flex: 1 1 auto;
  min-width: 0;
  display: grid;
  gap: 10px;
  align-content: center;
}

.progress-meta-line {
  display: grid;
  gap: 2px;
}
.progress-meta-line__label { font-size: 13px; font-weight: 600; }
.progress-meta-line__detail { font-size: 12px; color: var(--on-surface-muted); }

.progress-submessage {
  margin: 0;
  font-size: 12px;
  color: var(--on-surface-muted);
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.progress-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  padding-top: 4px;
  border-top: 1px solid color-mix(in srgb, var(--outline) 70%, transparent);
}
.progress-facts span {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--on-surface-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.progress-facts .n-icon { flex: 0 0 auto; }

/* result path / note */
.stage-hero--result { justify-content: flex-start; gap: 14px; }

.result-path {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 14px;
  border-radius: 13px;
  background: color-mix(in srgb, var(--surface-2) 40%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--outline) 80%, transparent);
}
.result-path .n-icon { flex: 0 0 auto; font-size: 16px; color: var(--primary-strong); }
.result-path code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: color-mix(in srgb, var(--on-surface) 88%, var(--on-surface-muted));
}

.result-note {
  padding: 12px 14px;
  border-radius: 13px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--on-surface-muted);
  background: color-mix(in srgb, var(--surface-2) 34%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--outline) 76%, transparent);
}

/* stage action bar */
.stage-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px;
  padding-top: 4px;
}
.stage-actions__primary { min-width: 150px; font-weight: 600; }
.stage-view--running .stage-actions { justify-content: flex-end; }


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

.summary-static-value {
  min-height: 34px;
  display: flex;
  align-items: center;
  padding: 0 12px;
  border: 1px solid color-mix(in srgb, var(--outline) 46%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 64%, transparent);
  color: var(--on-surface);
  font-size: 13px;
  font-weight: 700;
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

/* ============ Responsive ============ */
@media (max-width: 1180px) {
  .console {
    grid-template-columns: minmax(380px, 440px) minmax(0, 1fr);
  }
}

@media (max-width: 1000px) {
  .separate-page {
    height: auto;
  }
  .console {
    grid-template-columns: minmax(0, 1fr);
  }
  .console__rail {
    grid-template-rows: none;
    grid-auto-rows: auto;
  }
  .dropzone { min-height: 220px; }
  .stage-view { min-height: 440px; }
  .progress-ring-block { flex-direction: column; align-items: flex-start; gap: 18px; }
}

@media (max-width: 640px) {
  .console-topbar {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }
  .console-topbar__controls {
    justify-content: space-between;
  }
  .ofield-row {
    grid-template-columns: minmax(0, 1fr);
  }
  .launch-bar {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }
  .launch-bar__actions { justify-content: flex-end; }
  .launch-bar__go { flex: 1 1 auto; }
  .picker-buttons {
    grid-template-columns: 1fr;
  }
  .target-toolbar {
    grid-template-columns: minmax(0, 1fr);
  }
  .stage-actions { justify-content: stretch; }
  .stage-actions .n-button { flex: 1 1 160px; }
  .progress-ring { width: 120px; height: 120px; }
  .progress-ring__center strong { font-size: 32px; }
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

@media (prefers-reduced-motion: reduce) {
  .stage-swap-enter-active,
  .stage-swap-leave-active {
    transition: none;
  }
  .stage-badge__dot { animation: none; }
  .progress-ring { transition: none; }
  .console-topbar__brand:hover :deep(.app-brand-mark) {
    animation: none;
  }
}
</style>

