import { errorMessage } from '../utils.js'
import { readFileWithinLimit } from '../utils/bounded-read.js'
import { decodeAudioToPcm } from './audio-decode.js'
import { MAX_AUDIO_PCM_INPUT_BYTES } from './audio-limits.js'
import type { WhisperWorkerRequest, WhisperWorkerResponse } from './audio-transcribe-protocol.js'

type WhisperModule = typeof import('@fugood/whisper.node')
type WhisperContext = Awaited<ReturnType<WhisperModule['initWhisper']>>

let whisperModule: WhisperModule | null = null
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

async function loadRuntime(): Promise<WhisperModule> {
  if (whisperModule) return whisperModule
  const loaded = await import('@fugood/whisper.node')
  await loaded.loadWhisperModule()
  await loaded.toggleNativeLog(false)
  whisperModule = loaded
  return loaded
}

async function contextFor(modelPath: string, id: number): Promise<WhisperContext> {
  if (context && loadedModelPath === modelPath) return context
  await releaseContext()
  send({ id, type: 'notice', message: 'Loading cached Whisper model into memory…' })
  const loaded = await loadRuntime()
  context = await loaded.initWhisper({ filePath: modelPath, useGpu: true })
  loadedModelPath = modelPath
  return context
}

async function handleRequest(request: Exclude<WhisperWorkerRequest, { type: 'shutdown' }>): Promise<void> {
  if (busy) {
    const phase = request.type === 'probe' ? 'runtime' : request.type === 'prepare-audio' ? 'decode' : 'transcribe'
    send({ id: request.id, type: 'error', phase, error: 'Whisper worker is already busy' })
    return
  }
  busy = true
  let phase: 'runtime' | 'decode' | 'initialize' | 'transcribe' = 'runtime'
  try {
    if (request.type === 'probe') {
      await loadRuntime()
      send({ id: request.id, type: 'ready' })
      return
    }
    if (request.type === 'prepare-audio') {
      phase = 'decode'
      const metadata = await decodeAudioToPcm(request.filePath, request.pcmPath)
      send({
        id: request.id,
        type: 'audio-prepared',
        metadata,
      })
      return
    }

    phase = 'initialize'
    const whisper = await contextFor(request.modelPath, request.id)
    phase = 'transcribe'
    const options: Parameters<WhisperContext['transcribeData']>[1] = {
      temperature: 0,
      onProgress: (progress) => send({ id: request.id, type: 'progress', progress }),
    }
    if (request.language) options.language = request.language
    const pcm = await readFileWithinLimit(request.pcmPath, MAX_AUDIO_PCM_INPUT_BYTES)
    if (pcm.length === 0 || pcm.length % Int16Array.BYTES_PER_ELEMENT !== 0) {
      throw new Error('Decoded PCM data is empty or misaligned')
    }
    const audioData =
      pcm.buffer instanceof ArrayBuffer && pcm.byteOffset === 0 && pcm.buffer.byteLength === pcm.byteLength
        ? pcm.buffer
        : Uint8Array.from(pcm).buffer
    const { promise } = whisper.transcribeData(audioData, options)
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
  void handleRequest(request)
})

process.on('disconnect', () => process.exit(0))
