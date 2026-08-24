import { errorMessage } from '../utils.js'
import type { WhisperWorkerRequest, WhisperWorkerResponse } from './audio-transcribe-protocol.js'

type WhisperContext = Awaited<ReturnType<(typeof import('@fugood/whisper.node'))['initWhisper']>>

let context: WhisperContext | null = null
let loadedModelPath: string | null = null
let busy = false

function send(response: WhisperWorkerResponse): void {
  if (process.connected) process.send?.(response)
}

async function releaseContext(): Promise<void> {
  const current = context
  context = null
  loadedModelPath = null
  await current?.release().catch(() => {})
}

async function contextFor(modelPath: string, id: number): Promise<WhisperContext> {
  if (context && loadedModelPath === modelPath) return context
  await releaseContext()
  send({ id, type: 'notice', message: 'Loading whisper model…' })
  const whisperModule = await import('@fugood/whisper.node')
  await whisperModule.loadWhisperModule()
  await whisperModule.toggleNativeLog(false)
  context = await whisperModule.initWhisper({ filePath: modelPath, useGpu: true })
  loadedModelPath = modelPath
  return context
}

async function transcribe(request: Extract<WhisperWorkerRequest, { type: 'transcribe' }>): Promise<void> {
  if (busy) {
    send({ id: request.id, type: 'error', phase: 'transcribe', error: 'Whisper worker is already busy' })
    return
  }
  busy = true
  let phase: 'initialize' | 'transcribe' = 'initialize'
  try {
    const whisper = await contextFor(request.modelPath, request.id)
    phase = 'transcribe'
    const options: Parameters<WhisperContext['transcribeFile']>[1] = {
      temperature: 0,
      onProgress: (progress) => send({ id: request.id, type: 'progress', progress }),
    }
    if (request.language) options.language = request.language
    const { promise } = whisper.transcribeFile(request.filePath, options)
    const result = await promise
    send({ id: request.id, type: 'result', result })
  } catch (error) {
    send({ id: request.id, type: 'error', phase, error: errorMessage(error) })
  } finally {
    busy = false
  }
}

process.on('message', (request: WhisperWorkerRequest) => {
  if (request.type === 'shutdown') {
    void releaseContext().finally(() => process.exit(0))
    return
  }
  void transcribe(request)
})

process.on('disconnect', () => process.exit(0))
