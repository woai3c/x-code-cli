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

export interface WhisperAudioMetadata {
  durationSeconds: number
  container?: string
  codec?: string
  sampleRate?: number
  numberOfChannels?: number
}

export type WhisperWorkerRequest =
  | { id: number; type: 'probe' }
  | { id: number; type: 'prepare-audio'; filePath: string; pcmPath: string }
  | {
      id: number
      type: 'transcribe'
      modelPath: string
      pcmPath: string
      language?: string
    }
  | { id: number; type: 'shutdown' }

export type WhisperWorkerResponse =
  | { id: number; type: 'ready' }
  | { id: number; type: 'audio-prepared'; metadata: WhisperAudioMetadata }
  | { id: number; type: 'notice'; message: string }
  | { id: number; type: 'progress'; progress: number }
  | { id: number; type: 'result'; result: WhisperWorkerResult }
  | { id: number; type: 'error'; phase: 'runtime' | 'decode' | 'initialize' | 'transcribe'; error: string }
