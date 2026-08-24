import fs from 'node:fs/promises'

const READ_CHUNK_BYTES = 64 * 1024

export class FileSizeLimitError extends Error {
  constructor(
    readonly filePath: string,
    readonly observedBytes: number,
    readonly limitBytes: number,
  ) {
    super(`File ${filePath} exceeds the ${limitBytes}-byte read limit`)
    this.name = 'FileSizeLimitError'
  }
}

/** Read from one opened file identity and stop after limit + 1 bytes. The
 *  handle-level stat closes the path replacement window left by a prior
 *  caller stat, while the bounded loop also catches files appended mid-read. */
export async function readFileWithinLimit(
  filePath: string,
  limitBytes: number,
  abortSignal?: AbortSignal,
): Promise<Buffer> {
  abortSignal?.throwIfAborted()
  const handle = await fs.open(filePath, 'r')
  try {
    const stats = await handle.stat()
    if (stats.size > limitBytes) throw new FileSizeLimitError(filePath, stats.size, limitBytes)

    const chunks: Buffer[] = []
    let totalBytes = 0
    while (totalBytes <= limitBytes) {
      abortSignal?.throwIfAborted()
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, limitBytes + 1 - totalBytes))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, totalBytes)
      if (bytesRead === 0) break
      chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead))
      totalBytes += bytesRead
    }

    if (totalBytes > limitBytes) throw new FileSizeLimitError(filePath, totalBytes, limitBytes)
    abortSignal?.throwIfAborted()
    return Buffer.concat(chunks, totalBytes)
  } finally {
    await handle.close()
  }
}
