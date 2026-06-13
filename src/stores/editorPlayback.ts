import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export type PlaybackIntent = 'play' | 'pause'
export type PlaybackStatus = 'paused' | 'starting' | 'playing' | 'pausing' | 'error'
export type TransportVisualState = 'play' | 'pause'
export type TransportPendingAction = 'starting' | 'pausing' | null

function normalizeNumber(value: number, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

export const useEditorPlaybackStore = defineStore('editor-playback', () => {
  const intent = ref<PlaybackIntent>('pause')
  const status = ref<PlaybackStatus>('paused')
  const currentTime = ref(0)
  const loop = ref(false)
  const level = ref(0)
  const masterLevel = ref<[number, number]>([0, 0])
  const trackLevels = ref<Record<string, [number, number]>>({})
  const error = ref<string | null>(null)
  const requestId = ref(0)

  const transportVisualState = computed<TransportVisualState>(() => (
    intent.value === 'play' ? 'pause' : 'play'
  ))
  const transportPendingAction = computed<TransportPendingAction>(() => {
    if (status.value === 'starting') return 'starting'
    if (status.value === 'pausing') return 'pausing'
    return null
  })
  const transportCanToggle = computed(() => status.value !== 'pausing')
  const isBusy = computed(() => status.value === 'starting' || status.value === 'pausing')
  const isActuallyPlaying = computed(() => status.value === 'playing')

  function nextRequest() {
    requestId.value += 1
    return requestId.value
  }

  function clearError() {
    error.value = null
  }

  function setIntent(value: PlaybackIntent) {
    intent.value = value
  }

  function setStatus(value: PlaybackStatus) {
    status.value = value
  }

  function beginRequest(nextIntent: PlaybackIntent, nextStatus: Extract<PlaybackStatus, 'starting' | 'pausing' | 'paused'>) {
    const id = nextRequest()
    intent.value = nextIntent
    status.value = nextStatus
    if (nextIntent === 'play' || nextStatus === 'paused') {
      error.value = null
    }
    if (nextStatus === 'paused') {
      level.value = 0
      masterLevel.value = [0, 0]
      trackLevels.value = {}
    }
    return id
  }

  function finishPlay(id: number) {
    if (id !== requestId.value) return false
    intent.value = 'play'
    status.value = 'playing'
    error.value = null
    return true
  }

  function finishPause(id: number) {
    if (id !== requestId.value) return false
    intent.value = 'pause'
    status.value = 'paused'
    level.value = 0
    masterLevel.value = [0, 0]
    trackLevels.value = {}
    return true
  }

  function fail(id: number, message: string) {
    if (id !== requestId.value) return false
    intent.value = 'pause'
    status.value = 'error'
    level.value = 0
    masterLevel.value = [0, 0]
    trackLevels.value = {}
    error.value = message
    return true
  }

  function setCurrentTime(value: number) {
    currentTime.value = Math.max(0, normalizeNumber(value))
  }

  function setLevel(value: number) {
    level.value = Math.max(0, Math.min(1, normalizeNumber(value)))
  }

  function normalizeStereoLevel(value: [number, number] | number[] | null | undefined): [number, number] {
    const left = Math.max(0, Math.min(1, normalizeNumber(value?.[0] ?? 0)))
    const right = Math.max(0, Math.min(1, normalizeNumber(value?.[1] ?? left)))
    return [left, right]
  }

  function setMasterLevel(value: [number, number] | number[] | null | undefined) {
    masterLevel.value = normalizeStereoLevel(value)
  }

  function setTrackLevel(trackId: string, value: [number, number] | number[] | null | undefined) {
    if (!trackId) return
    trackLevels.value = {
      ...trackLevels.value,
      [trackId]: normalizeStereoLevel(value),
    }
  }

  function setTrackLevels(levels: Record<string, [number, number] | number[]>) {
    const next: Record<string, [number, number]> = {}
    for (const [trackId, value] of Object.entries(levels)) {
      if (!trackId) continue
      next[trackId] = normalizeStereoLevel(value)
    }
    trackLevels.value = next
  }

  function clearTrackLevels(activeTrackIds?: string[]) {
    if (!activeTrackIds?.length) {
      trackLevels.value = {}
      return
    }
    const keep = new Set(activeTrackIds)
    const next = Object.fromEntries(Object.entries(trackLevels.value).filter(([key]) => keep.has(key))) as Record<string, [number, number]>
    trackLevels.value = next
  }

  function setLoop(value: boolean) {
    loop.value = Boolean(value)
  }

  function reset() {
    intent.value = 'pause'
    status.value = 'paused'
    currentTime.value = 0
    loop.value = false
    level.value = 0
    masterLevel.value = [0, 0]
    trackLevels.value = {}
    error.value = null
    requestId.value = 0
  }

  return {
    intent,
    status,
    currentTime,
    loop,
    level,
    masterLevel,
    trackLevels,
    error,
    requestId,
    transportVisualState,
    transportPendingAction,
    transportCanToggle,
    isBusy,
    isActuallyPlaying,
    nextRequest,
    clearError,
    setIntent,
    setStatus,
    beginRequest,
    finishPlay,
    finishPause,
    fail,
    setCurrentTime,
    setLevel,
    setMasterLevel,
    setTrackLevel,
    setTrackLevels,
    clearTrackLevels,
    setLoop,
    reset,
  }
})
