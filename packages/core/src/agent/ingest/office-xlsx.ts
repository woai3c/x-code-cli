import { Worker } from 'node:worker_threads'

import { createAbortError, resolveCoreWorkerUrl } from '../../utils/worker-url.js'
import type { OfficeXlsxWorkerInput, OfficeXlsxWorkerOutput } from './office-xlsx-protocol.js'

const OFFICE_XLSX_WORKER_TIMEOUT_MS = 30_000

function officeXlsxWorkerUrl(): URL {
  return resolveCoreWorkerUrl(import.meta.url, 'office-xlsx-worker.js')
}

const abortError = createAbortError

export async function parseXlsxInWorker(archive: Buffer, abortSignal?: AbortSignal): Promise<string> {
  abortSignal?.throwIfAborted()
  const input = Uint8Array.from(archive)
  const worker = new Worker(officeXlsxWorkerUrl(), {
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 },
    workerData: { archive: input.buffer } satisfies OfficeXlsxWorkerInput,
    transferList: [input.buffer],
  })

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      abortSignal?.removeEventListener('abort', onAbort)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      void worker.terminate()
      reject(error)
    }
    const onAbort = (): void => fail(abortError(abortSignal))
    const timer = setTimeout(
      () => fail(new Error(`Spreadsheet parsing timed out after ${OFFICE_XLSX_WORKER_TIMEOUT_MS} ms`)),
      OFFICE_XLSX_WORKER_TIMEOUT_MS,
    )
    timer.unref()
    abortSignal?.addEventListener('abort', onAbort, { once: true })
    if (abortSignal?.aborted) onAbort()
    worker.once('message', (output: OfficeXlsxWorkerOutput) => {
      if (settled) return
      if (!output.ok) {
        fail(new Error(output.error))
        return
      }
      settled = true
      cleanup()
      void worker.terminate()
      resolve(output.text)
    })
    worker.once('error', fail)
    worker.once('exit', (code) => {
      if (!settled) fail(new Error(`Spreadsheet worker exited unexpectedly with code ${code}`))
    })
  })
}
