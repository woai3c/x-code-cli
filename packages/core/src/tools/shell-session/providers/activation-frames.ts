import { StringDecoder } from 'node:string_decoder'

import type { ManagedOutputCapture, ManagedProcessFrame } from '../provider.js'

const ACTIVATION_OUTPUT_MAX_BYTES = 1024 * 1024
const ACTIVATION_HEAD_BYTES = Math.ceil(ACTIVATION_OUTPUT_MAX_BYTES / 2)
const ACTIVATION_TAIL_BYTES = ACTIVATION_OUTPUT_MAX_BYTES - ACTIVATION_HEAD_BYTES

interface OrderedOutputFrame {
  order: number
  part: number
  frame: Extract<ManagedProcessFrame, { kind: 'output' }>
}

interface OrderedControlFrame {
  order: number
  frame: Exclude<ManagedProcessFrame, { kind: 'output' }>
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
  let start = buffer.length - maxBytes
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++
  return buffer.subarray(start)
}

function outputBytes(frames: readonly OrderedOutputFrame[]): number {
  return frames.reduce((total, entry) => total + entry.frame.chunk.byteLength, 0)
}

function prefixFrames(frames: readonly OrderedOutputFrame[], maxBytes: number): OrderedOutputFrame[] {
  const selected: OrderedOutputFrame[] = []
  let remaining = maxBytes
  for (const entry of frames) {
    if (remaining <= 0) break
    const chunk = Buffer.from(entry.frame.chunk)
    const retained = utf8Prefix(chunk, remaining)
    if (retained.length > 0) {
      selected.push({ ...entry, part: 0, frame: { ...entry.frame, chunk: retained } })
      remaining -= retained.length
    }
    if (retained.length < chunk.length) break
  }
  return selected
}

function suffixFrames(frames: readonly OrderedOutputFrame[], maxBytes: number): OrderedOutputFrame[] {
  const selected: OrderedOutputFrame[] = []
  let remaining = maxBytes
  for (let index = frames.length - 1; index >= 0 && remaining > 0; index--) {
    const entry = frames[index]!
    const chunk = Buffer.from(entry.frame.chunk)
    const retained = utf8Suffix(chunk, remaining)
    if (retained.length > 0) {
      selected.unshift({ ...entry, part: 2, frame: { ...entry.frame, chunk: retained } })
      remaining -= retained.length
    }
    if (retained.length < chunk.length) break
  }
  return selected
}

export class ActivationFrameBuffer {
  private head: OrderedOutputFrame[] = []
  private tail: OrderedOutputFrame[] = []
  private controls: OrderedControlFrame[] = []
  private flushingFrames: ManagedProcessFrame[] = []
  private outputBytes = 0
  private retainedBytes = 0
  private nextOrder = 0
  private truncated = false
  private listener?: (frame: ManagedProcessFrame) => void
  private state: 'buffering' | 'flushing' | 'active' | 'discarded' = 'buffering'
  private readonly decoders = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  }

  constructor(private readonly outputCapture?: ManagedOutputCapture) {}

  push(frame: ManagedProcessFrame): void {
    if (this.state === 'discarded') return
    for (const normalized of this.normalize(frame)) this.pushNormalized(normalized)
  }

  activate(listener: (frame: ManagedProcessFrame) => void): void {
    if (this.state !== 'buffering') return
    this.listener = listener
    this.state = 'flushing'
    for (const frame of this.materialize()) listener(frame)
    while (this.flushingFrames.length > 0) listener(this.flushingFrames.shift()!)
    this.clearBufferedFrames()
    this.state = 'active'
  }

  discard(): ManagedProcessFrame[] {
    if (this.state !== 'buffering') return []
    this.state = 'discarded'
    const frames = this.materialize()
    this.clearBufferedFrames()
    return frames
  }

  private normalize(frame: ManagedProcessFrame): ManagedProcessFrame[] {
    if (frame.kind === 'output') {
      const value = this.decoders[frame.stream].write(Buffer.from(frame.chunk))
      return value ? [this.captureOutput({ ...frame, chunk: Buffer.from(value, 'utf8') }, value)] : []
    }
    if (frame.kind !== 'stream-end') return [frame]
    const trailing = this.decoders[frame.stream].end()
    return trailing
      ? [
          this.captureOutput({ kind: 'output', stream: frame.stream, chunk: Buffer.from(trailing, 'utf8') }, trailing),
          frame,
        ]
      : [frame]
  }

  private captureOutput(
    frame: Extract<ManagedProcessFrame, { kind: 'output' }>,
    text: string,
  ): Extract<ManagedProcessFrame, { kind: 'output' }> {
    if (!this.outputCapture) return frame
    this.outputCapture.append(text)
    return { ...frame, fullOutputCaptured: true }
  }

  private pushNormalized(frame: ManagedProcessFrame): void {
    if (this.state === 'active') {
      this.listener?.(frame)
      return
    }
    if (this.state === 'flushing') {
      this.flushingFrames.push(frame)
      return
    }

    const order = this.nextOrder++
    if (frame.kind !== 'output') {
      this.controls.push({ order, frame })
      return
    }

    const entry: OrderedOutputFrame = { order, part: 0, frame }
    this.outputBytes += frame.chunk.byteLength
    if (!this.truncated && this.outputBytes <= ACTIVATION_OUTPUT_MAX_BYTES) {
      this.head.push(entry)
      this.retainedBytes += frame.chunk.byteLength
      return
    }

    if (!this.truncated) {
      const all = [...this.head, entry]
      this.head = prefixFrames(all, ACTIVATION_HEAD_BYTES)
      this.tail = suffixFrames(all, ACTIVATION_TAIL_BYTES)
      this.truncated = true
    } else {
      this.tail = suffixFrames([...this.tail, entry], ACTIVATION_TAIL_BYTES)
    }
    this.retainedBytes = outputBytes(this.head) + outputBytes(this.tail)
  }

  private materialize(): ManagedProcessFrame[] {
    const ordered: Array<{ order: number; part: number; frame: ManagedProcessFrame }> = [
      ...this.head.map((entry) => ({ ...entry, frame: entry.frame as ManagedProcessFrame })),
      ...this.tail.map((entry) => ({ ...entry, frame: entry.frame as ManagedProcessFrame })),
      ...this.controls.map((entry) => ({ ...entry, part: 0, frame: entry.frame as ManagedProcessFrame })),
    ]
    if (this.truncated) {
      const lastHead = this.head.at(-1)
      ordered.push({
        order: lastHead?.order ?? -1,
        part: (lastHead?.part ?? 0) + 1,
        frame: this.omissionFrame(),
      })
    }
    ordered.sort((left, right) => left.order - right.order || left.part - right.part)
    return ordered.map((entry) => entry.frame)
  }

  private clearBufferedFrames(): void {
    this.head = []
    this.tail = []
    this.controls = []
    this.flushingFrames = []
    this.retainedBytes = 0
  }

  private omissionFrame(): ManagedProcessFrame {
    const frame: Extract<ManagedProcessFrame, { kind: 'output' }> = {
      kind: 'output',
      stream: 'stderr',
      chunk: Buffer.from(
        `\n... ${this.outputBytes - this.retainedBytes} bytes omitted before shell activation ...\n`,
        'utf8',
      ),
    }
    return this.outputCapture ? { ...frame, fullOutputCaptured: true } : frame
  }
}
