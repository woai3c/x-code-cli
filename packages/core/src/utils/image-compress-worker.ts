import { parentPort, workerData } from 'node:worker_threads'

import { compressImageInProcess } from './image-compress.js'
import type { ImageCompressWorkerInput, ImageCompressWorkerOutput } from './image-compress.js'

if (!parentPort) throw new Error('Image compression worker requires a parent port')

const port = parentPort
const input = workerData as ImageCompressWorkerInput

try {
  const result = await compressImageInProcess(Buffer.from(input.data), input.mimeType, {
    maxEdge: input.maxEdge,
    byteBudget: input.byteBudget,
  })
  const data = Uint8Array.from(result.data)
  const output: ImageCompressWorkerOutput = {
    ok: true,
    result: { ...result, data: data.buffer },
  }
  port.postMessage(output, [data.buffer])
} catch (error) {
  const output: ImageCompressWorkerOutput = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }
  port.postMessage(output)
} finally {
  port.close()
}
