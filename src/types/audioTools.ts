export type AudioToolKey = 'convert' | 'merge' | 'sdr' | 'midi'

export type AudioToolPhase =
  | 'started'
  | 'preparing'
  | 'converting'
  | 'normalizing'
  | 'merging'
  | 'loading_reference'
  | 'loading_estimated'
  | 'calculating'
  | 'loading_model'
  | 'loading_audio'
  | 'transcribing'
  | 'writing_output'
  | 'completed'
  | 'failed'

export type AudioToolFailure = {
  path: string
  message: string
}

export type AudioToolWarning =
  | 'no_notes_detected'
  | 'stereo_downmix_fallback'

export type AudioToolResult = {
  operation: AudioToolKey
  outputDir?: string
  outputPath?: string
  outputPaths?: string[]
  succeeded?: number
  failed?: AudioToolFailure[]
  merged?: number
  skipped?: AudioToolFailure[]
  sampleRate?: number
  sdr?: number[]
  averageSdr?: number
  siSdr?: number[]
  averageSiSdr?: number
  bpm?: number
  language?: string
  noteCount?: number
  inputDuration?: number
  firstNoteAt?: number | null
  lastNoteAt?: number | null
  warnings?: AudioToolWarning[]
}

export type AudioToolProgress = {
  completed: number
  total: number
  current: string
  phase: AudioToolPhase
}

export type AudioToolLogEntry = AudioToolProgress & {
  id: number
  timestamp: number
  updatedAt: number
  description: string
  detail?: string
}
