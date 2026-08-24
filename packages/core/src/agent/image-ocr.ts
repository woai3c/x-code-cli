import fs from 'node:fs/promises'
import path from 'node:path'

import { errorMessage, userXcodeDir } from '../utils.js'

const WORKER_IDLE_MS = 30_000

type OcrWorker = Awaited<ReturnType<(typeof import('tesseract.js'))['createWorker']>>

let sharedWorker: OcrWorker | null = null
let workerIdleTimer: ReturnType<typeof setTimeout> | null = null
let ocrQueue: Promise<void> = Promise.resolve()

async function tesseractCacheDir(): Promise<string> {
  const dir = path.join(userXcodeDir(), 'tessdata')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function clearIdleTimer(): void {
  if (!workerIdleTimer) return
  clearTimeout(workerIdleTimer)
  workerIdleTimer = null
}

async function terminateWorker(expected?: OcrWorker): Promise<void> {
  if (!sharedWorker || (expected && sharedWorker !== expected)) return
  const worker = sharedWorker
  sharedWorker = null
  clearIdleTimer()
  await worker.terminate().catch(() => {})
}

function scheduleIdleTermination(worker: OcrWorker): void {
  clearIdleTimer()
  workerIdleTimer = setTimeout(() => {
    void terminateWorker(worker)
  }, WORKER_IDLE_MS)
  workerIdleTimer.unref()
}

async function getOcrWorker(): Promise<OcrWorker> {
  clearIdleTimer()
  if (sharedWorker) return sharedWorker
  const { createWorker } = await import('tesseract.js')
  sharedWorker = await createWorker(['eng', 'chi_sim'], 1, {
    cachePath: await tesseractCacheDir(),
  })
  return sharedWorker
}

function enqueueOcr<T>(task: () => Promise<T>): Promise<T> {
  const result = ocrQueue.then(task, task)
  ocrQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError')
}

export function ocrImage(input: string | Buffer, options: { abortSignal?: AbortSignal } = {}): Promise<string> {
  const { abortSignal } = options
  if (abortSignal?.aborted) return Promise.reject(abortError(abortSignal))
  const queued = enqueueOcr(async () => {
    abortSignal?.throwIfAborted()
    let worker: OcrWorker | undefined
    const onAbort = (): void => {
      if (worker) void terminateWorker(worker)
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true })
    try {
      worker = await getOcrWorker()
      abortSignal?.throwIfAborted()
      const { data } = await worker.recognize(input)
      abortSignal?.throwIfAborted()
      scheduleIdleTermination(worker)
      return data.text ?? ''
    } catch (error) {
      if (worker) await terminateWorker(worker)
      abortSignal?.throwIfAborted()
      return `[OCR failed: ${errorMessage(error)}]`
    } finally {
      abortSignal?.removeEventListener('abort', onAbort)
    }
  })
  if (!abortSignal) return queued
  return new Promise<string>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(abortSignal))
    abortSignal.addEventListener('abort', onAbort, { once: true })
    if (abortSignal.aborted) onAbort()
    queued.then(
      (value) => {
        abortSignal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        abortSignal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

export async function disposeOcrWorker(): Promise<void> {
  await ocrQueue
  await terminateWorker()
}
