export type AudioToolKey = 'convert' | 'merge' | 'sdr' | 'midi'

export type AudioToolFailure = {
  path: string
  message: string
}

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
}

export type AudioToolProgress = {
  completed: number
  total: number
  current: string
}
