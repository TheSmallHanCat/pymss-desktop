import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import i18n, { getCurrentLocale } from '@/i18n'
import type { SeparationTask, StemOutput } from '@/stores/task'
import type {
  EditorExportFormat,
  EditorExportOptions,
  EditorProjectSummary,
  EditorSession,
  EditorSource,
  EditorSourceRole,
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
}

type ScanAudioPathsResult = {
  files: string[]
  warnings: string[]
}

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
  duration: number
  sampleRate: number
  channels: number
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
  if (role === 'reference') return '#93a1b6'
  return COLOR_BY_STEM[String(stemKey || '').toLowerCase()] || '#7aa2ff'
}

function duplicatedTrackColor(source: EditorSource) {
  if (source.role === 'stem') return trackColor('stem', source.stemKey)
  return trackColor('reference', source.stemKey)
}

function cloneTracks(tracks: EditorTrack[]) {
  return tracks.map((track) => ({
    ...track,
    clips: track.clips?.map((clip) => ({ ...clip })),
  }))
}

function normalizeSource(source: Partial<EditorSource>): EditorSource {
  return {
    id: String(source.id || makeId('source')),
    role: source.role === 'reference' ? 'reference' : 'stem',
    stemKey: source.stemKey ? String(source.stemKey) : null,
    path: String(source.path || ''),
    name: String(source.name || fileName(String(source.path || '')) || 'Untitled'),
    duration: Number(source.duration || 0),
    sampleRate: Number(source.sampleRate || 0),
    channels: Number(source.channels || 0),
    peaksPath: source.peaksPath ? String(source.peaksPath) : null,
    peaks: Array.isArray(source.peaks) ? source.peaks.map((value) => Number(value || 0)) : [],
  }
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

async function loadPeaksFromCache(path?: string | null) {
  if (!path) return null
  try {
    const response = await fetch(resolveAssetUrl(path))
    if (!response.ok) return null
    const data = await response.json() as { peaks?: unknown }
    return Array.isArray(data.peaks)
      ? data.peaks.map((value) => Number(value || 0))
      : null
  } catch {
    return null
  }
}

function normalizeTrack(track: Partial<EditorTrack>, source?: EditorSource): EditorTrack {
  const role = track.role === 'reference' ? 'reference' : (source?.role || 'stem')
  const stemKey = source?.stemKey || null
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
    fadeIn: Math.max(0, Number(track.fadeIn || 0)),
    fadeOut: Math.max(0, Number(track.fadeOut || 0)),
  }
}

function normalizeSession(session: PersistedSession): EditorSession {
  const sources = Array.isArray(session.sources)
    ? session.sources.map(normalizeSource)
    : []
  const sourceMap = new Map(sources.map((source) => [source.id, source]))
  const tracks = Array.isArray(session.tracks)
    ? session.tracks.map((track) => normalizeTrack(track, sourceMap.get(String(track.sourceId || ''))))
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
    version: 2,
    sources: session.sources.map((source) => ({
      ...source,
      peaks: [],
    })),
  }
}

const hasPeaks = (p?: number[]) => p !== undefined && p.length > 0 && !(p.length === 1 && p[0] === -1)

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
  return {
    id: track.id,
    sourceId: track.sourceId,
    name: track.name,
    type: track.role,
    volume: track.volume,
    pan: track.pan,
    muted: track.muted,
    solo: track.solo,
    clips: [{
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
    }],
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

  const selectedSource = computed(() => {
    const track = selectedTrack.value
    return track ? sourceMap.value.get(track.sourceId) || null : null
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

    const sourceResultDir = session.value.sourceResultDir?.replace(/[/\\]+$/, '')
    const projectAssetsMarker = `${session.value.id}`

    for (const source of session.value.sources) {
      const normalizedPath = source.path.replace(/\\/g, '/')
      const groupName = source.role === 'stem' ? '分离结果' : '外部资产'
      let parts: string[] = []
      if (sourceResultDir && source.path.toLowerCase().startsWith(sourceResultDir.toLowerCase())) {
        const relative = source.path.slice(sourceResultDir.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
        parts = [groupName, ...relative.split('/').slice(0, -1)]
      } else {
        const assetsIndex = normalizedPath.toLowerCase().indexOf(`/editor-projects/${projectAssetsMarker.toLowerCase()}/assets/`)
        if (assetsIndex >= 0) {
          const relative = normalizedPath.slice(assetsIndex).split('/assets/')[1] || ''
          parts = [groupName, ...relative.split('/').slice(0, -1)]
        } else {
          parts = [groupName]
        }
      }
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
    let max = 0
    session.value?.tracks.forEach((track) => {
      const source = sourceMap.value.get(track.sourceId)
      max = Math.max(max, Number(source?.duration || 0))
    })
    return max
  })

  function snapshot(): HistorySnapshot | null {
    if (!session.value) return null
    return {
      tracks: cloneTracks(session.value.tracks),
      masterVolume: session.value.masterVolume,
      masterPan: session.value.masterPan,
      selectedTrackId: selectedTrackId.value,
    }
  }

  function applySnapshot(next: HistorySnapshot) {
    if (!session.value) return
    session.value.tracks = cloneTracks(next.tracks)
    session.value.masterVolume = next.masterVolume
    session.value.masterPan = next.masterPan
    selectedTrackId.value = next.selectedTrackId
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

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void saveProject()
    }, AUTO_SAVE_DELAY)
  }

  async function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    return saveProject()
  }

  function selectTrack(trackId: string | null) {
    selectedTrackId.value = trackId
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
      selectedTrackId.value = session.value.tracks[0]?.id || null
      clearHistory()
      const currentProjectId = session.value.id
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
    const result = await invoke<boolean>('delete_editor_project', { projectId })
    projectSummaries.value = projectSummaries.value.filter((item) => item.id !== projectId)
    if (session.value?.id === projectId) {
      session.value = null
      selectedTrackId.value = null
      clearHistory()
    }
    return result
  }

  function clearSession() {
    session.value = null
    selectedTrackId.value = null
    clearHistory()
  }

  async function loadProject(projectId: string) {
    loading.value = true
    lastError.value = null
    try {
      const result = await invoke<PersistedSession>('load_editor_project', { projectId })
      session.value = normalizeSession(result)
      await hydratePeaksFromCache(session.value.id)
      selectedTrackId.value = session.value.tracks[0]?.id || null
      clearHistory()
      const currentProjectId = session.value.id
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
    if (!session.value) return null
    saving.value = true
    try {
      const result = await invoke<PersistedSession>('save_editor_project', {
        project: toPersistedSession(session.value),
      })
      if (session.value && result.updatedAt) session.value.updatedAt = Number(result.updatedAt)
      return session.value
    } finally {
      saving.value = false
    }
  }

  async function getMetadata(path: string) {
    return invoke<AudioMetadata>('get_audio_metadata', { payload: { path } })
  }

  async function ensurePeaks(sourceId: string) {
    if (!session.value) return null
    const source = session.value.sources.find((item) => item.id === sourceId)
    if (!source || hasPeaks(source.peaks)) return source || null

    const cachedPeaks = await loadPeaksFromCache(source.peaksPath)
    if (cachedPeaks?.length) {
      source.peaks = cachedPeaks
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
      }

      if (!hasPeaks(source.peaks)) {
        await ensurePeaks(source.id)
      } else if (!source.duration || !source.sampleRate) {
        const metadata = await getMetadata(source.path).catch(() => null)
        if (!session.value || session.value.id !== projectId) return
        if (metadata) {
          source.name = metadata.name || source.name
          source.duration = Number(metadata.duration || source.duration)
          source.sampleRate = Number(metadata.sampleRate || source.sampleRate)
          source.channels = Number(metadata.channels || source.channels)
        }
      }

      if (
        source.name !== before.name
        || source.duration !== before.duration
        || source.sampleRate !== before.sampleRate
        || source.channels !== before.channels
        || (source.peaksPath || null) !== before.peaksPath
        || (source.peaks?.length || 0) !== before.peaksCount
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
      if (hasPeaks(source.peaks)) return
      const cachedPeaks = await loadPeaksFromCache(source.peaksPath)
      if (cachedPeaks?.length && session.value?.id === projectId) {
        source.peaks = cachedPeaks
      }
    }))
  }

  async function addReferenceSourceByPath(path: string) {
    if (!session.value) throw new Error('Editor session is not loaded')
    const source = await ensureSourceByPath(path)
    addTrackFromSourceId(source.id)
    return source
  }

  async function ensureSourceByPath(path: string) {
    if (!session.value) throw new Error('Editor session is not loaded')
    const existing = session.value.sources.find((source) => source.path === path)
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
    }
    session.value.sources.push(source)
    ensurePeaksInBackground(source.id)
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
    }
    session.value.tracks.push(track)
    selectedTrackId.value = track.id
    scheduleSave()
    return track
  }

  async function scanAssets(paths: string[]) {
    if (!session.value) throw new Error('Editor session is not loaded')
    const imported = await invoke<string[]>('import_editor_assets', {
      projectId: session.value.id,
      paths,
    })
    for (const path of imported || []) {
      await ensureSourceByPath(path)
    }
    await saveProject()
    return { files: imported || [], warnings: [] } satisfies ScanAudioPathsResult
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

  function setTrackFades(trackId: string, patch: { fadeIn?: number; fadeOut?: number }) {
    const track = session.value?.tracks.find((item) => item.id === trackId)
    if (!track) return
    const source = sourceMap.value.get(track.sourceId)
    const maxDuration = Math.max(0, Number(source?.duration || 0))
    pushHistory()
    if (patch.fadeIn !== undefined) track.fadeIn = clamp(Number(patch.fadeIn || 0), 0, maxDuration)
    if (patch.fadeOut !== undefined) track.fadeOut = clamp(Number(patch.fadeOut || 0), 0, maxDuration)
    scheduleSave()
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
      selectedTrackId.value = session.value.tracks[0]?.id || null
    }
    scheduleSave()
  }

  function removeSource(sourceId: string) {
    if (!session.value) return { removedSource: false, removedTracks: 0 }
    const source = session.value.sources.find((item) => item.id === sourceId)
    if (!source) return { removedSource: false, removedTracks: 0 }
    if (source.role === 'stem') return { removedSource: false, removedTracks: 0 }

    pushHistory()
    const removedTrackIds = session.value.tracks
      .filter((track) => track.sourceId === sourceId)
      .map((track) => track.id)

    session.value.tracks = session.value.tracks.filter((track) => track.sourceId !== sourceId)
    session.value.sources = session.value.sources.filter((item) => item.id !== sourceId)

    if (selectedTrackId.value && removedTrackIds.includes(selectedTrackId.value)) {
      selectedTrackId.value = session.value.tracks[0]?.id || null
    }

    scheduleSave()
    return { removedSource: true, removedTracks: removedTrackIds.length }
  }

  async function exportMix(options?: EditorExportFormat | EditorExportOptions) {
    if (!session.value) throw new Error('Editor session is not loaded')
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
    selectedTrack,
    selectedSource,
    sourceMap,
    stemTracks,
    referenceTracks,
    assetTree,
    pixelsPerSecond,
    exportFormat,
    masterVolume,
    masterPan,
    canUndo,
    canRedo,
    duration,
    selectTrack,
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
    scanAssets,
    renameTrack,
    toggleTrackFlag,
    setTrackVolume,
    setTrackPan,
    setTrackFades,
    setMasterVolume,
    setMasterPan,
    removeTrack,
    removeSource,
    exportMix,
    setZoom,
    zoomIn,
    zoomOut,
  }
})
