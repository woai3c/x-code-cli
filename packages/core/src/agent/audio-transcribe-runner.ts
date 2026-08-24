import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import type { WhisperWorkerRequest, WhisperWorkerResponse, WhisperWorkerResult } from './audio-transcribe-protocol.js'

const IDLE_MS = 60_000

export class WhisperProcessError extends Error {
  constructor(
    message: string,
    readonly phase: 'initialize' | 'transcribe' | 'process',
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
  resolve: (result: WhisperWorkerResult) => void
  reject: (error: Error) => void
  options: RunWhisperOptions
  abortHandler?: () => void
}

class WhisperProcessClient {
  private readonly child: ChildProcess
  private pending: PendingRequest | null = null
  private nextId = 1
  private terminated = false

  constructor() {
    this.child = fork(workerPath(), [], {
      execArgv: [],
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
    if (message.type === 'error') pending.reject(new WhisperProcessError(message.error, message.phase))
    else pending.resolve(message.result)
  }

  private cleanupPending(pending: PendingRequest): void {
    if (pending.abortHandler) pending.options.abortSignal?.removeEventListener('abort', pending.abortHandler)
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

  transcribe(modelPath: string, filePath: string, options: RunWhisperOptions): Promise<WhisperWorkerResult> {
    options.abortSignal?.throwIfAborted()
    if (this.terminated || !this.child.connected) {
      return Promise.reject(new WhisperProcessError('Whisper process is unavailable', 'process'))
    }
    if (this.pending) return Promise.reject(new WhisperProcessError('Whisper process is already busy', 'process'))
    this.ref()
    const id = this.nextId++
    return new Promise<WhisperWorkerResult>((resolve, reject) => {
      const pending: PendingRequest = { id, resolve, reject, options }
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
      this.pending = pending
      if (abortHandler) options.abortSignal!.addEventListener('abort', abortHandler, { once: true })
      if (options.abortSignal?.aborted) {
        abortHandler?.()
        return
      }
      const request: WhisperWorkerRequest = {
        id,
        type: 'transcribe',
        modelPath,
        filePath,
        ...(options.language ? { language: options.language } : {}),
      }
      this.child.send(request, (error) => {
        if (error && this.pending === pending) this.fail(new WhisperProcessError(error.message, 'process'))
      })
    })
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

function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation)
  queue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export function runWhisperTranscription(
  modelPath: string,
  filePath: string,
  options: RunWhisperOptions = {},
): Promise<WhisperWorkerResult> {
  return runExclusive(async () => {
    options.abortSignal?.throwIfAborted()
    clearIdleTimer()
    if (!processClient?.alive) processClient = new WhisperProcessClient()
    const client = processClient
    try {
      return await client.transcribe(modelPath, filePath, options)
    } finally {
      if (!client.alive && processClient === client) processClient = null
      else scheduleIdleTermination(client)
    }
  })
}

export function disposeWhisperProcess(): void {
  clearIdleTimer()
  processClient?.terminate()
  processClient = null
}
