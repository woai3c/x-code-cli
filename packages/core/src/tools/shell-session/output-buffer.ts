const DEFAULT_MAX_BYTES = 1024 * 1024

export interface ShellOutputSnapshot {
  output: string
  originalBytes: number
  omittedBytes: number
}

function utf8Prefix(buffer: Buffer, maxBytes: number): Buffer {
  if (buffer.length <= maxBytes) return buffer
  const end = Math.max(0, maxBytes)
  let codePointStart = end - 1
  while (codePointStart >= 0 && (buffer[codePointStart] & 0xc0) === 0x80) codePointStart--
  if (codePointStart < 0) return Buffer.alloc(0)
  const lead = buffer[codePointStart]!
  const expectedBytes = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return buffer.subarray(0, end - codePointStart < expectedBytes ? codePointStart : end)
}

function utf8Suffix(buffer: Buffer, maxBytes: number): Buffer {
  if (buffer.length <= maxBytes) return buffer
  let start = Math.max(0, buffer.length - maxBytes)
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++
  return buffer.subarray(start)
}

/**
 * A byte-bounded output accumulator. It retains the beginning and end of the
 * stream and records exactly how many UTF-8 bytes were omitted in between.
 */
export class HeadTailOutputBuffer {
  private readonly headLimit: number
  private readonly tailLimit: number
  private head: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private tail: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private totalBytes = 0
  private truncated = false

  constructor(private readonly maxBytes = DEFAULT_MAX_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError('maxBytes must be a non-negative safe integer')
    }
    this.headLimit = Math.ceil(maxBytes / 2)
    this.tailLimit = maxBytes - this.headLimit
  }

  get originalBytes(): number {
    return this.totalBytes
  }

  get omittedBytes(): number {
    return Math.max(0, this.totalBytes - this.retainedBytes)
  }

  get retainedBytes(): number {
    return this.head.length + this.tail.length
  }

  get isEmpty(): boolean {
    return this.totalBytes === 0
  }

  append(value: string | Uint8Array): void {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)
    if (bytes.length === 0) return

    const previousBytes = this.totalBytes
    this.totalBytes += bytes.length

    if (this.maxBytes === 0) {
      this.truncated = true
      return
    }

    if (!this.truncated && previousBytes + bytes.length <= this.maxBytes) {
      this.head = Buffer.concat([this.head, bytes])
      return
    }

    if (!this.truncated) {
      const complete = Buffer.concat([this.head, bytes])
      this.head = utf8Prefix(complete, this.headLimit)
      this.tail = utf8Suffix(complete, this.tailLimit)
      this.truncated = true
      return
    }

    if (this.tailLimit > 0) {
      this.tail = utf8Suffix(Buffer.concat([this.tail, bytes]), this.tailLimit)
    }
  }

  snapshot(): ShellOutputSnapshot {
    const omittedBytes = this.omittedBytes
    const head = this.head.toString('utf8')
    const tail = this.tail.toString('utf8')
    const output = omittedBytes > 0 ? `${head}\n... ${omittedBytes} bytes omitted ...\n${tail}` : head
    return { output, originalBytes: this.totalBytes, omittedBytes }
  }

  drain(): ShellOutputSnapshot {
    const snapshot = this.snapshot()
    this.clear()
    return snapshot
  }

  clear(): void {
    this.head = Buffer.alloc(0)
    this.tail = Buffer.alloc(0)
    this.totalBytes = 0
    this.truncated = false
  }
}
