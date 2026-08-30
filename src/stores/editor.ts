import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import i18n, { getCurrentLocale } from '@/i18n'
import {
  overwriteClipsInRange,
  syncSingleClipFadeCompatibility,
  timelineDuration,
} from '@/utils/editorClips'
import { registerWindowCloseGuard } from '@/utils/windowCloseGuards'
import { isTauriRuntime } from '@/utils/appStore'
import type { SeparationTask, StemOutput } from '@/stores/task'
import type {
  EditorExportFormat,
  EditorExportOptions,
  EditorProjectSummary,
  EditorSession,
  EditorSource,
  EditorSourceRole,
  EditorClip,
  EditorTrack,
  EditorAssetTreeNode,
} from '@/types/editor'

export type {
  EditorExportFormat,
  EditorExportOptions,
  EditorProjectSummary,
  EditorSession,
  EditorSource,
  EditorSourceRole,
  EditorTrack,
  EditorAssetTreeNode,
} from '@/types/editor'

type HistorySnapshot = {
  tracks: EditorTrack[]
  masterVolume: number
  masterPan: number
  selectedTrackId: string | null
  selectedClipId: string | null
}

type ScanAudioPathsResult = {
  files: string[]
  warnings: string[]
}

type LinkedEditorAsset = {
  path: string
  name: string
  originKind: string
  originRoot?: string | null
  relativePath?: string | null
  missing?: boolean
}

type ImportEditorAssetsResult = {
  files: LinkedEditorAsset[]
  warnings: string[]
}

type EditorProjectCleanupResult = {
  deletedProjectIds: string[]
  missingProjectIds: string[]
  blockedProjectIds: string[]
  failedProjectIds: string[]
}

export type OrphanedEditorProject = {
  projectId: string
  sourceTaskId: string
  name: string
}

type RelinkEditorSourcesResult = {
  project: PersistedSession
  relinked: number
  unresolved: string[]
}

type PickFileResult = string | null

type AudioMetadata = {
  path: string
  name: string
  duration: number
  sampleRate: number
  channels: number
}

type WaveformPeaks = {
  path: string
  peaksPath: string
  peaks: number[]
  channelPeaks?: number[][]
  duration: number
  sampleRate: number
  channels: number
}

type LoadedWaveformPeaks = {
  peaks: number[]
  channelPeaks: number[][]
}

type ExportResult = {
  path: string
  duration: number
  sampleRate: number
  channels: number
  format: string
}

type PersistedSession = EditorSession & { version?: number }

const HISTORY_LIMIT = 80
const AUTO_SAVE_DELAY = 420
const WAVEFORM_FULL_RESOLUTION = 2200
const COLOR_BY_STEM: Record<string, string> = {
  vocals: '#ff6b7c',
  vocal: '#ff6b7c',
  voice: '#ff6b7c',
  accompaniment: '#5d8dff',
  instrumental: '#5d8dff',
  instruments: '#5d8dff',
  drums: '#f2b45a',
  drum: '#f2b45a',
  bass: '#4fc58f',
  other: '#b08cff',
}

function makeId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function fileName(path: string) {
  return path.split(/[/\\]/).pop() || path
}

function stripExt(name: string) {
  return name.replace(/\.[^/.\\]+$/, '')
}

function safeProjectToken(value: string) {
  const normalized = String(value || '')
    .split('')
    .map((ch) => (/^[a-zA-Z0-9._-]$/.test(ch) ? ch : '_'))
    .join('')
    .replace(/^_+|_+$/g, '')
  const trimmed = normalized || 'project'
  return trimmed.slice(0, 96)
}

function projectIdForTaskId(taskId: string) {
  return `edit_${safeProjectToken(taskId)}`
}

function blankProjectName() {
  const locale = getCurrentLocale()
  return String(i18n.global.t('projects.blankProjectDefaultName', {}, { locale }))
}

export function isDefaultBlankProjectName(name: string) {
  const normalized = String(name || '').trim()
  if (!normalized) return true
  return normalized === '未命名工程'
    || normalized === '未命名空工程'
    || normalized === 'Untitled Project'
    || normalized === 'Untitled Blank Project'
}

function stemKeyFromOutput(output: StemOutput | { stem?: string; path?: string }) {
  const raw = String(output.stem || stripExt(fileName(output.path || ''))).trim().toLowerCase()
  if (!raw) return 'other'
  if (raw.includes('vocal') || raw.includes('voice')) return 'vocals'
  if (raw.includes('instrument') || raw.includes('accompaniment') || raw.includes('karaoke')) return 'accompaniment'
  if (raw.includes('drum')) return 'drums'
  if (raw.includes('bass')) return 'bass'
  if (raw.includes('other')) return 'other'
  return raw
}

function displayStemName(stemKey: string, fallback: string) {
  if (stemKey === 'vocals') return '人声'
  if (stemKey === 'accompaniment') return '伴奏'
  if (stemKey === 'drums') return '鼓组'
  if (stemKey === 'bass') return '贝斯'
  if (stemKey === 'other') return '其他'
  return fallback
}

function trackColor(role: EditorSourceRole, stemKey?: string | null) {
  if (role === 'recording') return '#e76f91'
  if (role === 'reference') return '#93a1b6'
  return COLOR_BY_STEM[String(stemKey || '').toLowerCase()] || '#7aa2ff'
}

function duplicatedTrackColor(source: EditorSource) {
  if (source.role === 'stem') return trackColor('stem', source.stemKey)
  return trackColor(source.role, source.stemKey)
}

function cloneTracks(tracks: EditorTrack[]) {
  return tracks.map((track) => ({
    ...track,
    clips: track.clips?.map((clip) => ({ ...clip })),
  }))
}

function normalizeSource(source: Partial<EditorSource>): EditorSource {
  const channelPeaks = Array.isArray(source.channelPeaks)
    ? source.channelPeaks
        .filter((channel) => Array.isArray(channel))
        .map((channel) => channel.map((value) => Number(value || 0)))
    : []
  const channelCount = Math.max(Number(source.channels || 0), channelPeaks.length)
  return {
    id: String(source.id || makeId('source')),
    role: source.role === 'reference' || source.role === 'recording' ? source.role : 'stem',
    stemKey: source.stemKey ? String(source.stemKey) : null,
    path: String(source.path || ''),
    name: String(source.name || fileName(String(source.path || '')) || 'Untitled'),
    duration: Number(source.duration || 0),
    sampleRate: Number(source.sampleRate || 0),
    channels: channelCount,
    peaksPath: source.peaksPath ? String(source.peaksPath) : null,
    peaks: Array.isArray(source.peaks) ? source.peaks.map((value) => Number(value || 0)) : [],
    channelPeaks,
    originKind: source.originKind ? String(source.originKind) : undefined,
    originRoot: source.originRoot ? String(source.originRoot) : null,
    relativePath: source.relativePath ? String(source.relativePath) : null,
    missing: Boolean(source.missing),
  }
}

function normalizePathKey(value: string) {
  return value.replace(/\\/g, '/').toLowerCase()
}

function sourceDisplayGroup(source: EditorSource) {
  if (source.role === 'recording') return '录音'
  if (source.originKind === 'task-result' || source.role === 'stem') return '分离结果'
  return '外部资产'
}

function resolveAssetUrl(path: string) {
  try {
    return convertFileSrc(path)
  } catch {
    const normalized = path.replace(/\\/g, '/')
    if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${normalized}`
    return path
  }
}

async function loadPeaksFromCache(path?: string | null, sourcePath?: string | null) {
  if (!path) return null
  try {
    const response = await fetch(resolveAssetUrl(path))
    if (!response.ok) return null
    const data = await response.json() as { path?: unknown, peaks?: unknown, channelPeaks?: unknown }
    if (sourcePath && typeof data.path === 'string' && normalizePathKey(data.path) !== normalizePathKey(sourcePath)) {
      return null
    }
    if (!Array.isArray(data.peaks)) return null
    return {
      peaks: data.peaks.map((value) => Number(value || 0)),
      channelPeaks: Array.isArray(data.channelPeaks)
        ? data.channelPeaks
            .filter((channel) => Array.isArray(channel))
            .map((channel) => channel.map((value) => Number(value || 0)))
        : [],
    }
  } catch {
    return null
  }
}

function normalizeClip(clip: Partial<EditorClip>, source?: EditorSource): EditorClip {
  const offset = clamp(Number(clip.offset || 0), 0, Math.max(0, Number(source?.duration || Infinity)))
  const availableDuration = Math.max(0, Number(source?.duration || 0) - offset)
  const requestedDuration = Math.max(0, Number(clip.duration ?? availableDuration))
  const duration = availableDuration > 0 ? Math.min(requestedDuration, availableDuration) : requestedDuration
  return {
    id: String(clip.id || makeId('clip')),
    assetId: String(clip.assetId || source?.id || ''),
    start: Math.max(0, Number(clip.start || 0)),
    offset,
    duration,
    volume: clamp(Number(clip.volume ?? 1), 0, 2),
    fadeIn: clamp(Number(clip.fadeIn || 0), 0, duration),
    fadeOut: clamp(Number(clip.fadeOut || 0), 0, duration),
    muted: Boolean(clip.muted),
    locked: Boolean(clip.locked),
  }
}

function normalizeTrack(
  track: Partial<EditorTrack>,
  sources: Map<string, EditorSource>,
  clipFadesCanonical: boolean,
): EditorTrack {
  const source = sources.get(String(track.sourceId || ''))
  const role = track.role === 'reference' || track.role === 'recording'
    ? track.role
    : (source?.role || 'stem')
  const stemKey = source?.stemKey || null
  const clips = Array.isArray(track.clips)
    ? track.clips
        .map((clip) => normalizeClip(clip, sources.get(String(clip.assetId || track.sourceId || ''))))
        .filter((clip) => clip.assetId && clip.duration > 0)
    : []
  if (!clips.length && source && source.duration > 0) {
    clips.push(normalizeClip({
      id: `clip_${String(track.id || source.id)}`,
      assetId: source.id,
      duration: source.duration,
      fadeIn: Number(track.fadeIn || 0),
      fadeOut: Number(track.fadeOut || 0),
    }, source))
  }
  let fadeIn = Math.max(0, Number(track.fadeIn || 0))
  let fadeOut = Math.max(0, Number(track.fadeOut || 0))
  if (clips.length === 1) {
    const clip = clips[0]
    if (clipFadesCanonical) {
      fadeIn = clip.fadeIn
      fadeOut = clip.fadeOut
    } else {
      clip.fadeIn = clamp(fadeIn, 0, clip.duration)
      clip.fadeOut = clamp(fadeOut, 0, clip.duration)
      fadeIn = clip.fadeIn
      fadeOut = clip.fadeOut
    }
  }
  return {
    id: String(track.id || makeId('track')),
    sourceId: String(track.sourceId || source?.id || ''),
    role,
    name: String(track.name || source?.name || 'Track'),
    color: String(track.color || trackColor(role, stemKey)),
    volume: clamp(Number(track.volume ?? 1), 0, 2),
    pan: clamp(Number(track.pan ?? 0), -1, 1),
    muted: Boolean(track.muted),
    solo: Boolean(track.solo),
    fadeIn,
    fadeOut,
    type: track.type === 'recording' || role === 'recording'
      ? 'recording'
      : (track.type === 'audio' ? 'audio' : role),
    clips,
  }
}

function normalizeSession(session: PersistedSession): EditorSession {
  const sources = Array.isArray(session.sources)
    ? session.sources.map(normalizeSource)
    : []
  const sourceMap = new Map(sources.map((source) => [source.id, source]))
  const clipFadesCanonical = Number(session.version || 0) >= 3
  const tracks = Array.isArray(session.tracks)
    ? session.tracks.map((track) => normalizeTrack(track, sourceMap, clipFadesCanonical))
    : []

  return {
    id: String(session.id || makeId('session')),
    name: String(session.name || 'Untitled Session'),
    sourceTaskId: session.sourceTaskId ? String(session.sourceTaskId) : undefined,
    sourceResultDir: session.sourceResultDir ? String(session.sourceResultDir) : undefined,
    masterVolume: clamp(Number(session.masterVolume ?? 1), 0, 2),
    masterPan: clamp(Number(session.masterPan ?? 0), -1, 1),
    sources,
    tracks,
    createdAt: Number(session.createdAt || Date.now()),
    updatedAt: Number(session.updatedAt || Date.now()),
  }
}

function toPersistedSession(session: EditorSession) {
  return {
    ...session,
    version: 3,
    tracks: cloneTracks(session.tracks),
    sources: session.sources.map((source) => ({
      ...source,
      peaks: [],
      channelPeaks: [],
    })),
  }
}

const hasPeaks = (p?: number[]) => p !== undefined && p.length > 0 && !(p.length === 1 && p[0] === -1)

function hasRenderablePeaks(source: EditorSource) {
  return hasPeaks(source.peaks) && (source.channels < 2 || (source.channelPeaks?.length || 0) >= 2)
}

function cachedPeaksMatchSource(source: EditorSource, peaks: LoadedWaveformPeaks) {
  return source.channels < 2 || peaks.channelPeaks.length >= 2
}

function sourceToExportAsset(source: EditorSource) {
  return {
    id: source.id,
    path: source.path,
    name: source.name,
    duration: source.duration,
    sampleRate: source.sampleRate,
    channels: source.channels,
    peaksPath: source.peaksPath || null,
    peaks: [],
  }
}

function runLimited<T>(items: T[], limit: number, runner: (item: T) => Promise<void>) {
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index]
      index += 1
      await runner(item)
    }
  })
  return Promise.all(workers)
}

function trackToExportTrack(track: EditorTrack, source?: EditorSource) {
  const clips = track.clips?.length
    ? track.clips.map((clip) => ({ ...clip }))
    : [{
        id: `clip_${track.id}`,
        assetId: track.sourceId,
        start: 0,
        offset: 0,
        duration: source?.duration || 0,
        volume: 1,
        fadeIn: track.fadeIn,
        fadeOut: track.fadeOut,
        muted: false,
        locked: false,
      }]
  return {
    id: track.id,
    sourceId: track.sourceId,
    name: track.name,
    type: track.role,
    volume: track.volume,
    pan: track.pan,
    muted: track.muted,
    solo: track.solo,
    clips,
  }
}

export const useEditorStore = defineStore('editor', () => {
  const session = ref<EditorSession | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const exporting = ref(false)
  const lastExport = ref<ExportResult | null>(null)
  const lastError = ref<string | null>(null)
  const selectedTrackId = ref<string | null>(null)
  const selectedClipId = ref<string | null>(null)
  const pixelsPerSecond = ref(96)
  const exportFormat = ref<EditorExportFormat>('wav')
  const projectSummaries = ref<EditorProjectSummary[]>([])

  const undoStack = ref<HistorySnapshot[]>([])
  const redoStack = ref<HistorySnapshot[]>([])
  const interactionDepth = ref(0)
  const pendingPeaks = new Map<string, Promise<EditorSource | null>>()

  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)
  const masterVolume = computed(() => session.value?.masterVolume ?? 1)
  const masterPan = computed(() => session.value?.masterPan ?? 0)

  const sourceMap = computed(() => {
    const map = new Map<string, EditorSource>()
    session.value?.sources.forEach((source) => map.set(source.id, source))
    return map
  })

  const selectedTrack = computed(() => {
    if (!session.value || !selectedTrackId.value) return null
    return session.value.tracks.find((track) => track.id === selectedTrackId.value) || null
  })

  const selectedClip = computed(() => {
    const track = selectedTrack.value
    if (!track || !selectedClipId.value) return null
    return track.clips?.find((clip) => clip.id === selectedClipId.value) || null
  })

  const selectedSource = computed(() => {
    const track = selectedTrack.value
    if (!track) return null
    return sourceMap.value.get(selectedClip.value?.assetId || '')
      || sourceMap.value.get(track.sourceId)
      || sourceMap.value.get(track.clips?.[track.clips.length - 1]?.assetId || '')
      || null
  })

  const stemTracks = computed(() => session.value?.tracks.filter((track) => track.role === 'stem') || [])
  const referenceTracks = computed(() => session.value?.tracks.filter((track) => track.role === 'reference') || [])
  const assetTree = computed<EditorAssetTreeNode[]>(() => {
    if (!session.value) return []
    const root: EditorAssetTreeNode = {
      key: '__root__',
      name: 'Assets',
      path: '',
      expanded: true,
      children: [],
      assets: [],
    }
    const folderMap = new Map<string, EditorAssetTreeNode>([[root.key, root]])

    const ensureFolder = (parts: string[]) => {
      let current = root
      let currentPath = ''
      for (const part of parts) {
        if (!part) continue
        currentPath = currentPath ? `${currentPath}/${part}` : part
        const key = `folder:${currentPath.toLowerCase()}`
        let next = folderMap.get(key)
        if (!next) {
          next = {
            key,
            name: part,
            path: currentPath,
            expanded: currentPath.split('/').length <= 1,
            children: [],
            assets: [],
          }
          folderMap.set(key, next)
          current.children.push(next)
        }
        current = next
      }
      return current
    }

    for (const source of session.value.sources) {
      const groupName = sourceDisplayGroup(source)
      const relative = String(source.relativePath || '').replace(/\\/g, '/')
      const parts = [groupName, ...relative.split('/').slice(0, -1).filter(Boolean)]
      ensureFolder(parts).assets.push(source)
    }

    const sortTree = (node: EditorAssetTreeNode) => {
      node.children.sort((a, b) => a.name.localeCompare(b.name))
      node.assets.sort((a, b) => a.name.localeCompare(b.name))
      node.children.forEach(sortTree)
    }
    sortTree(root)
    return root.children.length ? root.children : [{ ...root, name: 'Assets' }]
  })

  const duration = computed(() => {
    return session.value ? timelineDuration(session.value.tracks, sourceMap.value) : 0
  })

  function snapshot(): HistorySnapshot | null {
    if (!session.value) return null
    return {
      tracks: cloneTracks(session.value.tracks),
      masterVolume: session.value.masterVolume,
      masterPan: session.value.masterPan,
      selectedTrackId: selectedTrackId.value,
      selectedClipId: selectedClipId.value,
    }
  }

  function applySnapshot(next: HistorySnapshot) {
    if (!session.value) return
    session.value.tracks = cloneTracks(next.tracks)
    session.value.masterVolume = next.masterVolume
    session.value.masterPan = next.masterPan
    selectedTrackId.value = next.selectedTrackId
    selectedClipId.value = next.selectedClipId
  }

  function pushHistory() {
    if (interactionDepth.value > 0) return
    const snap = snapshot()
    if (!snap) return
    undoStack.value.push(snap)
    if (undoStack.value.length > HISTORY_LIMIT) undoStack.value.shift()
    redoStack.value = []
  }

  function undo() {
    if (!session.value || !undoStack.value.length) return
    const current = snapshot()
    const previous = undoStack.value.pop()!
    if (current) redoStack.value.push(current)
    applySnapshot(previous)
    scheduleSave()
  }

  function redo() {
    if (!session.value || !redoStack.value.length) return
    const current = snapshot()
    const next = redoStack.value.pop()!
    if (current) undoStack.value.push(current)
    applySnapshot(next)
    scheduleSave()
  }

  function beginInteraction() {
    if (interactionDepth.value === 0) pushHistory()
    interactionDepth.value += 1
  }

  function commitInteraction() {
    if (interactionDepth.value > 0) interactionDepth.value -= 1
    if (interactionDepth.value === 0) scheduleSave()
  }

  function clearHistory() {
    undoStack.value = []
    redoStack.value = []
    interactionDepth.value = 0
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let saveDrainTask: Promise<EditorSession | null> | null = null
  const pendingProjectSaves = new Map<string, PersistedSession>()
  const suspendedProjectSaves = new Set<string>()

  function queueSessionSave() {
    if (!session.value) return null
    const project = toPersistedSession(session.value)
    if (suspendedProjectSaves.has(project.id)) return null
    pendingProjectSaves.set(project.id, project)
    return project.id
  }

  async function drainPendingSaves() {
    if (saveDrainTask) return saveDrainTask
    const task = (async () => {
      saving.value = true
      try {
        while (pendingProjectSaves.size) {
          const next = pendingProjectSaves.entries().next().value as [string, PersistedSession] | undefined
          if (!next) break
          const [projectId, project] = next
          pendingProjectSaves.delete(projectId)
          try {
            const result = await invoke<PersistedSession>('save_editor_project', { project })
            if (session.value?.id === projectId && result.updatedAt) {
              session.value.updatedAt = Number(result.updatedAt)
            }
            lastError.value = null
          } catch (error) {
            // Keep a newer snapshot if edits arrived while this save was in flight.
            if (!pendingProjectSaves.has(projectId)) pendingProjectSaves.set(projectId, project)
            lastError.value = error instanceof Error ? error.message : String(error)
            throw error
          }
        }
        return session.value
      } finally {
        saving.value = false
      }
    })()
    saveDrainTask = task
    try {
      return await task
    } finally {
      if (saveDrainTask === task) saveDrainTask = null
    }
  }

  function scheduleSave() {
    if (!queueSessionSave()) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void drainPendingSaves().catch(() => undefined)
    }, AUTO_SAVE_DELAY)
  }

  async function flushSave() {
    queueSessionSave()
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    return drainPendingSaves()
  }

  // The store outlives the editor route. Keeping persistence here ensures a
  // delayed autosave is still flushed when the user closes from another page.
  registerWindowCloseGuard(async () => {
    await flushSave()
  }, -100)

  function selectTrack(trackId: string | null) {
    selectedTrackId.value = trackId
    const track = session.value?.tracks.find((item) => item.id === trackId)
    if (!track?.clips?.some((clip) => clip.id === selectedClipId.value)) {
      selectedClipId.value = track?.clips?.[0]?.id || null
    }
  }

  function selectClip(trackId: string, clipId: string) {
    const track = session.value?.tracks.find((item) => item.id === trackId)
    if (!track?.clips?.some((clip) => clip.id === clipId)) return
    selectedTrackId.value = trackId
    selectedClipId.value = clipId
  }

  async function requestProjectFromTask(task: SeparationTask) {
    return invoke<PersistedSession>('create_editor_project_from_task', {
      payload: {
        taskId: task.id,
        input: task.input,
        outputDir: task.output,
        outputs: task.outputs as StemOutput[],
      },
    })
  }

  async function createFromTask(task: SeparationTask) {
    loading.value = true
    lastError.value = null
    try {
      const result = await requestProjectFromTask(task)
      session.value = normalizeSession(result)
      selectTrack(session.value.tracks[0]?.id || null)
      await hydratePeaksFromCache(session.value.id)
      const metadataChanged = await hydrateSourceMetadataState(session.value.id)
      clearHistory()
      const currentProjectId = session.value.id
      if (metadataChanged) await saveProject()
      hydrateSessionSourcesInBackground(currentProjectId)
      return session.value
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      loading.value = false
    }
  }

  async function openProjectWindow(projectId: string) {
    return invoke('open_editor_window', { payload: { projectId } })
  }

  async function projectExists(projectId: string) {
    return invoke<boolean>('editor_project_exists', { projectId })
  }

  async function ensureProjectForTask(task: SeparationTask, options?: { loadIntoSession?: boolean }) {
    const loadIntoSession = options?.loadIntoSession ?? true
    const projectId = projectIdForTaskId(task.id)
    const exists = await projectExists(projectId)
    if (exists) {
      return { id: projectId }
    }
    if (!loadIntoSession) {
      const result = await requestProjectFromTask(task)
      const normalized = normalizeSession(result)
      return { id: normalized.id }
    }
    return createFromTask(task)
  }

  async function listProjects() {
    const result = await invoke<EditorProjectSummary[]>('list_editor_projects')
    projectSummaries.value = [...(result || [])].sort((a, b) => b.updatedAt - a.updatedAt)
    return projectSummaries.value
  }

  async function refreshProjects() {
    return listProjects()
  }

  // Keep this interface for the future import-first editor flow. The visible
  // blank-project entry is hidden until external audio import has clear UI.
  async function createBlankProject(name?: string) {
    const locale = getCurrentLocale()
    const result = await invoke<PersistedSession>('create_blank_editor_project', {
      payload: {
        name: name?.trim() || blankProjectName(),
        locale,
      },
    })
    const normalized = normalizeSession(result)
    const summary: EditorProjectSummary = {
      id: normalized.id,
      name: normalized.name,
      sourceTaskId: normalized.sourceTaskId,
      sourceResultDir: normalized.sourceResultDir,
      createdAt: normalized.createdAt,
      updatedAt: normalized.updatedAt,
      type: normalized.sourceTaskId ? 'task' : 'blank',
    }
    projectSummaries.value = [summary, ...projectSummaries.value.filter((item) => item.id !== summary.id)]
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return normalized
  }

  async function deleteProject(projectId: string) {
    // Serialize deletion after queued writes so a delayed autosave cannot
    // recreate the project after the backend removes it.
    await drainPendingSaves()
    suspendedProjectSaves.add(projectId)
    pendingProjectSaves.delete(projectId)
    let result: boolean
    try {
      result = await invoke<boolean>('delete_editor_project', { projectId })
    } catch (error) {
      suspendedProjectSaves.delete(projectId)
      if (session.value?.id === projectId) scheduleSave()
      throw error
    }
    projectSummaries.value = projectSummaries.value.filter((item) => item.id !== projectId)
    if (session.value?.id === projectId) {
      session.value = null
      selectedTrackId.value = null
      selectedClipId.value = null
      clearHistory()
    }
    suspendedProjectSaves.delete(projectId)
    return result
  }

  async function deleteProjectsForTasks(taskIds: string[]) {
    const uniqueTaskIds = [...new Set(taskIds.map(id => id.trim()).filter(Boolean))]
    const projectIds = uniqueTaskIds.map(projectIdForTaskId)
    const emptyResult = (): EditorProjectCleanupResult => ({
      deletedProjectIds: [],
      missingProjectIds: [],
      blockedProjectIds: [],
      failedProjectIds: [],
    })
    if (!projectIds.length) return emptyResult()
    if (!isTauriRuntime()) {
      return { ...emptyResult(), missingProjectIds: projectIds }
    }

    await drainPendingSaves()
    projectIds.forEach((projectId) => {
      suspendedProjectSaves.add(projectId)
      pendingProjectSaves.delete(projectId)
    })
    try {
      const result = await invoke<EditorProjectCleanupResult>('delete_editor_projects_for_tasks', {
        taskIds: uniqueTaskIds,
      })
      const removedProjectIds = new Set([
        ...(result.deletedProjectIds || []),
        ...(result.missingProjectIds || []),
      ])
      projectSummaries.value = projectSummaries.value.filter(item => !removedProjectIds.has(item.id))
      if (session.value && removedProjectIds.has(session.value.id)) clearSession()
      return {
        deletedProjectIds: result.deletedProjectIds || [],
        missingProjectIds: result.missingProjectIds || [],
        blockedProjectIds: result.blockedProjectIds || [],
        failedProjectIds: result.failedProjectIds || [],
      }
    } finally {
      projectIds.forEach(projectId => suspendedProjectSaves.delete(projectId))
    }
  }

  async function listOpenProjectsForTasks(taskIds: string[]) {
    const uniqueTaskIds = [...new Set(taskIds.map(id => id.trim()).filter(Boolean))]
    if (!uniqueTaskIds.length || !isTauriRuntime()) return []
    const backendOpenProjectIds = await invoke<string[]>('list_open_editor_projects_for_tasks', {
      taskIds: uniqueTaskIds,
    })
    return [...new Set(backendOpenProjectIds || [])]
  }

  async function listOrphanedProjects(activeTaskIds: string[]) {
    if (!isTauriRuntime()) return [] as OrphanedEditorProject[]
    return invoke<OrphanedEditorProject[]>('list_orphaned_editor_projects', {
      activeTaskIds: [...new Set(activeTaskIds.map(id => id.trim()).filter(Boolean))],
    })
  }

  async function deleteOrphanedProjects(activeTaskIds: string[]) {
    const emptyResult = (): EditorProjectCleanupResult => ({
      deletedProjectIds: [],
      missingProjectIds: [],
      blockedProjectIds: [],
      failedProjectIds: [],
    })
    if (!isTauriRuntime()) return emptyResult()
    const orphanedProjects = await listOrphanedProjects(activeTaskIds)
    const projectIds = orphanedProjects.map(project => project.projectId)
    if (!projectIds.length) return emptyResult()
    await drainPendingSaves()
    projectIds.forEach((projectId) => {
      suspendedProjectSaves.add(projectId)
      pendingProjectSaves.delete(projectId)
    })
    try {
      const result = await invoke<EditorProjectCleanupResult>('delete_orphaned_editor_projects', {
        activeTaskIds: [...new Set(activeTaskIds.map(id => id.trim()).filter(Boolean))],
      })
      const removedProjectIds = new Set([
        ...(result.deletedProjectIds || []),
        ...(result.missingProjectIds || []),
      ])
      projectSummaries.value = projectSummaries.value.filter(item => !removedProjectIds.has(item.id))
      if (session.value && removedProjectIds.has(session.value.id)) clearSession()
      return {
        deletedProjectIds: result.deletedProjectIds || [],
        missingProjectIds: result.missingProjectIds || [],
        blockedProjectIds: result.blockedProjectIds || [],
        failedProjectIds: result.failedProjectIds || [],
      }
    } finally {
      projectIds.forEach(projectId => suspendedProjectSaves.delete(projectId))
    }
  }

  function clearSession() {
    session.value = null
    selectedTrackId.value = null
    selectedClipId.value = null
    clearHistory()
  }

  async function loadProject(projectId: string) {
    loading.value = true
    lastError.value = null
    try {
      const result = await invoke<PersistedSession>('load_editor_project', { projectId })
      session.value = normalizeSession(result)
      await hydratePeaksFromCache(session.value.id)
      const metadataChanged = await hydrateSourceMetadataState(session.value.id)
      selectTrack(session.value.tracks[0]?.id || null)
      clearHistory()
      const currentProjectId = session.value.id
      if (metadataChanged) await saveProject()
      hydrateSessionSourcesInBackground(currentProjectId)
      return session.value
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      loading.value = false
    }
  }

  async function saveProject() {
    if (!queueSessionSave() && !pendingProjectSaves.size) return null
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    return drainPendingSaves()
  }

  async function getMetadata(path: string) {
    return invoke<AudioMetadata>('get_audio_metadata', { payload: { path } })
  }

  async function ensurePeaks(sourceId: string) {
    if (!session.value) return null
    const source = session.value.sources.find((item) => item.id === sourceId)
    if (!source || source.missing || hasRenderablePeaks(source)) return source || null

    const cachedPeaks = await loadPeaksFromCache(source.peaksPath, source.path)
    if (cachedPeaks?.peaks.length && cachedPeaksMatchSource(source, cachedPeaks)) {
      source.peaks = cachedPeaks.peaks
      source.channelPeaks = cachedPeaks.channelPeaks
      return source
    }

    const pending = pendingPeaks.get(sourceId)
    if (pending) return pending
    const projectId = session.value.id
    const task = (async () => {
      try {
        const result = await invoke<WaveformPeaks>('generate_waveform_peaks', {
          payload: {
            projectId,
            path: source.path,
            resolution: WAVEFORM_FULL_RESOLUTION,
          },
        })
        if (!session.value || session.value.id !== projectId) return source
        const current = session.value.sources.find((item) => item.id === sourceId)
        if (!current) return source
        current.peaks = result.peaks?.length ? result.peaks : [-1]
        current.channelPeaks = result.channelPeaks || []
        current.peaksPath = result.peaksPath
        current.duration = Number(result.duration || current.duration)
        current.sampleRate = Number(result.sampleRate || current.sampleRate)
        current.channels = Number(result.channels || current.channels)
        return current
      } catch {
        return source
      } finally {
        pendingPeaks.delete(sourceId)
      }
    })()
    pendingPeaks.set(sourceId, task)
    return task
  }

  function ensurePeaksInBackground(sourceId: string) {
    void ensurePeaks(sourceId)
      .then(() => {
        if (!session.value) return
        scheduleSave()
      })
      .catch(() => {})
  }

  async function ensurePeaksForAllSources(projectId = session.value?.id || '') {
    if (!session.value || !projectId || session.value.id !== projectId) return
    const sources = [...session.value.sources]
    await runLimited(sources, 2, async (source) => {
      if (!session.value || session.value.id !== projectId) return
      if (hasPeaks(source.peaks)) return
      await ensurePeaks(source.id)
    })
  }

  function hydrateSessionSourcesInBackground(projectId: string) {
    void hydrateSessionSources(projectId)
      .then((changed) => {
        if (!changed) return
        if (session.value?.id !== projectId) return
        void saveProject()
      })
      .catch(() => {})
  }

  async function hydrateSourceMetadataState(projectId = session.value?.id || '') {
    if (!session.value || !projectId || session.value.id !== projectId) return false

    let changed = false
    const sources = [...session.value.sources]

    await runLimited(sources, 4, async (source) => {
      if (!session.value || session.value.id !== projectId) return
      const before = {
        name: source.name,
        duration: source.duration,
        sampleRate: source.sampleRate,
        channels: source.channels,
        missing: Boolean(source.missing),
      }
      const metadata = await getMetadata(source.path).catch(() => null)
      if (!session.value || session.value.id !== projectId) return
      source.missing = !metadata
      if (metadata) {
        source.name = metadata.name || source.name
        source.duration = Number(metadata.duration || source.duration)
        source.sampleRate = Number(metadata.sampleRate || source.sampleRate)
        const peakChannels = source.channelPeaks?.filter(channel => channel.length).length || 0
        source.channels = Math.max(Number(metadata.channels || 0), peakChannels, Number(source.channels || 0))
      }
      if (
        source.name !== before.name
        || source.duration !== before.duration
        || source.sampleRate !== before.sampleRate
        || source.channels !== before.channels
        || Boolean(source.missing) !== before.missing
      ) {
        changed = true
      }
    })

    return changed
  }

  async function hydrateSessionSources(projectId = session.value?.id || '') {
    if (!session.value || !projectId || session.value.id !== projectId) return false

    let changed = false
    const sources = [...session.value.sources]

    await runLimited(sources, 2, async (source) => {
      if (!session.value || session.value.id !== projectId) return

      const before = {
        name: source.name,
        duration: source.duration,
        sampleRate: source.sampleRate,
        channels: source.channels,
        peaksPath: source.peaksPath || null,
        peaksCount: source.peaks?.length || 0,
        missing: Boolean(source.missing),
      }

      const metadata = await getMetadata(source.path).catch(() => null)
      if (!session.value || session.value.id !== projectId) return

      source.missing = !metadata
      if (source.missing) {
        source.duration = Number(source.duration || 0)
        source.sampleRate = Number(source.sampleRate || 0)
        source.channels = Number(source.channels || 0)
        source.peaks = Array.isArray(source.peaks) ? source.peaks : []
      } else if (!hasPeaks(source.peaks)) {
        await ensurePeaks(source.id)
      }

      if (metadata) {
        source.name = metadata.name || source.name
        source.duration = Number(metadata.duration || source.duration)
        source.sampleRate = Number(metadata.sampleRate || source.sampleRate)
        const peakChannels = source.channelPeaks?.filter(channel => channel.length).length || 0
        source.channels = Math.max(Number(metadata.channels || 0), peakChannels, Number(source.channels || 0))
      }

      if (
        source.name !== before.name
        || source.duration !== before.duration
        || source.sampleRate !== before.sampleRate
        || source.channels !== before.channels
        || (source.peaksPath || null) !== before.peaksPath
        || (source.peaks?.length || 0) !== before.peaksCount
        || Boolean(source.missing) !== before.missing
      ) {
        changed = true
      }
    })

    return changed
  }

  async function hydratePeaksFromCache(projectId = session.value?.id || '') {
    if (!session.value || !projectId || session.value.id !== projectId) return
    const sources = [...session.value.sources]
    await Promise.allSettled(sources.map(async (source) => {
      if (hasRenderablePeaks(source)) return
      const cachedPeaks = await loadPeaksFromCache(source.peaksPath, source.path)
      if (cachedPeaks?.peaks.length && cachedPeaksMatchSource(source, cachedPeaks) && session.value?.id === projectId) {
        source.peaks = cachedPeaks.peaks
        source.channelPeaks = cachedPeaks.channelPeaks
      }
    }))
  }

  async function addReferenceSourceByPath(path: string) {
    if (!session.value) throw new Error('Editor session is not loaded')
    const source = await ensureSourceByPath(path, {
      originKind: 'external',
      originRoot: path.replace(/[/\\][^/\\]+$/, '') || null,
      relativePath: fileName(path),
    })
    addTrackFromSourceId(source.id)
    return source
  }

  async function ensureSourceByPath(path: string, options?: Partial<EditorSource>) {
    if (!session.value) throw new Error('Editor session is not loaded')
    const normalized = normalizePathKey(path)
    const existing = session.value.sources.find((source) => normalizePathKey(source.path) === normalized)
    if (existing) return existing

    const metadata = await getMetadata(path).catch(() => ({
      path,
      name: fileName(path),
      duration: 0,
      sampleRate: 0,
      channels: 0,
    }))
    const source: EditorSource = {
      id: makeId('source'),
      role: 'reference',
      stemKey: null,
      path,
      name: metadata.name || fileName(path),
      duration: Number(metadata.duration || 0),
      sampleRate: Number(metadata.sampleRate || 0),
      channels: Number(metadata.channels || 0),
      peaksPath: null,
      peaks: [],
      originKind: options?.originKind || 'external',
      originRoot: options?.originRoot ? String(options.originRoot) : null,
      relativePath: options?.relativePath ? String(options.relativePath) : fileName(path),
      missing: !metadata || Boolean(options?.missing),
    }
    session.value.sources.push(source)
    if (!source.missing) ensurePeaksInBackground(source.id)
    scheduleSave()
    return source
  }

  function addTrackFromSourceId(sourceId: string) {
    if (!session.value) throw new Error('Editor session is not loaded')
    const source = session.value.sources.find((item) => item.id === sourceId)
    if (!source) throw new Error('Source asset not found')

    pushHistory()
    const track: EditorTrack = {
      id: makeId('track'),
      sourceId: source.id,
      role: 'reference',
      name: stripExt(source.name),
      color: duplicatedTrackColor(source),
      volume: 1,
      pan: 0,
      muted: false,
      solo: false,
      fadeIn: 0,
      fadeOut: 0,
      type: 'reference',
      clips: [normalizeClip({
        id: makeId('clip'),
        assetId: source.id,
        duration: source.duration,
      }, source)],
    }
    session.value.tracks.push(track)
    selectTrack(track.id)
    scheduleSave()
    return track
  }

  function addRecordingTrack() {
    if (!session.value) throw new Error('Editor session is not loaded')
    pushHistory()
    const index = session.value.tracks.filter((track) => track.role === 'recording').length + 1
    const track: EditorTrack = {
      id: makeId('track'),
      sourceId: '',
      role: 'recording',
      type: 'recording',
      name: String(i18n.global.t('editor.recordingTrackName', { index })),
      color: trackColor('recording'),
      volume: 1,
      pan: 0,
      muted: false,
      solo: false,
      fadeIn: 0,
      fadeOut: 0,
      clips: [],
    }
    session.value.tracks.push(track)
    selectTrack(track.id)
    scheduleSave()
    return track
  }

  async function addRecordingClip(
    trackId: string,
    recording: AudioMetadata,
    start: number,
  ) {
    if (!session.value) throw new Error('Editor session is not loaded')
    pushHistory()
    let track = session.value.tracks.find((item) => item.id === trackId)
    if (!track) {
      const index = session.value.tracks.filter((item) => item.role === 'recording').length + 1
      track = {
        id: makeId('track'),
        sourceId: '',
        role: 'recording',
        type: 'recording',
        name: String(i18n.global.t('editor.recordingTrackName', { index })),
        color: trackColor('recording'),
        volume: 1,
        pan: 0,
        muted: false,
        solo: false,
        fadeIn: 0,
        fadeOut: 0,
        clips: [],
      }
      session.value.tracks.push(track)
    }
    const source: EditorSource = {
      id: makeId('source'),
      role: 'recording',
      stemKey: null,
      path: recording.path,
      name: recording.name || fileName(recording.path),
      duration: Math.max(0, Number(recording.duration || 0)),
      sampleRate: Math.max(0, Number(recording.sampleRate || 0)),
      channels: Math.max(1, Number(recording.channels || 1)),
      peaksPath: null,
      peaks: [],
      channelPeaks: [],
      originKind: 'recording',
      relativePath: `recordings/${recording.name || fileName(recording.path)}`,
      missing: false,
    }
    session.value.sources.push(source)
    track.role = 'recording'
    track.type = 'recording'
    track.sourceId = source.id
    const clip = normalizeClip({
      id: makeId('clip'),
      assetId: source.id,
      start: Math.max(0, Number(start || 0)),
      duration: source.duration,
    }, source)
    const currentClips = track.clips || []
    track.clips = [
      ...overwriteClipsInRange(currentClips, clip.start, clip.duration, () => makeId('clip')),
      clip,
    ].sort((left, right) => left.start - right.start)
    syncSingleClipFadeCompatibility(track)
    selectClip(track.id, clip.id)
    scheduleSave()
    ensurePeaksInBackground(source.id)
    return source
  }

  async function scanAssets(paths: string[]) {
    if (!session.value) throw new Error('Editor session is not loaded')
    const imported = await invoke<ImportEditorAssetsResult>('import_editor_assets', {
      projectId: session.value.id,
      paths,
    })
    for (const asset of imported.files || []) {
      await ensureSourceByPath(asset.path, {
        originKind: asset.originKind,
        originRoot: asset.originRoot || null,
        relativePath: asset.relativePath || fileName(asset.path),
        missing: asset.missing,
      })
    }
    await saveProject()
    return {
      files: (imported.files || []).map((asset) => asset.path),
      warnings: imported.warnings || [],
    } satisfies ScanAudioPathsResult
  }

  function sourcesInUse() {
    if (!session.value) return []
    const sourceIds = new Set(session.value.tracks.flatMap((track) => [
      track.sourceId,
      ...(track.clips || []).map((clip) => clip.assetId),
    ]).filter(Boolean))
    return session.value.sources.filter((source) => sourceIds.has(source.id))
  }

  function missingSources() {
    return session.value?.sources.filter((source) => source.missing) || []
  }

  function missingSourcesInUse() {
    return sourcesInUse().filter((source) => source.missing)
  }

  function assertNoMissingSourcesInUse(message: string) {
    const missing = missingSourcesInUse()
    if (!missing.length) return
    throw new Error(message)
  }

  async function pickRelinkFile() {
    return invoke<PickFileResult>('pick_single_audio_file')
  }

  async function relinkSource(sourceId: string, pickedPath?: string | null) {
    if (!session.value) throw new Error('Editor session is not loaded')
    const source = session.value.sources.find((item) => item.id === sourceId)
    if (!source) throw new Error('Source asset not found')
    const resolvedPath = pickedPath ?? await pickRelinkFile()
    if (!resolvedPath) return null
    const result = await invoke<RelinkEditorSourcesResult>('relink_editor_sources', {
      payload: {
        projectId: session.value.id,
        sourceId,
        pickedPath: resolvedPath,
      },
    })
    session.value = normalizeSession(result.project)
    await hydratePeaksFromCache(session.value.id)
    hydrateSessionSourcesInBackground(session.value.id)
    return result
  }

  async function relinkMissingSources(pickedPath?: string | null) {
    const firstMissing = missingSources()[0]
    if (!firstMissing) return null
    return relinkSource(firstMissing.id, pickedPath)
  }

  function renameTrack(trackId: string, name: string, commit = true) {
    const track = session.value?.tracks.find((item) => item.id === trackId)
    if (!track) return
    const currentName = track.name
    const trimmedName = name.trim()
    const resolvedName = trimmedName || currentName

    if (!commit) {
      if (resolvedName === currentName) return
      track.name = resolvedName
      return
    }

    if (resolvedName === currentName) {
      scheduleSave()
      return
    }

    pushHistory()
    track.name = resolvedName
    scheduleSave()
  }

  function toggleTrackFlag(trackId: string, flag: 'muted' | 'solo') {
    const track = session.value?.tracks.find((item) => item.id === trackId)
    if (!track) return
    pushHistory()
    track[flag] = !track[flag]
    scheduleSave()
  }

  function setTrackVolume(trackId: string, value: number) {
    const track = session.value?.tracks.find((item) => item.id === trackId)
    if (!track) return
    track.volume = clamp(Number(value), 0, 2)
    if (interactionDepth.value === 0) scheduleSave()
  }

  function setTrackPan(trackId: string, value: number) {
    const track = session.value?.tracks.find((item) => item.id === trackId)
    if (!track) return
    track.pan = clamp(Number(value), -1, 1)
    if (interactionDepth.value === 0) scheduleSave()
  }

  function setClipFades(
    trackId: string,
    clipId: string,
    patch: { fadeIn?: number; fadeOut?: number },
  ) {
    const track = session.value?.tracks.find((item) => item.id === trackId)
    const clip = track?.clips?.find((item) => item.id === clipId)
    if (!track || !clip) return
    const maxDuration = Math.max(0, Number(clip.duration || 0))
    pushHistory()
    if (patch.fadeIn !== undefined) clip.fadeIn = clamp(Number(patch.fadeIn || 0), 0, maxDuration)
    if (patch.fadeOut !== undefined) clip.fadeOut = clamp(Number(patch.fadeOut || 0), 0, maxDuration)
    syncSingleClipFadeCompatibility(track)
    scheduleSave()
  }

  function setClipTiming(
    trackId: string,
    clipId: string,
    patch: Partial<Pick<EditorClip, 'start' | 'offset' | 'duration'>>,
  ) {
    const track = session.value?.tracks.find((item) => item.id === trackId)
    const clip = track?.clips?.find((item) => item.id === clipId)
    if (!track || !clip) return
    const source = sourceMap.value.get(clip.assetId)
    const sourceDuration = Math.max(0, Number(source?.duration || 0))
    const maxOffset = sourceDuration > 0 ? Math.max(0, sourceDuration - 0.01) : Number.MAX_SAFE_INTEGER
    const nextOffset = clamp(Number(patch.offset ?? clip.offset), 0, maxOffset)
    const availableDuration = sourceDuration > 0
      ? Math.max(0.01, sourceDuration - nextOffset)
      : Number.MAX_SAFE_INTEGER
    clip.start = Math.max(0, Number(patch.start ?? clip.start))
    clip.offset = nextOffset
    clip.duration = clamp(Number(patch.duration ?? clip.duration), 0.01, availableDuration)
    clip.fadeIn = clamp(clip.fadeIn, 0, clip.duration)
    clip.fadeOut = clamp(clip.fadeOut, 0, clip.duration)
    syncSingleClipFadeCompatibility(track)
    if (interactionDepth.value === 0) scheduleSave()
  }

  function setMasterVolume(value: number) {
    if (!session.value) return
    session.value.masterVolume = clamp(Number(value), 0, 2)
    if (interactionDepth.value === 0) scheduleSave()
  }

  function setMasterPan(value: number) {
    if (!session.value) return
    session.value.masterPan = clamp(Number(value), -1, 1)
    if (interactionDepth.value === 0) scheduleSave()
  }

  function removeTrack(trackId: string) {
    if (!session.value) return
    const track = session.value.tracks.find((item) => item.id === trackId)
    if (!track) return
    pushHistory()
    session.value.tracks = session.value.tracks.filter((item) => item.id !== trackId)
    if (selectedTrackId.value === trackId) {
      selectTrack(session.value.tracks[0]?.id || null)
    }
    scheduleSave()
  }

  function removeClip(trackId: string, clipId: string) {
    const track = session.value?.tracks.find((item) => item.id === trackId)
    const clipIndex = track?.clips?.findIndex((item) => item.id === clipId) ?? -1
    if (!track || clipIndex < 0) return false

    pushHistory()
    const removedClip = track.clips![clipIndex]
    const nextClips = track.clips!.filter((item) => item.id !== clipId)
    track.clips = nextClips
    syncSingleClipFadeCompatibility(track)

    if (track.sourceId === removedClip.assetId && !nextClips.some((item) => item.assetId === removedClip.assetId)) {
      track.sourceId = nextClips[nextClips.length - 1]?.assetId || ''
    }

    if (selectedTrackId.value === trackId && selectedClipId.value === clipId) {
      selectedClipId.value = nextClips[Math.min(clipIndex, nextClips.length - 1)]?.id || null
    }

    scheduleSave()
    return true
  }

  function removeSource(sourceId: string) {
    if (!session.value) return { removedSource: false, removedTracks: 0 }
    const source = session.value.sources.find((item) => item.id === sourceId)
    if (!source) return { removedSource: false, removedTracks: 0 }
    if (source.role === 'stem') return { removedSource: false, removedTracks: 0 }

    pushHistory()
    const removedTrackIds: string[] = []
    session.value.tracks = session.value.tracks.flatMap((track) => {
      const nextClips = (track.clips || []).filter((clip) => clip.assetId !== sourceId)
      const usedByTrack = track.sourceId === sourceId || nextClips.length !== (track.clips || []).length
      if (!usedByTrack) return [track]
      if (!nextClips.length) {
        removedTrackIds.push(track.id)
        return []
      }
      const nextTrack = { ...track, sourceId: nextClips[nextClips.length - 1].assetId, clips: nextClips }
      syncSingleClipFadeCompatibility(nextTrack)
      return [nextTrack]
    })
    session.value.sources = session.value.sources.filter((item) => item.id !== sourceId)

    if (selectedTrackId.value && removedTrackIds.includes(selectedTrackId.value)) {
      selectTrack(session.value.tracks[0]?.id || null)
    } else if (selectedClipId.value && !selectedTrack.value?.clips?.some((clip) => clip.id === selectedClipId.value)) {
      selectTrack(selectedTrackId.value)
    }

    scheduleSave()
    return { removedSource: true, removedTracks: removedTrackIds.length }
  }

  async function exportMix(options?: EditorExportFormat | EditorExportOptions) {
    if (!session.value) throw new Error('Editor session is not loaded')
    assertNoMissingSourcesInUse(String(i18n.global.t('editor.assetOfflineBlocked')))
    const normalized = typeof options === 'string'
      ? { format: options, audioParams: undefined }
      : (options || {})
    const fmt = normalized.format || exportFormat.value
    exporting.value = true
    lastError.value = null
    try {
      const result = await invoke<ExportResult>('export_editor_mix', {
        payload: {
          format: fmt,
          exportDir: normalized.exportDir,
          audioParams: normalized.audioParams || {},
          project: {
            id: session.value.id,
            name: session.value.name,
            masterVolume: session.value.masterVolume,
            masterPan: session.value.masterPan,
            assets: session.value.sources.map(sourceToExportAsset),
            tracks: session.value.tracks.map((track) => trackToExportTrack(track, sourceMap.value.get(track.sourceId))),
          },
        },
      })
      lastExport.value = result
      return result
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      exporting.value = false
    }
  }

  function setZoom(value: number) {
    pixelsPerSecond.value = clamp(Number(value), 4, 240)
  }

  function zoomIn() {
    setZoom(pixelsPerSecond.value + 18)
  }

  function zoomOut() {
    setZoom(pixelsPerSecond.value - 18)
  }

  return {
    session,
    loading,
    saving,
    exporting,
    lastExport,
    lastError,
    projectSummaries,
    selectedTrackId,
    selectedClipId,
    exportFormat,
    selectedTrack,
    selectedClip,
    selectedSource,
    sourceMap,
    stemTracks,
    referenceTracks,
    assetTree,
    pixelsPerSecond,
    masterVolume,
    masterPan,
    canUndo,
    canRedo,
    duration,
    selectTrack,
    selectClip,
    undo,
    redo,
    beginInteraction,
    commitInteraction,
    clearHistory,
    scheduleSave,
    flushSave,
    createFromTask,
    ensureProjectForTask,
    listProjects,
    refreshProjects,
    createBlankProject,
    deleteProject,
    deleteProjectsForTasks,
    listOpenProjectsForTasks,
    listOrphanedProjects,
    deleteOrphanedProjects,
    clearSession,
    openProjectWindow,
    projectExists,
    loadProject,
    saveProject,
    getMetadata,
    ensurePeaks,
    ensurePeaksInBackground,
    hydratePeaksFromCache,
    hydrateSessionSources,
    hydrateSessionSourcesInBackground,
    ensureSourceByPath,
    addReferenceSourceByPath,
    addTrackFromSourceId,
    addRecordingTrack,
    addRecordingClip,
    scanAssets,
    relinkSource,
    relinkMissingSources,
    pickRelinkFile,
    missingSources,
    missingSourcesInUse,
    assertNoMissingSourcesInUse,
    renameTrack,
    toggleTrackFlag,
    setTrackVolume,
    setTrackPan,
    setClipFades,
    setClipTiming,
    setMasterVolume,
    setMasterPan,
    removeTrack,
    removeClip,
    removeSource,
    exportMix,
    setZoom,
    zoomIn,
    zoomOut,
  }
})
