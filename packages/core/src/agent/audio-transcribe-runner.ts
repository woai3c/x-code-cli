import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import type {
  WhisperAudioMetadata,
  WhisperWorkerRequest,
  WhisperWorkerResponse,
  WhisperWorkerResult,
} from './audio-transcribe-protocol.js'

const IDLE_MS = 60_000
const PROBE_TIMEOUT_MS = 15_000
const AUDIO_PREPARATION_TIMEOUT_MS = 2 * 60_000
export const MAX_WHISPER_TRANSCRIPTION_MS = 30 * 60_000

export class WhisperProcessError extends Error {
  constructor(
    message: string,
    readonly phase: 'runtime' | 'decode' | 'initialize' | 'transcribe' | 'process',
  ) {
    super(message)
    this.name = 'WhisperProcessError'
  }
}

export interface RunWhisperOptions {
  language?: string
  abortSignal?: AbortSignal
  onProgress?: (progress: number) => void
  onNotice?: (message: string) => void
  timeoutMs?: number
}

function workerPath(): string {
  const current = new URL(import.meta.url)
  if (current.pathname.endsWith('/src/agent/audio-transcribe-runner.ts')) {
    return fileURLToPath(new URL('../../dist/agent/audio-transcribe-worker.js', current))
  }
  if (current.pathname.includes('/chunks/')) return fileURLToPath(new URL('../audio-transcribe-worker.js', current))
  return fileURLToPath(new URL('./audio-transcribe-worker.js', current))
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError')
}

interface PendingRequest {
  id: number
  expected: 'ready' | 'audio-prepared' | 'result'
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  options: RunWhisperOptions
  abortHandler?: () => void
  timeout?: ReturnType<typeof setTimeout>
}

class WhisperProcessClient {
  private readonly child: ChildProcess
  private pending: PendingRequest | null = null
  private nextId = 1
  private terminated = false

  constructor() {
    this.child = fork(workerPath(), [], {
      execArgv: ['--max-old-space-size=256'],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    this.child.on('message', (message: WhisperWorkerResponse) => this.handleMessage(message))
    this.child.on('error', (error) => {
      this.terminated = true
      this.fail(new WhisperProcessError(error.message, 'process'))
    })
    this.child.on('exit', (code, signal) => {
      const expected = this.terminated
      this.terminated = true
      if (!expected) {
        this.fail(
          new WhisperProcessError(
            `Whisper process exited unexpectedly${signal ? ` (${signal})` : ` with code ${code ?? 'unknown'}`}`,
            'process',
          ),
        )
      }
    })
  }

  get alive(): boolean {
    return !this.terminated
  }

  private handleMessage(message: WhisperWorkerResponse): void {
    const pending = this.pending
    if (!pending || message.id !== pending.id) return
    if (message.type === 'notice') {
      pending.options.onNotice?.(message.message)
      return
    }
    if (message.type === 'progress') {
      pending.options.onProgress?.(message.progress)
      return
    }
    this.pending = null
    this.cleanupPending(pending)
    if (message.type === 'error') {
      pending.reject(new WhisperProcessError(message.error, message.phase))
      return
    }
    if (message.type !== pending.expected) {
      pending.reject(new WhisperProcessError(`Unexpected Whisper process response: ${message.type}`, 'process'))
      return
    }
    if (message.type === 'ready') pending.resolve(undefined)
    else if (message.type === 'audio-prepared') pending.resolve(message.metadata)
    else pending.resolve(message.result)
  }

  private cleanupPending(pending: PendingRequest): void {
    if (pending.abortHandler) pending.options.abortSignal?.removeEventListener('abort', pending.abortHandler)
    clearTimeout(pending.timeout)
  }

  private fail(error: Error): void {
    const pending = this.pending
    if (!pending) return
    this.pending = null
    this.cleanupPending(pending)
    pending.reject(error)
  }

  ref(): void {
    this.child.ref()
    this.child.channel?.ref()
  }

  unref(): void {
    this.child.unref()
    this.child.channel?.unref()
  }

  private request<T>(
    expected: PendingRequest['expected'],
    buildRequest: (id: number) => WhisperWorkerRequest,
    options: RunWhisperOptions,
    defaultTimeoutMs: number,
  ): Promise<T> {
    options.abortSignal?.throwIfAborted()
    if (this.terminated || !this.child.connected) {
      return Promise.reject(new WhisperProcessError('Whisper process is unavailable', 'process'))
    }
    if (this.pending) return Promise.reject(new WhisperProcessError('Whisper process is already busy', 'process'))
    this.ref()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        id,
        expected,
        resolve: (value) => resolve(value as T),
        reject,
        options,
      }
      const abortHandler = options.abortSignal
        ? () => {
            if (this.pending !== pending) return
            this.pending = null
            this.cleanupPending(pending)
            reject(abortError(options.abortSignal))
            this.terminate(true)
          }
        : undefined
      pending.abortHandler = abortHandler
      const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
      pending.timeout = setTimeout(() => {
        if (this.pending !== pending) return
        this.pending = null
        this.cleanupPending(pending)
        reject(new WhisperProcessError(`Whisper process timed out after ${timeoutMs} ms`, 'process'))
        this.terminate(true)
      }, timeoutMs)
      pending.timeout.unref()
      this.pending = pending
      if (abortHandler) options.abortSignal!.addEventListener('abort', abortHandler, { once: true })
      if (options.abortSignal?.aborted) {
        abortHandler?.()
        return
      }
      const request = buildRequest(id)
      this.child.send(request, (error) => {
        if (error && this.pending === pending) this.fail(new WhisperProcessError(error.message, 'process'))
      })
    })
  }

  probe(options: RunWhisperOptions): Promise<void> {
    return this.request('ready', (id) => ({ id, type: 'probe' }), options, PROBE_TIMEOUT_MS)
  }

  prepareAudio(filePath: string, pcmPath: string, options: RunWhisperOptions): Promise<WhisperAudioMetadata> {
    return this.request(
      'audio-prepared',
      (id) => ({ id, type: 'prepare-audio', filePath, pcmPath }),
      options,
      AUDIO_PREPARATION_TIMEOUT_MS,
    )
  }

  transcribe(modelPath: string, pcmPath: string, options: RunWhisperOptions): Promise<WhisperWorkerResult> {
    return this.request(
      'result',
      (id) => ({
        id,
        type: 'transcribe',
        modelPath,
        pcmPath,
        ...(options.language ? { language: options.language } : {}),
      }),
      options,
      MAX_WHISPER_TRANSCRIPTION_MS,
    )
  }

  terminate(force = false): void {
    if (this.terminated) return
    this.terminated = true
    this.fail(new WhisperProcessError('Whisper process terminated', 'process'))
    this.child.kill(force ? 'SIGKILL' : 'SIGTERM')
  }
}

let processClient: WhisperProcessClient | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let queue: Promise<void> = Promise.resolve()

function clearIdleTimer(): void {
  if (!idleTimer) return
  clearTimeout(idleTimer)
  idleTimer = null
}

function scheduleIdleTermination(client: WhisperProcessClient): void {
  clearIdleTimer()
  if (processClient !== client || !client.alive) return
  client.unref()
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (processClient !== client) return
    processClient = null
    client.terminate()
  }, IDLE_MS)
  idleTimer.unref()
}

function totalTimeoutError(timeoutMs: number): WhisperProcessError {
  return new WhisperProcessError(`Whisper request timed out after ${timeoutMs} ms including queue wait`, 'process')
}

function runExclusive<T>(
  operation: (remainingMs: number) => Promise<T>,
  options: RunWhisperOptions,
  defaultTimeoutMs: number,
): Promise<T> {
  if (options.abortSignal?.aborted) return Promise.reject(abortError(options.abortSignal))
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(totalTimeoutError(timeoutMs))
  const deadline = Date.now() + timeoutMs
  const begin = async (): Promise<T> => {
    options.abortSignal?.throwIfAborted()
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw totalTimeoutError(timeoutMs)
    return operation(remainingMs)
  }
  const result = queue.then(begin, begin)
  queue = result.then(
    () => undefined,
    () => undefined,
  )

  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const cancellation = new Promise<never>((_resolve, reject) => {
    onAbort = options.abortSignal ? () => reject(abortError(options.abortSignal)) : undefined
    if (onAbort) options.abortSignal!.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => reject(totalTimeoutError(timeoutMs)), timeoutMs)
    timer.unref()
  })
  return Promise.race([result, cancellation]).finally(() => {
    clearTimeout(timer)
    if (onAbort) options.abortSignal?.removeEventListener('abort', onAbort)
  })
}

export function runWhisperTranscription(
  modelPath: string,
  pcmPath: string,
  options: RunWhisperOptions = {},
): Promise<WhisperWorkerResult> {
  return withWhisperClient(
    (client, effectiveOptions) => client.transcribe(modelPath, pcmPath, effectiveOptions),
    options,
    MAX_WHISPER_TRANSCRIPTION_MS,
  )
}

function withWhisperClient<T>(
  operation: (client: WhisperProcessClient, effectiveOptions: RunWhisperOptions) => Promise<T>,
  options: RunWhisperOptions,
  defaultTimeoutMs: number,
): Promise<T> {
  return runExclusive(
    async (remainingMs) => {
      options.abortSignal?.throwIfAborted()
      clearIdleTimer()
      if (!processClient?.alive) processClient = new WhisperProcessClient()
      const client = processClient
      try {
        return await operation(client, { ...options, timeoutMs: remainingMs })
      } finally {
        if (!client.alive && processClient === client) processClient = null
        else scheduleIdleTermination(client)
      }
    },
    options,
    defaultTimeoutMs,
  )
}

export function probeWhisperRuntime(options: RunWhisperOptions = {}): Promise<void> {
  return withWhisperClient((client, effectiveOptions) => client.probe(effectiveOptions), options, PROBE_TIMEOUT_MS)
}

export function prepareWhisperAudio(
  filePath: string,
  pcmPath: string,
  options: RunWhisperOptions = {},
): Promise<WhisperAudioMetadata> {
  return withWhisperClient(
    (client, effectiveOptions) => client.prepareAudio(filePath, pcmPath, effectiveOptions),
    options,
    AUDIO_PREPARATION_TIMEOUT_MS,
  )
}

export function disposeWhisperProcess(): void {
  clearIdleTimer()
  processClient?.terminate()
  processClient = null
}
