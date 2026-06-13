import { onBeforeUnmount, type Ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { EditorSource, EditorTrack } from '@/types/editor'
import type { useEditorStore } from '@/stores/editor'
import { useEditorPlaybackStore } from '@/stores/editorPlayback'

type EditorStore = ReturnType<typeof useEditorStore>

type PlaybackOptions = {
  editor: EditorStore
  scrollEl: Ref<HTMLElement | null>
  trackHeaderWidth?: number
}

type ActiveTrackEntry = {
  track: EditorTrack
  source: EditorSource
}

type ManagedAudio = {
  trackId: string
  sourceId: string
  audio: HTMLAudioElement
  metadataReady: boolean
  metadataPromise: Promise<void>
  fallbackUrl?: string | null
  graphEnabled?: boolean
  sourceNode?: MediaElementAudioSourceNode | null
  gainNode?: GainNode | null
  balanceSplitter?: ChannelSplitterNode | null
  balanceLeftGain?: GainNode | null
  balanceRightGain?: GainNode | null
  balanceMerger?: ChannelMergerNode | null
  meterSplitter?: ChannelSplitterNode | null
  meterAnalyserLeft?: AnalyserNode | null
  meterAnalyserRight?: AnalyserNode | null
}

type FollowPlayheadMode = 'playback' | 'seek'

const ERROR_SESSION_NOT_LOADED = '请先加载编辑工程'
const ERROR_NO_PLAYABLE_TRACKS = '当前没有可播放的音轨'
const ERROR_NO_LOADED_AUDIO = '没有成功加载任何音频'

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function useEditorPlayback(options: PlaybackOptions) {
  const { editor, scrollEl } = options
  const trackHeaderWidth = options.trackHeaderWidth ?? 0
  const playback = useEditorPlaybackStore()
  const {
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
  } = storeToRefs(playback)
  const shouldFollowPlayhead = isActuallyPlaying

  const audioEntries = new Map<string, ManagedAudio>()

  let rafId: number | null = null
  let playbackAnchorTime = 0
  let activeRequestId = 0
  let followScrollRafId: number | null = null
  let followScrollTargetLeft = 0
  let audioContext: AudioContext | null = null
  let masterInputGain: GainNode | null = null
  let masterBalanceSplitter: ChannelSplitterNode | null = null
  let masterBalanceLeftGain: GainNode | null = null
  let masterBalanceRightGain: GainNode | null = null
  let masterBalanceMerger: ChannelMergerNode | null = null
  let masterMeterSplitter: ChannelSplitterNode | null = null
  let masterMeterAnalyserLeft: AnalyserNode | null = null
  let masterMeterAnalyserRight: AnalyserNode | null = null
  const analyserBufferCache = new WeakMap<AnalyserNode, Uint8Array<ArrayBuffer>>()

  function resolveAudioUrl(path: string) {
    try {
      return convertFileSrc(path)
    } catch {
      const normalized = path.replace(/\\/g, '/')
      if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${normalized}`
      return path
    }
  }

  function resolveFileFallbackUrl(path: string) {
    const normalized = path.replace(/\\/g, '/')
    if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${normalized}`
    return null
  }

  function ensureAudioContext() {
    if (typeof window === 'undefined') return null
    if (!audioContext) {
      const Ctor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return null
      audioContext = new Ctor()
    }
    if (!masterInputGain) {
      masterInputGain = audioContext.createGain()
      masterBalanceSplitter = audioContext.createChannelSplitter(2)
      masterBalanceLeftGain = audioContext.createGain()
      masterBalanceRightGain = audioContext.createGain()
      masterBalanceMerger = audioContext.createChannelMerger(2)
      masterMeterSplitter = audioContext.createChannelSplitter(2)
      masterMeterAnalyserLeft = audioContext.createAnalyser()
      masterMeterAnalyserRight = audioContext.createAnalyser()

      ;[masterMeterAnalyserLeft, masterMeterAnalyserRight].forEach((node) => {
        node.fftSize = 256
        node.smoothingTimeConstant = 0.78
      })

      masterInputGain.connect(masterBalanceSplitter)
      masterBalanceSplitter.connect(masterBalanceLeftGain, 0)
      masterBalanceSplitter.connect(masterBalanceRightGain, 1)
      masterBalanceLeftGain.connect(masterBalanceMerger, 0, 0)
      masterBalanceRightGain.connect(masterBalanceMerger, 0, 1)
      masterBalanceMerger.connect(masterMeterSplitter)
      masterMeterSplitter.connect(masterMeterAnalyserLeft, 0)
      masterMeterSplitter.connect(masterMeterAnalyserRight, 1)
      masterBalanceMerger.connect(audioContext.destination)
    }
    applyMasterAudioSettings()
    return audioContext
  }

  function ensureMeterBuffer(node: AnalyserNode) {
    let cached = analyserBufferCache.get(node)
    if (!cached) {
      cached = new Uint8Array<ArrayBuffer>(new ArrayBuffer(node.fftSize))
      analyserBufferCache.set(node, cached)
    }
    return cached
  }

  function analyserLevel(node?: AnalyserNode | null) {
    if (!node) return 0
    const buffer = ensureMeterBuffer(node)
    node.getByteTimeDomainData(buffer)
    let sum = 0
    for (let index = 0; index < buffer.length; index += 1) {
      const sample = (buffer[index] - 128) / 128
      sum += sample * sample
    }
    const rms = Math.sqrt(sum / Math.max(1, buffer.length))
    const boosted = Math.pow(clamp(rms * 3.2, 0, 1), 0.72)
    return clamp(boosted, 0, 1)
  }

  function stereoGainForPan(pan: number) {
    const normalized = clamp(Number(pan || 0), -1, 1)
    return {
      left: normalized <= 0 ? 1 : 1 - normalized,
      right: normalized >= 0 ? 1 : 1 + normalized,
    }
  }

  function applyMasterAudioSettings() {
    if (!masterInputGain || !masterBalanceLeftGain || !masterBalanceRightGain) return
    masterInputGain.gain.value = clamp(Number(editor.masterVolume || 0), 0, 2)
    const stereo = stereoGainForPan(editor.masterPan)
    masterBalanceLeftGain.gain.value = stereo.left
    masterBalanceRightGain.gain.value = stereo.right
  }

  function applyTrackAudioSettings(entry: ManagedAudio, track: EditorTrack, baseVolume: number) {
    if (entry.gainNode && entry.balanceLeftGain && entry.balanceRightGain) {
      entry.gainNode.gain.value = clamp(Number(baseVolume || 0), 0, 2)
      const stereo = stereoGainForPan(track.pan)
      entry.balanceLeftGain.gain.value = stereo.left
      entry.balanceRightGain.gain.value = stereo.right
      entry.audio.volume = 1
      entry.audio.muted = false
      return
    }

    entry.audio.muted = baseVolume <= 0.0001
    entry.audio.volume = clamp(Number(baseVolume || 0), 0, 1)
  }

  function createMetadataPromise(audio: HTMLAudioElement, entry: ManagedAudio) {
    return new Promise<void>((resolve) => {
      if (audio.readyState >= 1) {
        entry.metadataReady = true
        resolve()
        return
      }

      const cleanup = () => {
        audio.removeEventListener('loadedmetadata', onReady)
        audio.removeEventListener('canplay', onReady)
        audio.removeEventListener('error', onDone)
      }

      const onReady = () => {
        cleanup()
        entry.metadataReady = true
        resolve()
      }

      const onDone = () => {
        cleanup()
        resolve()
      }

      audio.addEventListener('loadedmetadata', onReady, { once: true })
      audio.addEventListener('canplay', onReady, { once: true })
      audio.addEventListener('error', onDone, { once: true })
    })
  }

  function releaseEntry(entry: ManagedAudio) {
    entry.audio.pause()
    entry.sourceNode?.disconnect()
    entry.gainNode?.disconnect()
    entry.balanceSplitter?.disconnect()
    entry.balanceLeftGain?.disconnect()
    entry.balanceRightGain?.disconnect()
    entry.balanceMerger?.disconnect()
    entry.meterSplitter?.disconnect()
    entry.meterAnalyserLeft?.disconnect()
    entry.meterAnalyserRight?.disconnect()
    entry.audio.removeAttribute('src')
    entry.audio.load()
  }

  function connectEntryAudioGraph(entry: ManagedAudio, source: EditorSource) {
    const ctx = ensureAudioContext()
    if (!ctx || !masterInputGain) return
    if (entry.sourceNode || entry.graphEnabled === false) return

    try {
      entry.sourceNode = ctx.createMediaElementSource(entry.audio)
      entry.gainNode = ctx.createGain()
      entry.balanceSplitter = ctx.createChannelSplitter(2)
      entry.balanceLeftGain = ctx.createGain()
      entry.balanceRightGain = ctx.createGain()
      entry.balanceMerger = ctx.createChannelMerger(2)
      entry.meterSplitter = ctx.createChannelSplitter(2)
      entry.meterAnalyserLeft = ctx.createAnalyser()
      entry.meterAnalyserRight = ctx.createAnalyser()

      ;[entry.meterAnalyserLeft, entry.meterAnalyserRight].forEach((node) => {
        node.fftSize = 256
        node.smoothingTimeConstant = 0.76
      })

      entry.sourceNode.connect(entry.gainNode)
      entry.gainNode.connect(entry.balanceSplitter)

      if (Number(source.channels || 0) <= 1) {
        entry.balanceSplitter.connect(entry.balanceLeftGain, 0)
        entry.balanceSplitter.connect(entry.balanceRightGain, 0)
      } else {
        entry.balanceSplitter.connect(entry.balanceLeftGain, 0)
        entry.balanceSplitter.connect(entry.balanceRightGain, 1)
      }

      entry.balanceLeftGain.connect(entry.balanceMerger, 0, 0)
      entry.balanceRightGain.connect(entry.balanceMerger, 0, 1)
      entry.balanceMerger.connect(entry.meterSplitter)
      entry.meterSplitter.connect(entry.meterAnalyserLeft, 0)
      entry.meterSplitter.connect(entry.meterAnalyserRight, 1)
      entry.balanceMerger.connect(masterInputGain)
      entry.graphEnabled = true
    } catch {
      entry.graphEnabled = false
      entry.sourceNode = null
      entry.gainNode = null
      entry.balanceSplitter = null
      entry.balanceLeftGain = null
      entry.balanceRightGain = null
      entry.balanceMerger = null
      entry.meterSplitter = null
      entry.meterAnalyserLeft = null
      entry.meterAnalyserRight = null
    }
  }

  function computeDuration() {
    return Math.max(0, editor.duration || 0)
  }

  function clampTime(time: number, duration = computeDuration()) {
    return Math.max(0, Math.min(time, duration))
  }

  function activeTracks() {
    const session = editor.session
    if (!session) return []
    const hasSolo = session.tracks.some((track) => track.solo)
    return session.tracks
      .filter((track) => !track.muted && (!hasSolo || track.solo))
      .map((track) => {
        const source = editor.sourceMap.get(track.sourceId)
        return source ? { track, source } : null
      })
      .filter((entry): entry is ActiveTrackEntry => Boolean(entry))
  }

  function trackSignature() {
    return activeTracks()
      .map(({ track, source }) => [track.id, source.id, track.volume, track.pan, track.muted, track.solo, track.fadeIn, track.fadeOut].join(':'))
      .join('|')
  }

  function ensureAudioEntry(track: EditorTrack, source: EditorSource) {
    const cached = audioEntries.get(track.id)
    if (cached && cached.sourceId === source.id) {
      connectEntryAudioGraph(cached, source)
      return cached
    }

    if (cached) {
      releaseEntry(cached)
      audioEntries.delete(track.id)
    }

    const primaryUrl = resolveAudioUrl(source.path)
    const fallbackUrl = resolveFileFallbackUrl(source.path)
    const audio = new Audio(primaryUrl)
    audio.preload = 'auto'
    audio.loop = false
    audio.crossOrigin = 'anonymous'

    const entry: ManagedAudio = {
      trackId: track.id,
      sourceId: source.id,
      audio,
      fallbackUrl: fallbackUrl && fallbackUrl !== primaryUrl ? fallbackUrl : null,
      graphEnabled: undefined,
      metadataReady: audio.readyState >= 1,
      metadataPromise: Promise.resolve(),
    }

    audio.addEventListener('error', () => {
      if (!entry.fallbackUrl || entry.audio.currentSrc === entry.fallbackUrl || entry.audio.src === entry.fallbackUrl) return
      entry.metadataReady = false
      entry.audio.src = entry.fallbackUrl
      entry.audio.load()
    })

    entry.metadataPromise = createMetadataPromise(audio, entry)
    audioEntries.set(track.id, entry)
    connectEntryAudioGraph(entry, source)
    audio.load()
    return entry
  }

  function setAudioTime(audio: HTMLAudioElement, time: number) {
    const maxTime = Number.isFinite(audio.duration) && audio.duration > 0
      ? Math.max(0, audio.duration - 0.01)
      : time
    const next = Math.max(0, Math.min(time, maxTime))
    try {
      audio.currentTime = next
    } catch {
      // ignore early metadata timing errors
    }
  }

  function computeTrackVolume(track: EditorTrack, source: EditorSource, time: number) {
    let gain = Math.max(0, track.volume)
    const duration = Math.max(0, Number(source.duration || 0))
    const fadeIn = Math.max(0, Number(track.fadeIn || 0))
    const fadeOut = Math.max(0, Number(track.fadeOut || 0))

    if (fadeIn > 0 && time < fadeIn) {
      gain *= Math.max(0, Math.min(1, time / fadeIn))
    }

    if (fadeOut > 0 && duration > 0) {
      const fadeOutStart = Math.max(0, duration - fadeOut)
      if (time > fadeOutStart) {
        gain *= Math.max(0, Math.min(1, (duration - time) / fadeOut))
      }
    }

    return Math.max(0, Math.min(2, gain))
  }

  function pauseInactiveAudios(activeIds: Set<string>) {
    audioEntries.forEach((entry, trackId) => {
      if (activeIds.has(trackId)) return
      entry.audio.pause()
      entry.audio.muted = true
      entry.audio.volume = 0
      if (entry.gainNode) entry.gainNode.gain.value = 0
    })
  }

  function applyTrackVolumes(time = currentTime.value) {
    const entries = activeTracks()
    const activeIds = new Set(entries.map(({ track }) => track.id))

    for (const { track, source } of entries) {
      const entry = ensureAudioEntry(track, source)
      const volume = computeTrackVolume(track, source, time)
      applyTrackAudioSettings(entry, track, volume)
    }

    pauseInactiveAudios(activeIds)
    playback.clearTrackLevels([...activeIds])
  }

  async function preloadActiveTracks() {
    const entries = activeTracks().map(({ track, source }) => ensureAudioEntry(track, source))
    await Promise.allSettled(entries.map((entry) => entry.metadataPromise))
  }

  function animateFollowScroll(targetLeft: number) {
    const el = scrollEl.value
    if (!el) return

    followScrollTargetLeft = targetLeft

    if (Math.abs(el.scrollLeft - targetLeft) < 1) {
      el.scrollLeft = targetLeft
      stopFollowScroll()
      return
    }

    if (followScrollRafId !== null) return

    const step = () => {
      const host = scrollEl.value
      if (!host) {
        stopFollowScroll()
        return
      }

      const delta = followScrollTargetLeft - host.scrollLeft
      if (Math.abs(delta) < 1) {
        host.scrollLeft = followScrollTargetLeft
        stopFollowScroll()
        return
      }

      host.scrollLeft += delta * 0.2
      followScrollRafId = requestAnimationFrame(step)
    }

    followScrollRafId = requestAnimationFrame(step)
  }

  function followPlayhead(mode: FollowPlayheadMode = 'playback') {
    const el = scrollEl.value
    if (!el) return
    const x = trackHeaderWidth + currentTime.value * editor.pixelsPerSecond
    const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
    const clampedX = Math.max(trackHeaderWidth, Math.min(trackHeaderWidth + computeDuration() * editor.pixelsPerSecond, x))

    if (mode === 'seek') {
      const targetLeft = Math.max(0, Math.min(maxScrollLeft, clampedX - el.clientWidth * 0.5))
      animateFollowScroll(targetLeft)
      return
    }

    const viewportLeft = el.scrollLeft
    const viewportRight = viewportLeft + el.clientWidth
    const leftGuard = viewportLeft + Math.min(48, el.clientWidth * 0.08)
    const rightGuard = viewportRight - Math.max(56, el.clientWidth * 0.08)

    if (clampedX < leftGuard) {
      const targetLeft = Math.max(0, Math.min(maxScrollLeft, clampedX - el.clientWidth * 0.2))
      animateFollowScroll(targetLeft)
      return
    }

    if (clampedX > rightGuard) {
      const pageAdvance = Math.max(el.clientWidth * 0.82, 240)
      const targetLeft = Math.max(
        0,
        Math.min(maxScrollLeft, Math.max(viewportLeft + pageAdvance, clampedX - el.clientWidth * 0.18)),
      )
      animateFollowScroll(targetLeft)
    }
  }

  function stopFollowScroll() {
    if (followScrollRafId !== null) {
      cancelAnimationFrame(followScrollRafId)
      followScrollRafId = null
    }
  }

  function stopRaf() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    stopFollowScroll()
  }

  function pauseAllAudios() {
    audioEntries.forEach((entry) => {
      entry.audio.pause()
    })
  }

  function syncPauseAt(time: number) {
    pauseAllAudios()
    audioEntries.forEach((entry) => setAudioTime(entry.audio, time))
  }

  function sampleCurrentTime() {
    const samples: number[] = []
    for (const { track } of activeTracks()) {
      const entry = audioEntries.get(track.id)
      if (entry && !entry.audio.paused) samples.push(entry.audio.currentTime)
    }
    if (samples.length) return Math.max(...samples)
    if (status.value !== 'playing') return currentTime.value
    return Math.max(0, performance.now() / 1000 - playbackAnchorTime)
  }

  function updateLevelMeter() {
    if (status.value !== 'playing') {
      playback.setLevel(0)
      playback.setMasterLevel([0, 0])
      return
    }

    const nextLevels: Record<string, [number, number]> = {}
    for (const { track, source } of activeTracks()) {
      const entry = ensureAudioEntry(track, source)
      const left = analyserLevel(entry.meterAnalyserLeft)
      const right = analyserLevel(entry.meterAnalyserRight)
      nextLevels[track.id] = [left, right]
    }
    playback.setTrackLevels(nextLevels)

    const masterStereo: [number, number] = [
      analyserLevel(masterMeterAnalyserLeft),
      analyserLevel(masterMeterAnalyserRight),
    ]
    playback.setMasterLevel(masterStereo)
    playback.setLevel((masterStereo[0] + masterStereo[1]) / 2)
  }

  function releaseAudios() {
    pauseAllAudios()
    audioEntries.forEach((entry) => {
      releaseEntry(entry)
    })
    audioEntries.clear()
    playback.setMasterLevel([0, 0])
    playback.clearTrackLevels()
  }

  function finishPaused(id: number, time: number) {
    stopRaf()
    syncPauseAt(time)
    playback.setCurrentTime(clampTime(time))
    playback.setLevel(0)
    playback.setMasterLevel([0, 0])
    playback.clearTrackLevels()
    playback.finishPause(id)
  }

  function syncPausedAudiosToTime(time: number) {
    const nextTime = clampTime(time)
    playback.setCurrentTime(nextTime)
    playbackAnchorTime = performance.now() / 1000 - nextTime
    applyTrackVolumes(nextTime)

    const entries = activeTracks()
    for (const { track, source } of entries) {
      const entry = ensureAudioEntry(track, source)
      const applySeek = () => setAudioTime(entry.audio, nextTime)
      if (entry.metadataReady) applySeek()
      else void entry.metadataPromise.then(() => {
        if (entry.sourceId !== source.id) return
        applySeek()
      })
    }
  }

  async function syncActiveAudios(playNow: boolean, targetTime = currentTime.value, expectedRequestId = activeRequestId) {
    const entries = activeTracks()
    if (!entries.length) {
      pauseAllAudios()
      return 0
    }

    const ctx = ensureAudioContext()
    if (playNow && ctx && ctx.state !== 'running') {
      await ctx.resume().catch(() => undefined)
    }

    const activeIds = new Set(entries.map(({ track }) => track.id))
    pauseInactiveAudios(activeIds)

    const managed = entries.map(({ track, source }) => ({
      track,
      source,
      entry: ensureAudioEntry(track, source),
    }))

    const nextTime = clampTime(targetTime)
    playback.setCurrentTime(nextTime)
    playbackAnchorTime = performance.now() / 1000 - nextTime

    for (const { entry } of managed) {
      setAudioTime(entry.audio, nextTime)
      if (!entry.metadataReady) {
        void entry.metadataPromise.then(() => {
          if (expectedRequestId !== activeRequestId) return
          setAudioTime(entry.audio, nextTime)
        })
      }
    }

    applyTrackVolumes(nextTime)

    if (!playNow) return managed.length

    const results = await Promise.allSettled(managed.map(({ entry }) => entry.audio.play()))
    if (expectedRequestId !== activeRequestId) return 0
    const playableCount = results.filter((result) => result.status === 'fulfilled').length
    if (playableCount <= 0) {
      const firstError = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      throw firstError?.reason || new Error(ERROR_NO_LOADED_AUDIO)
    }
    return playableCount
  }

  async function requestPlay(offset = currentTime.value) {
    playback.clearError()

    if (!editor.session) {
      const id = playback.beginRequest('pause', 'paused')
      activeRequestId = id
      playback.fail(id, ERROR_SESSION_NOT_LOADED)
      return false
    }

    if (!activeTracks().length) {
      const id = playback.beginRequest('pause', 'paused')
      activeRequestId = id
      playback.fail(id, ERROR_NO_PLAYABLE_TRACKS)
      return false
    }

    const id = playback.beginRequest('play', 'starting')
    activeRequestId = id

    const playableCount = await syncActiveAudios(true, offset, id).catch((cause) => {
      if (id !== activeRequestId) return -1
      playback.fail(id, cause instanceof Error ? cause.message : String(cause))
      return 0
    })

    if (id !== activeRequestId) return false
    if (intent.value !== 'play') return false

    if (playableCount <= 0) {
      if (!error.value) playback.fail(id, ERROR_NO_LOADED_AUDIO)
      return false
    }

    if (!playback.finishPlay(id)) return false
    playbackAnchorTime = performance.now() / 1000 - currentTime.value
    followPlayhead('seek')
    stopRaf()
    rafId = requestAnimationFrame(tick)
    return true
  }

  function requestPause(reset = false) {
    const nextTime = reset ? 0 : clampTime(sampleCurrentTime())
    const id = playback.beginRequest('pause', 'pausing')
    activeRequestId = id
    finishPaused(id, nextTime)
    return true
  }

  function toggleTransport() {
    if (intent.value === 'play') {
      requestPause(false)
      return Promise.resolve(true)
    }
    return requestPlay(currentTime.value)
  }

  function stop(reset = true) {
    requestPause(reset)
  }

  function tick() {
    if (intent.value !== 'play' || status.value !== 'playing') {
      stopRaf()
      return
    }

    const time = clampTime(sampleCurrentTime())
    playback.setCurrentTime(time)
    applyTrackVolumes(time)
    updateLevelMeter()
    followPlayhead()

    const total = computeDuration()
    if (total > 0 && time >= total - 0.04) {
      if (loop.value && intent.value === 'play') {
        const id = playback.beginRequest('play', 'starting')
        activeRequestId = id
        void syncActiveAudios(true, 0, id).then((count) => {
          if (id !== activeRequestId || intent.value !== 'play') return
          if (count <= 0) {
            playback.fail(id, ERROR_NO_LOADED_AUDIO)
            return
          }
          if (!playback.finishPlay(id)) return
          playback.setCurrentTime(0)
          playbackAnchorTime = performance.now() / 1000
          followPlayhead('seek')
          stopRaf()
          rafId = requestAnimationFrame(tick)
        }).catch((cause) => {
          playback.fail(id, cause instanceof Error ? cause.message : String(cause))
        })
        return
      }

      requestPause(true)
      return
    }

    rafId = requestAnimationFrame(tick)
  }

  function seek(time: number) {
    const next = clampTime(time)
    syncPausedAudiosToTime(next)

    if (intent.value === 'play') {
      followPlayhead('seek')
      const id = playback.beginRequest('play', 'starting')
      activeRequestId = id
      void syncActiveAudios(true, next, id).then((count) => {
        if (id !== activeRequestId || intent.value !== 'play') return
        if (count <= 0) {
          playback.fail(id, ERROR_NO_LOADED_AUDIO)
          return
        }
        if (!playback.finishPlay(id)) return
        stopRaf()
        rafId = requestAnimationFrame(tick)
      }).catch((cause) => {
        playback.fail(id, cause instanceof Error ? cause.message : String(cause))
      })
    }
  }

  function applyMasterVolume() {
    applyMasterAudioSettings()
    applyTrackVolumes(currentTime.value)
  }

  watch(() => editor.masterVolume, () => {
    applyMasterVolume()
  })

  watch(() => editor.masterPan, () => {
    applyMasterAudioSettings()
  })

  watch(
    () => editor.session?.id || '',
    () => {
      stop(true)
      releaseAudios()
      playback.clearError()
    },
  )

  watch(
    () => trackSignature(),
    () => {
      if (intent.value === 'play') {
        const id = playback.beginRequest('play', 'starting')
        activeRequestId = id
        void syncActiveAudios(true, currentTime.value, id).then((count) => {
          if (id !== activeRequestId || intent.value !== 'play') return
          if (count <= 0) {
            playback.fail(id, ERROR_NO_LOADED_AUDIO)
            return
          }
          if (!playback.finishPlay(id)) return
          stopRaf()
          rafId = requestAnimationFrame(tick)
        }).catch((cause) => {
          playback.fail(id, cause instanceof Error ? cause.message : String(cause))
        })
      } else {
        syncPausedAudiosToTime(currentTime.value)
        void preloadActiveTracks()
      }
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    stop(true)
    releaseAudios()
    if (audioContext) {
      void audioContext.close().catch(() => undefined)
      audioContext = null
    }
  })

  return {
    intent,
    status,
    transportVisualState,
    transportPendingAction,
    transportCanToggle,
    isBusy,
    isActuallyPlaying,
    shouldFollowPlayhead,
    playbackError: error,
    currentTime,
    loop,
    level,
    masterLevel,
    trackLevels,
    requestId,
    requestPlay,
    requestPause,
    toggleTransport,
    stop,
    seek,
    applyMasterVolume,
    preloadActiveTracks,
  }
}
