<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-shell'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import {
  AnalyticsOutline,
  CloudDownloadOutline,
  CloseCircleOutline,
  DocumentOutline,
  FolderOpenOutline,
  MusicalNoteOutline,
  RepeatOutline,
  SwapHorizontalOutline,
} from '@vicons/ionicons5'
import { useSettingsStore } from '@/stores/settings'
import AudioToolStatus from '@/components/tools/AudioToolStatus.vue'
import type {
  AudioToolKey,
  AudioToolLogEntry,
  AudioToolPhase,
  AudioToolProgress,
  AudioToolResult,
  AudioToolWarning,
} from '@/types/audioTools'
import { loadAppStore, saveAppStore } from '@/utils/appStore'

type WorkerEvent = {
  type: string
  payload?: {
    operation?: AudioToolKey
    completed?: number
    total?: number
    current?: string
    phase?: string
  }
}

type MergeSortBy = 'name' | 'modified' | 'regex'
type SortDirection = 'asc' | 'desc'
type MidiLanguage = '' | 'zh' | 'yue' | 'ja' | 'en'
type AudioToolActivityState = {
  progress: AudioToolProgress
  logs: AudioToolLogEntry[]
  elapsedMs: number
}

const MERGE_TOOL_ENABLED = false
const GAME_RELEASE_URL = 'https://github.com/openvpi/GAME/releases/tag/v1.0.0'
const MAX_ACTIVITY_LOGS = 100
const AUDIO_TOOL_PHASES = new Set<AudioToolPhase>([
  'preparing',
  'converting',
  'normalizing',
  'merging',
  'loading_reference',
  'loading_estimated',
  'calculating',
  'loading_model',
  'loading_audio',
  'transcribing',
  'writing_output',
])

function isAudioToolVisible(tool: AudioToolKey) {
  return tool !== 'merge' || MERGE_TOOL_ENABLED
}

type ScanAudioPathsResult = {
  files: string[]
  warnings: string[]
}

type StoredAudioToolsState = {
  activeTool?: AudioToolKey
  midiModelPath?: string
  midiLanguage?: MidiLanguage
  mergeSortBy?: MergeSortBy
  mergeSortDirection?: SortDirection
  mergeRegex?: string
}

const { t } = useI18n()
const message = useMessage()
const settings = useSettingsStore()

const activeTool = ref<AudioToolKey>('convert')
const busyTool = ref<AudioToolKey | null>(null)
const resultsByTool = ref<Partial<Record<AudioToolKey, AudioToolResult>>>({})
const errorsByTool = ref<Partial<Record<AudioToolKey, string>>>({})
const activityByTool = ref<Partial<Record<AudioToolKey, AudioToolActivityState>>>({})

const convertInputs = ref<string[]>([])
const convertOutputDir = ref('')
const convertFormat = ref('wav')
const convertSampleRate = ref(44100)
const convertChannels = ref(2)
const wavBitDepth = ref('PCM-24')
const flacBitDepth = ref('16-bit')
const mp3BitRate = ref('320k')
const oggBitRate = ref('320k')

const mergeInputDir = ref('')
const mergeOutputDir = ref('')
const mergeSortBy = ref<MergeSortBy>('name')
const mergeSortDirection = ref<SortDirection>('asc')
const mergeRegex = ref('(\\d+)')

const referencePath = ref('')
const estimatedPath = ref('')

const midiInputPath = ref('')
const midiModelPath = ref('')
const midiOutputDir = ref('')
const midiBpm = ref<number | null>(120)
const midiLanguage = ref<MidiLanguage>('')

let unlistenWorker: UnlistenFn | undefined
let stateRestored = false
let persistTimer: ReturnType<typeof setTimeout> | undefined
let persistQueue: Promise<void> = Promise.resolve()
let elapsedTimer: ReturnType<typeof setInterval> | undefined
let activityStartedAt = 0
let timedActivityTool: AudioToolKey | null = null
let activityLogSequence = 0

const formatOptions = computed(() => [
  { label: 'WAV', value: 'wav' },
  { label: 'FLAC', value: 'flac' },
  { label: 'MP3', value: 'mp3' },
  { label: 'OGG', value: 'ogg' },
])
const sampleRateOptions = [32000, 44100, 48000].map(value => ({ label: `${value} Hz`, value }))
const channelOptions = computed(() => [
  { label: t('tools.mono'), value: 1 },
  { label: t('tools.stereo'), value: 2 },
])
const wavBitDepthOptions = ['PCM-16', 'PCM-24', 'PCM-32'].map(value => ({ label: value, value }))
const flacBitDepthOptions = ['16-bit', '32-bit'].map(value => ({ label: value, value }))
const mp3BitRateOptions = ['192k', '256k', '320k'].map(value => ({ label: value, value }))
const oggBitRateOptions = ['192k', '256k', '320k', '450k'].map(value => ({ label: value, value }))
const midiLanguageOptions = computed(() => [
  { label: t('tools.midiLanguageAuto'), value: '' },
  { label: t('tools.midiLanguageChinese'), value: 'zh' },
  { label: t('tools.midiLanguageCantonese'), value: 'yue' },
  { label: t('tools.midiLanguageJapanese'), value: 'ja' },
  { label: t('tools.midiLanguageEnglish'), value: 'en' },
])
const mergeSortOptions = computed(() => [
  { label: t('tools.mergeSortName'), value: 'name' },
  { label: t('tools.mergeSortModified'), value: 'modified' },
  { label: t('tools.mergeSortRegex'), value: 'regex' },
])
const sortDirectionOptions = computed(() => [
  { label: t('tools.sortAscending'), value: 'asc' },
  { label: t('tools.sortDescending'), value: 'desc' },
])
const mergeRegexError = computed(() => {
  if (mergeSortBy.value !== 'regex') return ''
  return mergeRegex.value.trim() ? '' : t('tools.mergeRegexRequired')
})
const mergeOrderHint = computed(() => {
  if (mergeSortBy.value === 'modified') return t('tools.mergeModifiedHint')
  if (mergeSortBy.value === 'regex') return t('tools.mergeRegexHint')
  return t('tools.mergeNameHint')
})
const result = computed(() => resultsByTool.value[activeTool.value] || null)
const errorMessage = computed(() => errorsByTool.value[activeTool.value] || '')
const hasResult = computed(() => result.value?.operation === activeTool.value)
const activeActivity = computed(() => activityByTool.value[activeTool.value])
const progress = computed<AudioToolProgress>(() => activeActivity.value?.progress || {
  completed: 0,
  total: 0,
  current: '',
  phase: 'preparing',
})
const progressPercentage = computed(() => {
  if (!progress.value.total) return 0
  return Math.min(100, Math.round((progress.value.completed / progress.value.total) * 100))
})
const visibleActivityLogs = computed(() => activeActivity.value?.logs || [])
const visibleElapsedMs = computed(() => activeActivity.value?.elapsedMs || 0)
const midiBpmValid = computed(() => (
  typeof midiBpm.value === 'number'
  && Number.isFinite(midiBpm.value)
  && midiBpm.value >= 30
  && midiBpm.value <= 300
))
const midiInputLooksLikeAccompaniment = computed(() => (
  /(?:instrumental|accompaniment|no[_ -]?vocals?|伴奏|无人声)/i.test(fileName(midiInputPath.value))
))

function fileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

function initializeOutputDirectories() {
  const defaultDir = settings.outputDir.trim()
  if (!defaultDir) return
  if (!convertOutputDir.value) convertOutputDir.value = defaultDir
  if (!mergeOutputDir.value) mergeOutputDir.value = defaultDir
  if (!midiOutputDir.value) midiOutputDir.value = defaultDir
}

watch(() => settings.outputDir, initializeOutputDirectories, { immediate: true })

function normalizeAudioToolPhase(value: unknown): AudioToolPhase {
  const phase = String(value || '') as AudioToolPhase
  return AUDIO_TOOL_PHASES.has(phase) ? phase : 'preparing'
}

function toolLabel(tool: AudioToolKey | null) {
  if (tool === 'convert') return t('tools.convertTitle')
  if (tool === 'merge') return t('tools.mergeTitle')
  if (tool === 'sdr') return t('tools.sdrTitle')
  if (tool === 'midi') return t('tools.midiTitle')
  return t('tools.title')
}

function phaseDescription(tool: AudioToolKey, phase: AudioToolPhase) {
  const descriptions: Record<AudioToolPhase, string> = {
    started: t('tools.phaseDetailStarted', { tool: toolLabel(tool) }),
    preparing: t('tools.phaseDetailPreparing'),
    converting: t('tools.phaseDetailConverting'),
    normalizing: t('tools.phaseDetailNormalizing'),
    merging: t('tools.phaseDetailMerging'),
    loading_reference: t('tools.phaseDetailLoadingReference'),
    loading_estimated: t('tools.phaseDetailLoadingEstimated'),
    calculating: t('tools.phaseDetailCalculating'),
    loading_model: t('tools.phaseDetailLoadingModel'),
    loading_audio: t('tools.phaseDetailLoadingAudio'),
    transcribing: t('tools.phaseDetailTranscribing'),
    writing_output: t('tools.phaseDetailWritingOutput'),
    completed: t('tools.phaseDetailCompleted'),
    failed: t('tools.phaseDetailFailed'),
  }
  return descriptions[phase]
}

function appendActivityLog(
  tool: AudioToolKey,
  phase: AudioToolPhase,
  snapshot: AudioToolProgress,
  detail = '',
) {
  const activity = activityByTool.value[tool]
  if (!activity) return
  const timestamp = Date.now()
  activityLogSequence += 1
  const previous = activity.logs.map((entry, index) => (
    index === activity.logs.length - 1
      ? { ...entry, updatedAt: timestamp }
      : entry
  ))
  const next = [...previous, {
    id: activityLogSequence,
    timestamp,
    updatedAt: timestamp,
    phase,
    description: phaseDescription(tool, phase),
    completed: snapshot.completed,
    total: snapshot.total,
    current: snapshot.current,
    detail,
  }]
  activityByTool.value[tool] = {
    ...activity,
    logs: next.length > MAX_ACTIVITY_LOGS
      ? next.slice(next.length - MAX_ACTIVITY_LOGS)
      : next,
  }
}

function recordProgressLog(tool: AudioToolKey, snapshot: AudioToolProgress) {
  const activity = activityByTool.value[tool]
  if (!activity) return
  const lastIndex = activity.logs.length - 1
  const lastEntry = activity.logs[lastIndex]
  if (lastEntry?.phase === snapshot.phase) {
    activityByTool.value[tool] = {
      ...activity,
      progress: snapshot,
      logs: activity.logs.map((entry, index) => (
        index === lastIndex
          ? { ...entry, ...snapshot, updatedAt: Date.now() }
          : entry
      )),
    }
    return
  }
  activityByTool.value[tool] = { ...activity, progress: snapshot }
  appendActivityLog(tool, snapshot.phase, snapshot)
}

function stopElapsedTimer() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = undefined
  }
  if (timedActivityTool && activityStartedAt) {
    const activity = activityByTool.value[timedActivityTool]
    if (activity) {
      activityByTool.value[timedActivityTool] = {
        ...activity,
        elapsedMs: Date.now() - activityStartedAt,
      }
    }
  }
  activityStartedAt = 0
  timedActivityTool = null
}

function activityTarget(tool: AudioToolKey, payload: Record<string, unknown>) {
  if (tool === 'convert') {
    const inputs = Array.isArray(payload.inputs) ? payload.inputs : []
    return inputs.length ? fileName(String(inputs[0])) : ''
  }
  if (tool === 'merge') return String(payload.inputDir || '')
  if (tool === 'sdr') return fileName(String(payload.referencePath || ''))
  if (tool === 'midi') return fileName(String(payload.inputPath || ''))
  return ''
}

function beginActivity(tool: AudioToolKey, current: string) {
  stopElapsedTimer()
  const initialProgress: AudioToolProgress = {
    completed: 0,
    total: 0,
    current,
    phase: 'preparing',
  }
  activityByTool.value[tool] = {
    progress: initialProgress,
    logs: [],
    elapsedMs: 0,
  }
  activityStartedAt = Date.now()
  timedActivityTool = tool
  appendActivityLog(tool, 'started', initialProgress)
  elapsedTimer = setInterval(() => {
    const activity = activityByTool.value[tool]
    if (activity) {
      activityByTool.value[tool] = {
        ...activity,
        elapsedMs: Date.now() - activityStartedAt,
      }
    }
  }, 500)
}

function describeToolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes('Invalid worker event')) return message
  const output = message.match(/raw=(.*)$/s)?.[1]?.trim() || t('tools.unknownWorkerOutput')
  return t('tools.workerProtocolError', { output })
}

function warningText(warning: AudioToolWarning) {
  if (warning === 'no_notes_detected') return t('tools.midiWarningNoNotes')
  if (warning === 'stereo_downmix_fallback') return t('tools.midiWarningStereoFallback')
  return warning
}

function setToolResult(tool: AudioToolKey, value: AudioToolResult | null) {
  if (value) resultsByTool.value[tool] = value
  else delete resultsByTool.value[tool]
}

function setToolError(tool: AudioToolKey, value: string) {
  if (value) errorsByTool.value[tool] = value
  else delete errorsByTool.value[tool]
}

function persistAudioToolsState() {
  const snapshot: StoredAudioToolsState = {
    activeTool: activeTool.value,
    midiModelPath: midiModelPath.value,
    midiLanguage: midiLanguage.value,
    mergeSortBy: mergeSortBy.value,
    mergeSortDirection: mergeSortDirection.value,
    mergeRegex: mergeRegex.value,
  }
  const run = persistQueue.then(() => saveAppStore('audio-tools', snapshot))
  persistQueue = run.catch((error) => {
    console.warn('[audio-tools] state save failed', error)
  })
  return run
}

function queueAudioToolsStatePersist() {
  if (!stateRestored) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = undefined
    void persistAudioToolsState()
  }, 160)
}

watch(
  [activeTool, midiModelPath, midiLanguage, mergeSortBy, mergeSortDirection, mergeRegex],
  queueAudioToolsStatePersist,
)

function addConvertInputs(paths: string[]) {
  const current = new Set(convertInputs.value)
  const additions = paths.filter(path => path && !current.has(path))
  if (additions.length) convertInputs.value = [...convertInputs.value, ...additions]
  return additions.length
}

async function pickAudioFiles() {
  const paths = await invoke<string[]>('pick_audio_files')
  if (!paths?.length) return
  addConvertInputs(paths)
}

async function pickConvertFolder() {
  try {
    const folder = await invoke<string | null>('pick_input_folder')
    if (!folder) return
    const scan = await invoke<ScanAudioPathsResult>('scan_audio_paths_with_options', {
      paths: [folder],
      recursive: true,
      sortFiles: true,
    })
    const scannedFiles = scan.files || []
    const added = addConvertInputs(scannedFiles)
    if (added > 0) message.success(t('tools.folderScanned', { count: added }))
    else if (scannedFiles.length > 0) message.info(t('tools.folderAlreadyAdded'))
    else message.warning(t('tools.folderEmpty'))
    if (scan.warnings?.length) {
      message.warning(t('tools.folderScanWarnings', { count: scan.warnings.length }))
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

async function pickSingleAudio(target: 'reference' | 'estimated' | 'midi') {
  const path = await invoke<string | null>('pick_single_audio_file')
  if (!path) return
  if (target === 'reference') referencePath.value = path
  if (target === 'estimated') estimatedPath.value = path
  if (target === 'midi') midiInputPath.value = path
}

async function pickFolder(target: 'convert-output' | 'merge-input' | 'merge-output' | 'midi-output') {
  const command = target === 'merge-input' ? 'pick_input_folder' : 'pick_output_folder'
  const path = await invoke<string | null>(command)
  if (!path) return
  if (target === 'convert-output') convertOutputDir.value = path
  if (target === 'merge-input') mergeInputDir.value = path
  if (target === 'merge-output') mergeOutputDir.value = path
  if (target === 'midi-output') midiOutputDir.value = path
}

async function pickMidiModel() {
  const path = await invoke<string | null>('pick_model_weights_file', {
    title: t('tools.midiModelPickerTitle'),
  })
  if (!path) return
  if (!path.toLowerCase().endsWith('.pt')) {
    message.error(t('tools.midiModelExtensionError'))
    return
  }
  midiModelPath.value = path
}

async function openGameModelRelease() {
  try {
    if (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) {
      window.open(GAME_RELEASE_URL, '_blank', 'noopener,noreferrer')
      return
    }
    await open(GAME_RELEASE_URL)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

async function revealPath(path: string) {
  try {
    await invoke('reveal_path', { path })
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

async function executeTool(tool: AudioToolKey, payload: Record<string, unknown>) {
  if (busyTool.value) return
  busyTool.value = tool
  setToolResult(tool, null)
  setToolError(tool, '')
  beginActivity(tool, activityTarget(tool, payload))
  try {
    const response = await invoke<AudioToolResult>('run_audio_tool', {
      payload: { operation: tool, ...payload },
    })
    setToolResult(tool, response)
    const activity = activityByTool.value[tool]
    const completedProgress: AudioToolProgress = {
      completed: activity?.progress.total || 1,
      total: activity?.progress.total || 1,
      current: '',
      phase: 'completed',
    }
    if (activity) activityByTool.value[tool] = { ...activity, progress: completedProgress }
    const responseWarnings = (response.warnings || []).map(warningText)
    appendActivityLog(tool, 'completed', completedProgress, responseWarnings.join(' '))
    if (responseWarnings.length > 0) {
      message.warning(responseWarnings.join(' '))
    } else if ((response.failed?.length || 0) + (response.skipped?.length || 0) > 0) {
      message.warning(t('tools.completedWithSkipped'))
    } else {
      message.success(t('tools.completed'))
    }
  } catch (error) {
    const description = describeToolError(error)
    setToolError(tool, description)
    const activity = activityByTool.value[tool]
    const failedProgress: AudioToolProgress = {
      ...(activity?.progress || { completed: 0, total: 0, current: '' }),
      phase: 'failed',
    }
    if (activity) activityByTool.value[tool] = { ...activity, progress: failedProgress }
    appendActivityLog(tool, 'failed', failedProgress, description)
  } finally {
    stopElapsedTimer()
    busyTool.value = null
  }
}

function runConvert() {
  if (!convertInputs.value.length || !convertOutputDir.value) return
  void executeTool('convert', {
    inputs: convertInputs.value,
    outputDir: convertOutputDir.value,
    outputFormat: convertFormat.value,
    sampleRate: convertSampleRate.value,
    channels: convertChannels.value,
    wavBitDepth: wavBitDepth.value,
    flacBitDepth: flacBitDepth.value,
    mp3BitRate: mp3BitRate.value,
    oggBitRate: oggBitRate.value,
  })
}

function runMerge() {
  if (!mergeInputDir.value || !mergeOutputDir.value || mergeRegexError.value) return
  void executeTool('merge', {
    inputDir: mergeInputDir.value,
    outputDir: mergeOutputDir.value,
    sortBy: mergeSortBy.value,
    sortDirection: mergeSortDirection.value,
    regexPattern: mergeSortBy.value === 'regex' ? mergeRegex.value : '',
  })
}

function runSdr() {
  if (!referencePath.value || !estimatedPath.value) return
  void executeTool('sdr', {
    referencePath: referencePath.value,
    estimatedPath: estimatedPath.value,
  })
}

function runMidi() {
  const bpm = midiBpm.value
  if (
    !midiInputPath.value
    || !midiModelPath.value
    || !midiOutputDir.value
    || typeof bpm !== 'number'
    || !Number.isFinite(bpm)
    || bpm < 30
    || bpm > 300
  ) return
  void executeTool('midi', {
    inputPath: midiInputPath.value,
    modelPath: midiModelPath.value,
    outputDir: midiOutputDir.value,
    bpm,
    language: midiLanguage.value,
  })
}

onMounted(async () => {
  initializeOutputDirectories()
  try {
    const stored = await loadAppStore<StoredAudioToolsState>('audio-tools')
    if (
      stored?.activeTool
      && ['convert', 'merge', 'sdr', 'midi'].includes(stored.activeTool)
      && isAudioToolVisible(stored.activeTool)
    ) {
      activeTool.value = stored.activeTool
    }
    if (typeof stored?.midiModelPath === 'string' && stored.midiModelPath.toLowerCase().endsWith('.pt')) {
      midiModelPath.value = stored.midiModelPath
    }
    if (['', 'zh', 'yue', 'ja', 'en'].includes(stored?.midiLanguage || '')) {
      midiLanguage.value = stored?.midiLanguage || ''
    }
    if (stored?.mergeSortBy && ['name', 'modified', 'regex'].includes(stored.mergeSortBy)) {
      mergeSortBy.value = stored.mergeSortBy
    }
    if (stored?.mergeSortDirection && ['asc', 'desc'].includes(stored.mergeSortDirection)) {
      mergeSortDirection.value = stored.mergeSortDirection
    }
    if (typeof stored?.mergeRegex === 'string') {
      mergeRegex.value = stored.mergeRegex
    }
  } catch (error) {
    console.warn('[audio-tools] state restore failed', error)
  } finally {
    stateRestored = true
  }
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
  unlistenWorker = await listen<WorkerEvent>('pymss://worker-event', (event) => {
    const workerEvent = event.payload
    if (workerEvent.type !== 'audio_tool_progress') return
    const payload = workerEvent.payload
    if (!payload || payload.operation !== busyTool.value) return
    const snapshot: AudioToolProgress = {
      completed: Math.max(0, Number(payload.completed || 0)),
      total: Math.max(0, Number(payload.total || 0)),
      current: String(payload.current || ''),
      phase: normalizeAudioToolPhase(payload.phase),
    }
    recordProgressLog(payload.operation, snapshot)
  })
})

onUnmounted(() => {
  unlistenWorker?.()
  stopElapsedTimer()
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = undefined
    void persistAudioToolsState()
  }
})
</script>

<template>
  <div class="page tools-page">
    <div class="page-header-compact">
      <div>
        <h1>{{ t('tools.title') }}</h1>
        <p>{{ t('tools.subtitle') }}</p>
      </div>
    </div>

    <n-tabs v-model:value="activeTool" type="segment" :animated="false" class="tools-tabs">
      <n-tab-pane name="convert">
        <template #tab>
          <n-icon :component="SwapHorizontalOutline" />
          <span>{{ t('tools.convertTitle') }}</span>
        </template>
        <div class="tool-layout">
          <section class="tool-card tool-card--main">
            <div class="tool-card__header">
              <div class="tool-icon"><n-icon :component="SwapHorizontalOutline" /></div>
              <div>
                <h2>{{ t('tools.convertTitle') }}</h2>
                <p>{{ t('tools.convertDescription') }}</p>
              </div>
            </div>

            <div class="form-section">
              <div class="field-heading">
                <label>{{ t('tools.inputFiles') }}</label>
                <span>{{ t('tools.selectedCount', { count: convertInputs.length }) }}</span>
              </div>
              <div class="source-picker-grid">
                <button type="button" class="file-picker" :disabled="Boolean(busyTool)" @click="pickAudioFiles">
                  <n-icon :component="DocumentOutline" size="20" />
                  <span>{{ convertInputs.length ? t('tools.addFiles') : t('tools.chooseFiles') }}</span>
                </button>
                <button type="button" class="file-picker" :disabled="Boolean(busyTool)" @click="pickConvertFolder">
                  <n-icon :component="FolderOpenOutline" size="20" />
                  <span>{{ t('tools.addInputFolder') }}</span>
                </button>
              </div>
              <div v-if="convertInputs.length" class="selected-files">
                <div v-for="path in convertInputs" :key="path" class="selected-file">
                  <span :title="path">{{ fileName(path) }}</span>
                  <button
                    type="button"
                    :title="t('tools.removeFile')"
                    :disabled="Boolean(busyTool)"
                    @click="convertInputs = convertInputs.filter(item => item !== path)"
                  >
                    <n-icon :component="CloseCircleOutline" />
                  </button>
                </div>
              </div>
            </div>

            <div class="form-section">
              <label>{{ t('tools.outputDirectory') }}</label>
              <div class="path-field">
                <n-input :value="convertOutputDir" readonly :placeholder="t('tools.chooseOutputDirectory')" />
                <n-button secondary :disabled="Boolean(busyTool)" @click="pickFolder('convert-output')">
                  <template #icon><n-icon :component="FolderOpenOutline" /></template>
                  {{ t('common.browse') }}
                </n-button>
              </div>
            </div>

            <div class="form-grid form-grid--four">
              <div class="form-section">
                <label>{{ t('tools.outputFormat') }}</label>
                <n-select v-model:value="convertFormat" :options="formatOptions" :disabled="Boolean(busyTool)" />
              </div>
              <div class="form-section">
                <label>{{ t('tools.sampleRate') }}</label>
                <n-select v-model:value="convertSampleRate" :options="sampleRateOptions" :disabled="Boolean(busyTool)" />
              </div>
              <div class="form-section">
                <label>{{ t('tools.channels') }}</label>
                <n-select v-model:value="convertChannels" :options="channelOptions" :disabled="Boolean(busyTool)" />
              </div>
              <div class="form-section">
                <label>{{ t('tools.quality') }}</label>
                <n-select v-if="convertFormat === 'wav'" v-model:value="wavBitDepth" :options="wavBitDepthOptions" :disabled="Boolean(busyTool)" />
                <n-select v-else-if="convertFormat === 'flac'" v-model:value="flacBitDepth" :options="flacBitDepthOptions" :disabled="Boolean(busyTool)" />
                <n-select v-else-if="convertFormat === 'mp3'" v-model:value="mp3BitRate" :options="mp3BitRateOptions" :disabled="Boolean(busyTool)" />
                <n-select v-else v-model:value="oggBitRate" :options="oggBitRateOptions" :disabled="Boolean(busyTool)" />
              </div>
            </div>

            <div class="tool-actions">
              <n-button
                type="primary"
                :loading="busyTool === 'convert'"
                :disabled="Boolean(busyTool) || !convertInputs.length || !convertOutputDir"
                @click="runConvert"
              >
                {{ t('tools.startConvert') }}
              </n-button>
            </div>
          </section>
          <aside class="tool-card tool-card--side">
            <h3>{{ t('tools.processingStatus') }}</h3>
            <p>{{ t('tools.convertHint') }}</p>
            <AudioToolStatus
              :busy="busyTool === 'convert'"
              :has-result="hasResult"
              :error="errorMessage"
              :progress="progress"
              :percentage="progressPercentage"
              :result="result"
              :elapsed-ms="visibleElapsedMs"
              :logs="visibleActivityLogs"
              @reveal="revealPath"
            />
          </aside>
        </div>
      </n-tab-pane>

      <n-tab-pane v-if="MERGE_TOOL_ENABLED" name="merge">
        <template #tab>
          <n-icon :component="RepeatOutline" />
          <span>{{ t('tools.mergeTitle') }}</span>
        </template>
        <div class="tool-layout">
          <section class="tool-card tool-card--main tool-card--merge">
            <div class="tool-card__header">
              <div class="tool-icon"><n-icon :component="RepeatOutline" /></div>
              <div>
                <h2>{{ t('tools.mergeTitle') }}</h2>
                <p>{{ t('tools.mergeDescription') }}</p>
              </div>
            </div>
            <div class="form-grid form-grid--equal merge-path-grid">
              <div class="form-section">
                <label>{{ t('tools.inputDirectory') }}</label>
                <div class="path-field">
                  <n-input :value="mergeInputDir" readonly :placeholder="t('tools.chooseInputDirectory')" />
                  <n-button secondary :disabled="Boolean(busyTool)" @click="pickFolder('merge-input')">
                    <template #icon><n-icon :component="FolderOpenOutline" /></template>
                    {{ t('common.browse') }}
                  </n-button>
                </div>
              </div>
              <div class="form-section">
                <label>{{ t('tools.outputDirectory') }}</label>
                <div class="path-field">
                  <n-input :value="mergeOutputDir" readonly :placeholder="t('tools.chooseOutputDirectory')" />
                  <n-button secondary :disabled="Boolean(busyTool)" @click="pickFolder('merge-output')">
                    <template #icon><n-icon :component="FolderOpenOutline" /></template>
                    {{ t('common.browse') }}
                  </n-button>
                </div>
              </div>
            </div>
            <div class="merge-rules">
              <div class="merge-rules__heading">
                <strong>{{ t('tools.mergeRules') }}</strong>
                <span>{{ t('tools.mergeRulesScope') }}</span>
              </div>
              <div class="form-grid form-grid--equal">
                <div class="form-section">
                  <label>{{ t('tools.mergeSortBy') }}</label>
                  <n-select v-model:value="mergeSortBy" :options="mergeSortOptions" :disabled="Boolean(busyTool)" />
                </div>
                <div class="form-section">
                  <label>{{ t('tools.sortDirection') }}</label>
                  <n-select v-model:value="mergeSortDirection" :options="sortDirectionOptions" :disabled="Boolean(busyTool)" />
                </div>
              </div>
              <div v-if="mergeSortBy === 'regex'" class="form-section merge-regex-field">
                <label>{{ t('tools.mergeRegex') }}</label>
                <n-input
                  v-model:value="mergeRegex"
                  :placeholder="t('tools.mergeRegexPlaceholder')"
                  :status="mergeRegexError ? 'error' : undefined"
                  :disabled="Boolean(busyTool)"
                />
                <span class="field-hint" :class="{ 'field-hint--error': mergeRegexError }">
                  {{ mergeRegexError || t('tools.mergeRegexHelp') }}
                </span>
              </div>
              <p class="merge-order-summary">{{ mergeOrderHint }}</p>
            </div>
            <div class="tool-actions">
              <n-button
                type="primary"
                :loading="busyTool === 'merge'"
                :disabled="Boolean(busyTool) || !mergeInputDir || !mergeOutputDir || Boolean(mergeRegexError)"
                @click="runMerge"
              >
                {{ t('tools.startMerge') }}
              </n-button>
            </div>
          </section>
          <aside class="tool-card tool-card--side">
            <h3>{{ t('tools.processingStatus') }}</h3>
            <p>{{ t('tools.mergeHint') }}</p>
            <AudioToolStatus
              :busy="busyTool === 'merge'"
              :has-result="hasResult"
              :error="errorMessage"
              :progress="progress"
              :percentage="progressPercentage"
              :result="result"
              :elapsed-ms="visibleElapsedMs"
              :logs="visibleActivityLogs"
              @reveal="revealPath"
            />
          </aside>
        </div>
      </n-tab-pane>

      <n-tab-pane name="sdr">
        <template #tab>
          <n-icon :component="AnalyticsOutline" />
          <span>{{ t('tools.sdrTitle') }}</span>
        </template>
        <div class="tool-layout">
          <section class="tool-card tool-card--main">
            <div class="tool-card__header">
              <div class="tool-icon"><n-icon :component="AnalyticsOutline" /></div>
              <div>
                <h2>{{ t('tools.sdrTitle') }}</h2>
                <p>{{ t('tools.sdrDescription') }}</p>
              </div>
            </div>
            <div class="form-section">
              <label>{{ t('tools.referenceAudio') }}</label>
              <div class="path-field">
                <n-input :value="referencePath" readonly :placeholder="t('tools.chooseReferenceAudio')" />
                <n-button secondary :disabled="Boolean(busyTool)" @click="pickSingleAudio('reference')">
                  <template #icon><n-icon :component="DocumentOutline" /></template>
                  {{ t('common.browse') }}
                </n-button>
              </div>
            </div>
            <div class="form-section">
              <label>{{ t('tools.estimatedAudio') }}</label>
              <div class="path-field">
                <n-input :value="estimatedPath" readonly :placeholder="t('tools.chooseEstimatedAudio')" />
                <n-button secondary :disabled="Boolean(busyTool)" @click="pickSingleAudio('estimated')">
                  <template #icon><n-icon :component="DocumentOutline" /></template>
                  {{ t('common.browse') }}
                </n-button>
              </div>
            </div>
            <n-alert type="info" :bordered="false">{{ t('tools.sdrHint') }}</n-alert>
            <div class="tool-actions">
              <n-button
                type="primary"
                :loading="busyTool === 'sdr'"
                :disabled="Boolean(busyTool) || !referencePath || !estimatedPath"
                @click="runSdr"
              >
                {{ t('tools.startSdr') }}
              </n-button>
            </div>
          </section>
          <aside class="tool-card tool-card--side">
            <h3>{{ t('tools.analysisResult') }}</h3>
            <p>{{ t('tools.sdrResultHint') }}</p>
            <AudioToolStatus
              :busy="busyTool === 'sdr'"
              :has-result="hasResult"
              :error="errorMessage"
              :progress="progress"
              :percentage="progressPercentage"
              :result="result"
              :elapsed-ms="visibleElapsedMs"
              :logs="visibleActivityLogs"
              @reveal="revealPath"
            />
          </aside>
        </div>
      </n-tab-pane>

      <n-tab-pane name="midi">
        <template #tab>
          <n-icon :component="MusicalNoteOutline" />
          <span>{{ t('tools.midiTitle') }}</span>
        </template>
        <div class="tool-layout">
          <section class="tool-card tool-card--main">
            <div class="tool-card__header">
              <div class="tool-icon"><n-icon :component="MusicalNoteOutline" /></div>
              <div>
                <h2>{{ t('tools.midiTitle') }}</h2>
                <p>{{ t('tools.midiDescription') }}</p>
              </div>
            </div>
            <div class="form-section">
              <label>{{ t('tools.vocalAudio') }}</label>
              <div class="path-field">
                <n-input :value="midiInputPath" readonly :placeholder="t('tools.chooseVocalAudio')" />
                <n-button secondary :disabled="Boolean(busyTool)" @click="pickSingleAudio('midi')">
                  <template #icon><n-icon :component="DocumentOutline" /></template>
                  {{ t('common.browse') }}
                </n-button>
              </div>
              <n-alert
                v-if="midiInputLooksLikeAccompaniment"
                class="input-kind-warning"
                type="warning"
                :bordered="false"
              >
                {{ t('tools.midiInputLooksLikeAccompaniment') }}
              </n-alert>
            </div>
            <div class="form-section">
              <div class="field-heading model-field-heading">
                <label>{{ t('tools.midiModel') }}</label>
                <a
                  :href="GAME_RELEASE_URL"
                  class="model-download-link"
                  target="_blank"
                  rel="noopener noreferrer"
                  @click.prevent="openGameModelRelease"
                >
                  <n-icon :component="CloudDownloadOutline" />
                  <span>{{ t('tools.midiModelDownload') }}</span>
                </a>
              </div>
              <button
                type="button"
                class="model-file-picker"
                :class="{ 'model-file-picker--selected': midiModelPath }"
                :disabled="Boolean(busyTool)"
                @click="pickMidiModel"
              >
                <span class="model-file-picker__icon">
                  <n-icon :component="DocumentOutline" size="21" />
                </span>
                <span class="model-file-picker__content">
                  <strong>{{ midiModelPath ? fileName(midiModelPath) : t('tools.chooseMidiModel') }}</strong>
                  <small :title="midiModelPath">{{ midiModelPath || t('tools.midiModelChooseHint') }}</small>
                </span>
                <span class="model-file-picker__action">
                  {{ midiModelPath ? t('tools.reselectModel') : t('common.browse') }}
                </span>
              </button>
              <span class="field-hint">{{ t('tools.midiModelHint') }}</span>
            </div>
            <div class="form-grid form-grid--equal">
              <div class="form-section">
                <label>{{ t('tools.bpm') }}</label>
                <n-input-number
                  v-model:value="midiBpm"
                  :min="30"
                  :max="300"
                  :step="1"
                  :disabled="Boolean(busyTool)"
                />
              </div>
              <div class="form-section">
                <label>{{ t('tools.midiLanguage') }}</label>
                <n-select
                  v-model:value="midiLanguage"
                  :options="midiLanguageOptions"
                  :disabled="Boolean(busyTool)"
                />
              </div>
            </div>
            <div class="form-section">
              <label>{{ t('tools.outputDirectory') }}</label>
              <div class="path-field">
                <n-input :value="midiOutputDir" readonly :placeholder="t('tools.chooseOutputDirectory')" />
                <n-button secondary :disabled="Boolean(busyTool)" @click="pickFolder('midi-output')">
                  <template #icon><n-icon :component="FolderOpenOutline" /></template>
                  {{ t('common.browse') }}
                </n-button>
              </div>
            </div>
            <n-alert type="warning" :bordered="false">{{ t('tools.midiAccuracyHint') }}</n-alert>
            <div class="tool-actions">
              <n-button
                type="primary"
                :loading="busyTool === 'midi'"
                :disabled="Boolean(busyTool) || !midiInputPath || !midiModelPath || !midiOutputDir || !midiBpmValid"
                @click="runMidi"
              >
                {{ t('tools.startMidi') }}
              </n-button>
            </div>
          </section>
          <aside class="tool-card tool-card--side">
            <h3>{{ t('tools.processingStatus') }}</h3>
            <p>{{ t('tools.midiHint') }}</p>
            <AudioToolStatus
              :busy="busyTool === 'midi'"
              :has-result="hasResult"
              :error="errorMessage"
              :progress="progress"
              :percentage="progressPercentage"
              :result="result"
              :elapsed-ms="visibleElapsedMs"
              :logs="visibleActivityLogs"
              @reveal="revealPath"
            />
          </aside>
        </div>
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<style scoped>
.tools-page {
  max-width: 1440px;
}

.tools-tabs :deep(.n-tabs-nav) {
  max-width: 760px;
}

.tools-tabs :deep(.n-tabs-tab__label) {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.tools-tabs :deep(.n-tab-pane) {
  padding-top: 18px;
}

.tool-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(360px, 0.48fr);
  gap: 16px;
  align-items: stretch;
}

.tool-card {
  border: 1px solid var(--outline);
  border-radius: 16px;
  background: var(--surface-1);
}

.tool-card--main {
  padding: 22px;
}

.tool-card--merge {
  padding: 18px;
}

.tool-card--merge .tool-card__header {
  margin-bottom: 18px;
}

.tool-card--side {
  min-width: 0;
  min-height: 420px;
  display: flex;
  flex-direction: column;
  padding: 18px;
}

.tool-card--side h3 {
  margin: 0;
  font-size: 15px;
}

.tool-card--side > p {
  margin: 7px 0 14px;
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.65;
}

.tool-card__header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
}

.tool-card__header h2 {
  margin: 0;
  font-size: 18px;
}

.tool-card__header p {
  margin: 4px 0 0;
  color: var(--on-surface-muted);
  font-size: 13px;
}

.tool-icon {
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: 11px;
  border: 1px solid color-mix(in srgb, var(--primary-border) 55%, var(--outline));
  background: color-mix(in srgb, var(--primary-soft) 34%, var(--surface-2));
  color: var(--primary-strong);
  font-size: 18px;
}

.form-section {
  min-width: 0;
  margin-bottom: 18px;
}

.form-section > label,
.field-heading > label {
  display: block;
  margin-bottom: 7px;
  font-size: 12px;
  font-weight: 600;
  color: color-mix(in srgb, var(--on-surface) 88%, var(--on-surface-muted));
}

.field-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.model-field-heading {
  margin-bottom: 7px;
}

.model-field-heading > label {
  margin-bottom: 0;
}

.model-download-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--primary-strong);
  font-size: 11px;
  font-weight: 600;
  text-decoration: none;
}

.model-download-link:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.field-heading > span,
.field-hint {
  color: var(--on-surface-muted);
  font-size: 11px;
}

.field-hint {
  display: block;
  margin-top: 6px;
  line-height: 1.55;
}

.input-kind-warning {
  margin-top: 8px;
}

.form-grid {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 14px;
}

.form-grid--four {
  grid-template-columns: repeat(4, minmax(120px, 1fr));
}

.form-grid--equal {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.path-field {
  display: flex;
  gap: 8px;
}

.path-field .n-input {
  min-width: 0;
}

.source-picker-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.file-picker {
  width: 100%;
  min-height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  border: 1px dashed color-mix(in srgb, var(--outline) 82%, var(--primary-border));
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 38%, var(--surface-1));
  color: var(--on-surface-muted);
  cursor: pointer;
}

.file-picker:hover:not(:disabled) {
  border-color: var(--primary-border);
  color: var(--primary-strong);
  background: color-mix(in srgb, var(--primary-soft) 20%, var(--surface-1));
}

.file-picker:disabled {
  opacity: 0.5;
  cursor: default;
}

.model-file-picker {
  width: 100%;
  min-height: 68px;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 12px;
  border: 1px dashed color-mix(in srgb, var(--outline) 82%, var(--primary-border));
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 38%, var(--surface-1));
  color: var(--on-surface);
  text-align: left;
  cursor: pointer;
}

.model-file-picker:hover:not(:disabled) {
  border-color: var(--primary-border);
  background: color-mix(in srgb, var(--primary-soft) 20%, var(--surface-1));
}

.model-file-picker--selected {
  border-style: solid;
}

.model-file-picker:disabled {
  opacity: 0.5;
  cursor: default;
}

.model-file-picker__icon {
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border: 1px solid var(--outline);
  border-radius: 10px;
  background: var(--surface-1);
  color: var(--on-surface-muted);
}

.model-file-picker--selected .model-file-picker__icon {
  border-color: color-mix(in srgb, var(--primary-border) 64%, var(--outline));
  color: var(--primary-strong);
}

.model-file-picker__content {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 3px;
}

.model-file-picker__content strong,
.model-file-picker__content small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-file-picker__content strong {
  font-size: 12px;
  font-weight: 600;
}

.model-file-picker__content small {
  color: var(--on-surface-muted);
  font-size: 10px;
}

.model-file-picker__action {
  flex: 0 0 auto;
  color: var(--primary-strong);
  font-size: 11px;
  font-weight: 600;
}

.merge-rules {
  margin-bottom: 14px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--outline) 78%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 34%, var(--surface-1));
}

.merge-rules__heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 13px;
}

.merge-rules__heading strong {
  font-size: 13px;
}

.merge-rules__heading span {
  color: var(--on-surface-muted);
  font-size: 11px;
}

.merge-rules .form-section {
  margin-bottom: 0;
}

.merge-path-grid {
  margin-bottom: 14px;
}

.merge-path-grid .form-section {
  margin-bottom: 0;
}

.merge-regex-field {
  margin-top: 14px;
}

.merge-order-summary {
  margin: 12px 0 0;
  color: var(--on-surface-muted);
  font-size: 11px;
  line-height: 1.55;
}

.field-hint--error {
  color: var(--danger);
}

.selected-files {
  max-height: 148px;
  overflow: auto;
  margin-top: 8px;
  border: 1px solid color-mix(in srgb, var(--outline) 74%, transparent);
  border-radius: 10px;
}

.selected-file {
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--outline) 52%, transparent);
  font-size: 12px;
}

.selected-file:last-child {
  border-bottom: 0;
}

.selected-file span {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.selected-file button {
  display: grid;
  place-items: center;
  border: 0;
  padding: 3px;
  background: transparent;
  color: var(--on-surface-muted);
  cursor: pointer;
}

.selected-file button:hover:not(:disabled) {
  color: var(--danger);
}

.selected-file button:disabled {
  color: var(--on-surface-muted);
  cursor: not-allowed;
  opacity: 0.45;
}

.tool-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid color-mix(in srgb, var(--outline) 72%, transparent);
}

.tool-actions .n-button {
  min-width: 132px;
}

@media (max-width: 1120px) {
  .tool-layout {
    grid-template-columns: 1fr;
  }

  .tool-card--side {
    min-height: 340px;
  }

  .form-grid--four {
    grid-template-columns: repeat(2, minmax(150px, 1fr));
  }
}

@media (max-width: 760px) {
  .form-grid,
  .form-grid--four,
  .form-grid--equal,
  .source-picker-grid {
    grid-template-columns: 1fr;
  }

  .path-field {
    align-items: stretch;
  }
}
</style>
