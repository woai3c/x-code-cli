import { randomUUID } from 'node:crypto'
import fs, { type FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { MAX_TOOL_RESULT_BYTES, MAX_TOOL_RESULT_LINES } from '../truncate.js'

export interface ShellOutputSpillSnapshot {
  fullOutputPath?: string
  error?: string
}

export interface ShellOutputSpillOptions {
  maxInlineBytes?: number
  maxInlineLines?: number
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function countLineBreaks(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) count++
  }
  return count
}

export class ShellOutputSpill {
  private maxInlineBytes: number
  private readonly maxInlineLines: number
  private bufferedChunks: string[] = []
  private bufferedBytes = 0
  private lineBreaks = 0
  private hasOutput = false
  private fullOutputPath: string | undefined
  private handle: FileHandle | undefined
  private writeChain: Promise<void> = Promise.resolve()
  private failure: Error | undefined
  private closeRequested = false

  constructor(options: ShellOutputSpillOptions = {}) {
    this.maxInlineBytes = options.maxInlineBytes ?? MAX_TOOL_RESULT_BYTES
    this.maxInlineLines = options.maxInlineLines ?? MAX_TOOL_RESULT_LINES
    if (!Number.isSafeInteger(this.maxInlineBytes) || this.maxInlineBytes < 0) {
      throw new RangeError('maxInlineBytes must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(this.maxInlineLines) || this.maxInlineLines < 0) {
      throw new RangeError('maxInlineLines must be a non-negative safe integer')
    }
  }

  append(text: string): void {
    if (!text || this.closeRequested) return

    const textBytes = Buffer.byteLength(text, 'utf8')
    this.bufferedBytes += textBytes
    this.lineBreaks += countLineBreaks(text)
    this.hasOutput = true

    if (!this.fullOutputPath) {
      this.bufferedChunks.push(text)
      this.maybeStartSpill()
      return
    }

    this.enqueue(async () => {
      if (!this.handle) throw new Error('Shell output file is not open')
      await this.handle.writeFile(text, 'utf8')
    })
  }

  lowerMaxInlineBytes(maxInlineBytes: number): void {
    if (!Number.isSafeInteger(maxInlineBytes) || maxInlineBytes < 0) {
      throw new RangeError('maxInlineBytes must be a non-negative safe integer')
    }
    if (maxInlineBytes >= this.maxInlineBytes) return
    this.maxInlineBytes = maxInlineBytes
    this.maybeStartSpill()
  }

  async flush(): Promise<ShellOutputSpillSnapshot> {
    await this.writeChain
    if (this.failure) return { error: this.failure.message }
    return this.fullOutputPath ? { fullOutputPath: this.fullOutputPath } : {}
  }

  async close(): Promise<ShellOutputSpillSnapshot> {
    if (!this.closeRequested) {
      this.closeRequested = true
      if (this.fullOutputPath) this.enqueueClose()
    }
    return this.flush()
  }

  private maybeStartSpill(): void {
    if (this.fullOutputPath || !this.hasOutput) return
    const totalLines = this.lineBreaks + 1
    if (this.bufferedBytes <= this.maxInlineBytes && totalLines <= this.maxInlineLines) return

    const initialContent = this.bufferedChunks.join('')
    this.bufferedChunks = []
    this.fullOutputPath = path.join(os.tmpdir(), `x-code-shell-${randomUUID()}.log`)
    this.enqueue(async () => {
      this.handle = await fs.open(this.fullOutputPath!, 'ax', 0o600)
      await this.handle.writeFile(initialContent, 'utf8')
    })
    if (this.closeRequested) this.enqueueClose()
  }

  private enqueueClose(): void {
    this.enqueue(async () => {
      await this.handle?.close()
      this.handle = undefined
    })
  }

  private enqueue(operation: () => Promise<void>): void {
    this.writeChain = this.writeChain.then(async () => {
      if (this.failure) return
      try {
        await operation()
      } catch (error) {
        this.failure = toError(error)
        await this.handle?.close().catch(() => {})
        this.handle = undefined
        if (this.fullOutputPath) await fs.rm(this.fullOutputPath, { force: true }).catch(() => {})
      }
    })
  }
}
