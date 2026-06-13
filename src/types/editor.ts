export type EditorSourceRole = 'stem' | 'reference'

export type EditorSource = {
  id: string
  role: EditorSourceRole
  stemKey?: string | null
  path: string
  name: string
  duration: number
  sampleRate: number
  channels: number
  peaksPath?: string | null
  peaks?: number[]
}

export type EditorClip = {
  id: string
  assetId: string
  start: number
  offset: number
  duration: number
  volume: number
  fadeIn: number
  fadeOut: number
  muted: boolean
  locked: boolean
}

export type EditorTrack = {
  id: string
  sourceId: string
  role: EditorSourceRole
  name: string
  color?: string | null
  volume: number
  pan: number
  muted: boolean
  solo: boolean
  fadeIn: number
  fadeOut: number
  type?: 'stem' | 'audio' | 'reference'
  clips?: EditorClip[]
}

export type EditorSession = {
  id: string
  name: string
  sourceTaskId?: string
  sourceResultDir?: string
  masterVolume: number
  masterPan: number
  sources: EditorSource[]
  tracks: EditorTrack[]
  createdAt: number
  updatedAt: number
}

export type EditorProjectSummary = {
  id: string
  name: string
  sourceTaskId?: string
  sourceResultDir?: string
  createdAt: number
  updatedAt: number
  type: 'task' | 'blank'
}

export type EditorAsset = EditorSource
export type EditorProject = EditorSession & { assets?: EditorSource[] }
export type EditorAssetTreeNode = {
  key: string
  name: string
  path: string
  expanded?: boolean
  children: EditorAssetTreeNode[]
  assets: EditorAsset[]
}

export type EditorExportFormat = 'wav' | 'flac' | 'mp3' | 'm4a'
export type EditorExportAudioParams = {
  wavBitDepth?: string
  flacBitDepth?: string
  mp3BitRate?: string
  m4aBitRate?: string
  m4aCodec?: string
}

export type EditorExportOptions = {
  format?: EditorExportFormat
  audioParams?: EditorExportAudioParams
}
