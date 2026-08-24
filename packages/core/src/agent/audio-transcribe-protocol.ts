export interface WhisperWorkerSegment {
  t0: number
  t1: number
  text: string
}

export interface WhisperWorkerResult {
  isAborted: boolean
  language?: string
  result: string
  segments: WhisperWorkerSegment[]
}

export type WhisperWorkerRequest =
  | {
      id: number
      type: 'transcribe'
      modelPath: string
      filePath: string
      language?: string
    }
  | { id: number; type: 'shutdown' }

export type WhisperWorkerResponse =
  | { id: number; type: 'notice'; message: string }
  | { id: number; type: 'progress'; progress: number }
  | { id: number; type: 'result'; result: WhisperWorkerResult }
  | { id: number; type: 'error'; phase: 'initialize' | 'transcribe'; error: string }
