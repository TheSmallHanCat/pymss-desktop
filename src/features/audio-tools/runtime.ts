import { computed, inject, type ComputedRef, type InjectionKey, reactive, ref, type Ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import type {
  AudioToolActivityState, AudioToolKey, AudioToolLogEntry, AudioToolPhase,
  AudioToolProgress, AudioToolRecovery, AudioToolResult, AudioToolViewState, AudioToolWarning,
} from './types'

const MAX_ACTIVITY_LOGS = 100
const AUDIO_TOOL_PHASES = new Set<AudioToolPhase>([
  'preparing', 'converting', 'normalizing', 'merging', 'loading_reference', 'loading_estimated',
  'calculating', 'loading_model', 'loading_audio', 'transcribing', 'writing_output', 'probing',
  'analyzing_silence', 'writing_segments', 'loading_asr_model', 'recognizing_speech', 'writing_transcript',
])

type WorkerEvent = {
  type: string
  requestId?: string | null
  payload?: {
    operation?: AudioToolKey
    completed?: number
    total?: number
    current?: string
    phase?: string
    detail?: string
    code?: string
    recovery?: unknown
  }
}

export type AudioToolRuntime = {
  busyTool: Ref<AudioToolKey | null>
  execute: (tool: AudioToolKey, payload: Record<string, unknown>) => Promise<AudioToolResult | null>
  stateFor: (tool: AudioToolKey) => ComputedRef<AudioToolViewState>
  revealPath: (path: string) => Promise<void>
  start: () => Promise<void>
  stop: () => void
}

export const audioToolRuntimeKey: InjectionKey<AudioToolRuntime> = Symbol('audio-tool-runtime')

export function useAudioToolRuntime() {
  const runtime = inject(audioToolRuntimeKey)
  if (!runtime) throw new Error('Audio tool runtime is unavailable')
  return runtime
}

function fileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

export function normalizeAudioToolRecovery(value: unknown): AudioToolRecovery | null {
  if (!value || typeof value !== 'object') return null
  const recovery = value as Partial<AudioToolRecovery>
  if (recovery.action !== 'redownload_asr_models' || recovery.tool !== 'asr') return null
  if (!Array.isArray(recovery.modelIds) || !recovery.modelIds.length) return null
  const modelIds = recovery.modelIds
    .map(value => String(value || '').trim())
    .filter(value => value && !/[\\/]/.test(value) && value !== '.' && value !== '..')
  if (!modelIds.length || typeof recovery.modelDir !== 'string' || !recovery.modelDir.trim()) return null
  const reason = recovery.reason === 'disk_full' ? 'disk_full' : 'incomplete_download'
  return {
    action: recovery.action,
    tool: recovery.tool,
    modelIds: [...new Set(modelIds)],
    modelDir: recovery.modelDir.trim(),
    reason,
  }
}

export function createAudioToolRuntime(): AudioToolRuntime {
  const { t } = useI18n()
  const message = useMessage()
  const busyTool = ref<AudioToolKey | null>(null)
  const results = reactive<Partial<Record<AudioToolKey, AudioToolResult>>>({})
  const errors = reactive<Partial<Record<AudioToolKey, string>>>({})
  const recoveries = reactive<Partial<Record<AudioToolKey, AudioToolRecovery>>>({})
  const activities = reactive<Partial<Record<AudioToolKey, AudioToolActivityState>>>({})
  const pendingRequestIds: Partial<Record<AudioToolKey, string>> = {}
  let unlistenWorker: UnlistenFn | undefined
  let elapsedTimer: ReturnType<typeof setInterval> | undefined
  let activityStartedAt = 0
  let timedTool: AudioToolKey | null = null
  let logSequence = 0
  let requestSequence = 0

  function normalizePhase(value: unknown): AudioToolPhase {
    const phase = String(value || '') as AudioToolPhase
    return AUDIO_TOOL_PHASES.has(phase) ? phase : 'preparing'
  }

  function phaseDescription(tool: AudioToolKey, phase: AudioToolPhase) {
    const keys: Record<AudioToolPhase, string> = {
      started: 'tools.phaseDetailStarted', preparing: 'tools.phaseDetailPreparing',
      converting: 'tools.phaseDetailConverting', normalizing: 'tools.phaseDetailNormalizing',
      merging: 'tools.phaseDetailMerging', loading_reference: 'tools.phaseDetailLoadingReference',
      loading_estimated: 'tools.phaseDetailLoadingEstimated', calculating: 'tools.phaseDetailCalculating',
      loading_model: 'tools.phaseDetailLoadingModel', loading_audio: 'tools.phaseDetailLoadingAudio',
      transcribing: 'tools.phaseDetailTranscribing', writing_output: 'tools.phaseDetailWritingOutput',
      probing: 'tools.phaseDetailProbing', analyzing_silence: 'tools.phaseDetailAnalyzingSilence',
      writing_segments: 'tools.phaseDetailWritingSegments', loading_asr_model: 'tools.phaseDetailLoadingAsrModel',
      recognizing_speech: 'tools.phaseDetailRecognizingSpeech', writing_transcript: 'tools.phaseDetailWritingTranscript',
      completed: 'tools.phaseDetailCompleted', failed: 'tools.phaseDetailFailed',
    }
    return phase === 'started'
      ? t(keys[phase], { tool: t(`tools.${tool}Title`) })
      : t(keys[phase])
  }

  function appendLog(tool: AudioToolKey, phase: AudioToolPhase, snapshot: AudioToolProgress, detail = '') {
    const activity = activities[tool]
    if (!activity) return
    const timestamp = Date.now()
    logSequence += 1
    const logs = activity.logs.map((entry, index) => index === activity.logs.length - 1
      ? { ...entry, updatedAt: timestamp }
      : entry)
    logs.push({ ...snapshot, id: logSequence, timestamp, updatedAt: timestamp, phase, description: phaseDescription(tool, phase), detail })
    activity.logs = logs.slice(-MAX_ACTIVITY_LOGS)
  }

  function recordProgress(tool: AudioToolKey, snapshot: AudioToolProgress, detail?: string) {
    const activity = activities[tool]
    if (!activity) return
    const last = activity.logs.at(-1)
    activity.progress = snapshot
    if (last?.phase === snapshot.phase) {
      Object.assign(last, snapshot, { updatedAt: Date.now() })
      if (detail !== undefined) last.detail = detail
    } else {
      appendLog(tool, snapshot.phase, snapshot, detail)
    }
  }

  function stopElapsedTimer() {
    if (elapsedTimer) clearInterval(elapsedTimer)
    elapsedTimer = undefined
    if (timedTool && activityStartedAt && activities[timedTool]) {
      activities[timedTool]!.elapsedMs = Date.now() - activityStartedAt
    }
    activityStartedAt = 0
    timedTool = null
  }

  function activityTarget(tool: AudioToolKey, payload: Record<string, unknown>) {
    if (tool === 'convert' || tool === 'slicer') {
      const inputs = Array.isArray(payload.inputs) ? payload.inputs : []
      return inputs.length ? fileName(String(inputs[0])) : ''
    }
    if (tool === 'sdr') return fileName(String(payload.referencePath || ''))
    if (['midi', 'inspect', 'asr'].includes(tool)) return fileName(String(payload.inputPath || ''))
    return String(payload.inputDir || '')
  }

  function beginActivity(tool: AudioToolKey, current: string) {
    stopElapsedTimer()
    const progress: AudioToolProgress = { completed: 0, total: 0, current, phase: 'preparing' }
    activities[tool] = { progress, logs: [], elapsedMs: 0 }
    activityStartedAt = Date.now()
    timedTool = tool
    appendLog(tool, 'started', progress)
    elapsedTimer = setInterval(() => {
      if (activities[tool]) activities[tool]!.elapsedMs = Date.now() - activityStartedAt
    }, 500)
  }

  function warningText(warning: AudioToolWarning) {
    if (warning === 'no_notes_detected') return t('tools.midiWarningNoNotes')
    if (warning === 'stereo_downmix_fallback') return t('tools.midiWarningStereoFallback')
    if (warning === 'timestamps_unavailable') return t('tools.asrWarningNoTimestamps')
    return warning
  }

  function describeError(error: unknown) {
    const value = error instanceof Error ? error.message : String(error)
    if (!value.includes('Invalid worker event')) return value
    const output = value.match(/raw=(.*)$/s)?.[1]?.trim() || t('tools.unknownWorkerOutput')
    return t('tools.workerProtocolError', { output })
  }

  async function execute(tool: AudioToolKey, payload: Record<string, unknown>) {
    if (busyTool.value) return null
    const requestId = `audio_tool_${tool}_${Date.now()}_${++requestSequence}`
    pendingRequestIds[tool] = requestId
    busyTool.value = tool
    delete results[tool]
    delete errors[tool]
    delete recoveries[tool]
    beginActivity(tool, activityTarget(tool, payload))
    try {
      const response = await invoke<AudioToolResult>('run_audio_tool', {
        payload: { operation: tool, ...payload, requestId },
      })
      if (pendingRequestIds[tool] === requestId) delete pendingRequestIds[tool]
      results[tool] = response
      const activity = activities[tool]
      const progress: AudioToolProgress = {
        completed: activity?.progress.total || 1, total: activity?.progress.total || 1, current: '', phase: 'completed',
      }
      if (activity) activity.progress = progress
      const warnings = (response.warnings || []).map(warningText)
      appendLog(tool, 'completed', progress, warnings.join(' '))
      if (warnings.length) message.warning(warnings.join(' '))
      else if ((response.failed?.length || 0) + (response.skipped?.length || 0) > 0) message.warning(t('tools.completedWithSkipped'))
      else message.success(t('tools.completed'))
      return response
    } catch (error) {
      const description = recoveries[tool]
        ? t('tools.asrModelIncompleteError')
        : describeError(error)
      errors[tool] = description
      const activity = activities[tool]
      const progress: AudioToolProgress = { ...(activity?.progress || { completed: 0, total: 0, current: '' }), phase: 'failed' }
      if (activity) activity.progress = progress
      appendLog(tool, 'failed', progress, description)
      return null
    } finally {
      stopElapsedTimer()
      busyTool.value = null
    }
  }

  function stateFor(tool: AudioToolKey) {
    return computed<AudioToolViewState>(() => {
      const activity = activities[tool]
      const progress = activity?.progress || { completed: 0, total: 0, current: '', phase: 'preparing' as const }
      const result = results[tool] || null
      return {
        busy: busyTool.value === tool,
        anyBusy: Boolean(busyTool.value),
        hasResult: result?.operation === tool,
        error: errors[tool] || '', progress,
        percentage: progress.total ? Math.min(100, Math.round(progress.completed / progress.total * 100)) : 0,
        result, elapsedMs: activity?.elapsedMs || 0, logs: activity?.logs || [],
        recovery: recoveries[tool] || null,
      }
    })
  }

  async function revealPath(path: string) {
    try { await invoke('reveal_path', { path }) }
    catch (error) { message.error(error instanceof Error ? error.message : String(error)) }
  }

  async function start() {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
    unlistenWorker = await listen<WorkerEvent>('pymss://worker-event', (event) => {
      const workerEvent = event.payload
      if (workerEvent.type === 'error') {
        const operation = workerEvent.payload?.operation
        if (operation && workerEvent.requestId && pendingRequestIds[operation] === workerEvent.requestId) {
          const recovery = normalizeAudioToolRecovery(workerEvent.payload?.recovery)
          if (recovery) {
            recoveries[operation] = recovery
            errors[operation] = t('tools.asrModelIncompleteError')
          }
          delete pendingRequestIds[operation]
        }
        return
      }
      if (workerEvent.type !== 'audio_tool_progress') return
      const payload = workerEvent.payload
      if (!payload?.operation || payload.operation !== busyTool.value) return
      recordProgress(payload.operation, {
        completed: Math.max(0, Number(payload.completed || 0)), total: Math.max(0, Number(payload.total || 0)),
        current: String(payload.current || ''), phase: normalizePhase(payload.phase),
      }, typeof payload.detail === 'string' ? payload.detail : undefined)
    })
  }

  function stop() {
    unlistenWorker?.()
    unlistenWorker = undefined
    for (const tool of Object.keys(pendingRequestIds) as AudioToolKey[]) delete pendingRequestIds[tool]
    stopElapsedTimer()
  }

  return { busyTool, execute, stateFor, revealPath, start, stop }
}
