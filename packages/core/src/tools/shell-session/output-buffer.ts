const DEFAULT_MAX_BYTES = 1024 * 1024
const BLOCK_BYTES = 16 * 1024

export interface ShellOutputSnapshot {
  output: string
  originalBytes: number
  omittedBytes: number
}

function utf8Prefix(buffer: Buffer, maxBytes: number): Buffer {
  const end = Math.min(buffer.length, Math.max(0, maxBytes))
  if (end === 0) return Buffer.alloc(0)
  let codePointStart = end - 1
  while (codePointStart >= 0 && (buffer[codePointStart]! & 0xc0) === 0x80) codePointStart--
  if (codePointStart < 0) return Buffer.alloc(0)
  const lead = buffer[codePointStart]!
  const expectedBytes = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return buffer.subarray(0, end - codePointStart < expectedBytes ? codePointStart : end)
}

/**
 * A byte-bounded output accumulator. It retains the beginning and end of the
 * stream and records exactly how many UTF-8 bytes were omitted in between.
 */
export class HeadTailOutputBuffer {
  private readonly headLimit: number
  private readonly tailLimit: number
  private blocks: Buffer[] = []
  private lastBlockBytes = 0
  private head: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private tailRing: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private tailLength = 0
  private tailWrite = 0
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
    if (!this.truncated) return this.totalBytes
    return this.head.length + this.tailLength - this.tailLeadingContinuationBytes()
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
    if (!this.truncated && this.totalBytes <= this.maxBytes) {
      this.appendUntruncated(bytes, previousBytes)
      return
    }
    if (!this.truncated) {
      this.transitionToTruncated(bytes, previousBytes)
      this.truncated = true
      return
    }
    this.writeTail(bytes)
  }

  snapshot(): ShellOutputSnapshot {
    if (!this.truncated) {
      const output = this.joinBlocks().toString('utf8')
      return { output, originalBytes: this.totalBytes, omittedBytes: 0 }
    }

    const tail = this.orderedTail()
    const omittedBytes = Math.max(0, this.totalBytes - this.head.length - tail.length)
    const output = `${this.head.toString('utf8')}\n... ${omittedBytes} bytes omitted ...\n${tail.toString('utf8')}`
    return { output, originalBytes: this.totalBytes, omittedBytes }
  }

  /** Returns a bounded suffix without materializing the whole retained buffer. */
  tailSnapshot(maxBytes: number): string {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError('maxBytes must be a non-negative safe integer')
    }
    const length = Math.min(maxBytes, this.truncated ? this.tailLength : this.totalBytes)
    if (length === 0) return ''

    const result = Buffer.allocUnsafe(length)
    if (!this.truncated) {
      this.copyBlockRange(this.totalBytes - length, length, result, 0)
    } else {
      const logicalStart = this.tailLength === this.tailLimit ? this.tailWrite : 0
      const sourceStart = (logicalStart + this.tailLength - length) % this.tailLimit
      const first = Math.min(length, this.tailLimit - sourceStart)
      this.tailRing.copy(result, 0, sourceStart, sourceStart + first)
      if (first < length) this.tailRing.copy(result, first, 0, length - first)
    }

    let start = 0
    while (start < result.length && (result[start]! & 0xc0) === 0x80) start++
    return result.subarray(start).toString('utf8')
  }

  drain(): ShellOutputSnapshot {
    const snapshot = this.snapshot()
    this.clear()
    return snapshot
  }

  clear(): void {
    this.blocks = []
    this.lastBlockBytes = 0
    this.head = Buffer.alloc(0)
    this.tailRing = Buffer.alloc(0)
    this.tailLength = 0
    this.tailWrite = 0
    this.totalBytes = 0
    this.truncated = false
  }

  private appendUntruncated(bytes: Buffer, previousBytes: number): void {
    let offset = 0
    while (offset < bytes.length) {
      let block = this.blocks.at(-1)
      if (!block || this.lastBlockBytes === block.length) {
        const remainingCapacity = this.maxBytes - previousBytes - offset
        block = Buffer.allocUnsafe(Math.min(BLOCK_BYTES, remainingCapacity))
        this.blocks.push(block)
        this.lastBlockBytes = 0
      }
      const copied = Math.min(block.length - this.lastBlockBytes, bytes.length - offset)
      bytes.copy(block, this.lastBlockBytes, offset, offset + copied)
      this.lastBlockBytes += copied
      offset += copied
    }
  }

  private transitionToTruncated(bytes: Buffer, previousBytes: number): void {
    if (this.headLimit > 0) {
      const rawHead = Buffer.allocUnsafe(this.headLimit)
      const fromPrevious = Math.min(previousBytes, this.headLimit)
      this.copyBlockRange(0, fromPrevious, rawHead, 0)
      if (fromPrevious < this.headLimit) bytes.copy(rawHead, fromPrevious, 0, this.headLimit - fromPrevious)
      this.head = utf8Prefix(rawHead, this.headLimit)
    }

    if (this.tailLimit > 0) {
      const rawTail = Buffer.allocUnsafe(this.tailLimit)
      const fromCurrent = Math.min(bytes.length, this.tailLimit)
      const fromPrevious = this.tailLimit - fromCurrent
      if (fromPrevious > 0) {
        this.copyBlockRange(previousBytes - fromPrevious, fromPrevious, rawTail, 0)
      }
      bytes.copy(rawTail, fromPrevious, bytes.length - fromCurrent)
      this.tailRing = rawTail
      this.tailLength = this.tailLimit
      this.tailWrite = 0
    }

    this.blocks = []
    this.lastBlockBytes = 0
  }

  private writeTail(bytes: Buffer): void {
    if (this.tailLimit === 0) return
    if (this.tailRing.length !== this.tailLimit) this.tailRing = Buffer.allocUnsafe(this.tailLimit)
    if (bytes.length >= this.tailLimit) {
      bytes.copy(this.tailRing, 0, bytes.length - this.tailLimit)
      this.tailLength = this.tailLimit
      this.tailWrite = 0
      return
    }

    const first = Math.min(bytes.length, this.tailLimit - this.tailWrite)
    bytes.copy(this.tailRing, this.tailWrite, 0, first)
    if (first < bytes.length) bytes.copy(this.tailRing, 0, first)
    this.tailWrite = (this.tailWrite + bytes.length) % this.tailLimit
    this.tailLength = Math.min(this.tailLimit, this.tailLength + bytes.length)
  }

  private copyBlockRange(start: number, length: number, target: Buffer, targetOffset: number): void {
    if (length <= 0) return
    let blockStart = 0
    let remaining = length
    let destination = targetOffset
    for (let index = 0; index < this.blocks.length && remaining > 0; index++) {
      const block = this.blocks[index]!
      const blockLength = index === this.blocks.length - 1 ? this.lastBlockBytes : block.length
      const blockEnd = blockStart + blockLength
      if (start < blockEnd && start + length > blockStart) {
        const sourceStart = Math.max(0, start - blockStart)
        const copied = Math.min(blockLength - sourceStart, remaining)
        block.copy(target, destination, sourceStart, sourceStart + copied)
        destination += copied
        remaining -= copied
      }
      blockStart = blockEnd
    }
  }

  private joinBlocks(): Buffer {
    if (this.totalBytes === 0) return Buffer.alloc(0)
    const chunks = this.blocks.map((block, index) =>
      index === this.blocks.length - 1 ? block.subarray(0, this.lastBlockBytes) : block,
    )
    return Buffer.concat(chunks, this.totalBytes)
  }

  private orderedTail(): Buffer {
    const skipped = this.tailLeadingContinuationBytes()
    const length = this.tailLength - skipped
    if (length <= 0) return Buffer.alloc(0)
    const result = Buffer.allocUnsafe(length)
    const logicalStart = this.tailLength === this.tailLimit ? this.tailWrite : 0
    const sourceStart = (logicalStart + skipped) % this.tailLimit
    const first = Math.min(length, this.tailLimit - sourceStart)
    this.tailRing.copy(result, 0, sourceStart, sourceStart + first)
    if (first < length) this.tailRing.copy(result, first, 0, length - first)
    return result
  }

  private tailLeadingContinuationBytes(): number {
    if (this.tailLength === 0) return 0
    const logicalStart = this.tailLength === this.tailLimit ? this.tailWrite : 0
    let skipped = 0
    while (skipped < this.tailLength) {
      const value = this.tailRing[(logicalStart + skipped) % this.tailLimit]!
      if ((value & 0xc0) !== 0x80) break
      skipped++
    }
    return skipped
  }
}
