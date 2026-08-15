import { setImmediate } from 'node:timers'

import { stripTerminalControls } from '../../peers/terminal-sanitize.js'
import { debugLog } from '../../utils.js'
import type { ShellEventPayload, ShellSessionEvent, ShellSessionListener, ShellSessionSummary } from './types.js'

const MAX_OUTPUT_EVENT_BYTES = 8 * 1024
const MAX_PENDING_OUTPUT_BYTES = 256 * 1024
const MAX_PENDING_OUTPUT_EVENTS = 128
const MAX_EVENTS_PER_DRAIN = 64
const MAX_OUTPUT_PREDECESSORS_BEFORE_CONTROL = 16
const MAX_DRAIN_TIME_MS = 4

interface QueueEntry {
  event: ShellSessionEvent
  listeners: readonly ShellSessionListener[]
  outputBytes: number
}

function utf8Prefix(value: string, maxBytes: number): { value: string; bytes: number; rest: string } {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.length <= maxBytes) return { value, bytes: buffer.length, rest: '' }
  let end = maxBytes
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--
  return {
    value: buffer.subarray(0, end).toString('utf8'),
    bytes: end,
    rest: buffer.subarray(end).toString('utf8'),
  }
}

function sameListeners(left: readonly ShellSessionListener[], right: readonly ShellSessionListener[]): boolean {
  return left.length === right.length && left.every((listener, index) => listener === right[index])
}

export class ShellSessionEventHub {
  private sequence = 0
  private readonly listeners = new Set<ShellSessionListener>()
  private readonly queue: QueueEntry[] = []
  private readonly uiOmittedByShell = new Map<string, number>()
  private readonly pendingOmittedByShell = new Map<string, number>()
  private pendingOutputBytes = 0
  private pendingOutputEvents = 0
  private scheduled = false
  private draining = false
  private closed = false
  private drainWaiters: Array<() => void> = []

  constructor(
    readonly ownerSessionId: string,
    readonly managerInstanceId: string,
    private readonly snapshotProvider: () => ShellSessionSummary[],
    private readonly now: () => number = Date.now,
  ) {}

  get highWaterMark(): number {
    return this.sequence
  }

  get pendingOutputByteLength(): number {
    return this.pendingOutputBytes
  }

  get pendingOutputEventCount(): number {
    return this.pendingOutputEvents
  }

  omittedBytesFor(shellId: string): number {
    return this.uiOmittedByShell.get(shellId) ?? 0
  }

  subscribe(listener: ShellSessionListener, options: { replayCurrent?: boolean } = {}): () => void {
    if (this.closed) return () => {}
    this.listeners.add(listener)
    if (options.replayCurrent) {
      const event: ShellSessionEvent = {
        kind: 'snapshot',
        seq: this.sequence,
        ownerSessionId: this.ownerSessionId,
        managerInstanceId: this.managerInstanceId,
        occurredAt: this.now(),
        sessions: this.snapshotProvider(),
      }
      this.enqueue({ event, listeners: [listener], outputBytes: 0 })
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  publish(payload: ShellEventPayload): ShellSessionEvent {
    if (this.closed) throw new Error('Shell session event hub is closed')
    if (payload.kind === 'output') return this.publishOutput(payload)
    return this.publishControl(payload)
  }

  async drain(): Promise<void> {
    if (this.queue.length === 0 && !this.draining) return
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve))
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.drain()
    this.closed = true
    this.listeners.clear()
  }

  private publishControl(payload: Exclude<ShellEventPayload, { kind: 'output' }>): ShellSessionEvent {
    this.limitOutputPredecessors()
    const event = this.createEvent(payload)
    this.enqueue({ event, listeners: [...this.listeners], outputBytes: 0 })
    return event
  }

  private publishOutput(payload: Extract<ShellEventPayload, { kind: 'output' }>): ShellSessionEvent {
    const sanitized = stripTerminalControls(payload.chunk)
    let remaining = sanitized
    let lastEvent: ShellSessionEvent | undefined
    do {
      const part = utf8Prefix(remaining, MAX_OUTPUT_EVENT_BYTES)
      remaining = part.rest
      const event = this.createEvent({
        ...payload,
        chunk: part.value,
        truncated: payload.truncated || remaining.length > 0 || undefined,
      }) as Extract<ShellSessionEvent, { kind: 'output' }>
      lastEvent = this.enqueueOutput(event, part.bytes)
    } while (remaining.length > 0)
    return lastEvent!
  }

  private createEvent(payload: ShellEventPayload): ShellSessionEvent {
    return {
      ...payload,
      seq: ++this.sequence,
      ownerSessionId: this.ownerSessionId,
      managerInstanceId: this.managerInstanceId,
      occurredAt: this.now(),
    } as ShellSessionEvent
  }

  private enqueueOutput(event: Extract<ShellSessionEvent, { kind: 'output' }>, bytes: number): ShellSessionEvent {
    const listeners = [...this.listeners]
    const pendingOmitted = this.takePendingOmitted(event.shellId)
    if (pendingOmitted > 0) event.omittedBytesBefore = (event.omittedBytesBefore ?? 0) + pendingOmitted

    const previous = this.queue[this.queue.length - 1]
    if (
      previous?.event.kind === 'output' &&
      previous.event.shellId === event.shellId &&
      previous.event.stream === event.stream &&
      previous.outputBytes + bytes <= MAX_OUTPUT_EVENT_BYTES &&
      sameListeners(previous.listeners, listeners)
    ) {
      previous.event.chunk += event.chunk
      previous.event.truncated = previous.event.truncated || event.truncated || undefined
      previous.event.omittedBytesBefore =
        (previous.event.omittedBytesBefore ?? 0) + (event.omittedBytesBefore ?? 0) || undefined
      previous.outputBytes += bytes
      this.pendingOutputBytes += bytes
      this.enforceOutputCaps()
      return previous.event
    }

    this.enqueue({ event, listeners, outputBytes: bytes })
    this.pendingOutputBytes += bytes
    this.pendingOutputEvents++
    this.enforceOutputCaps()
    return event
  }

  private enqueue(entry: QueueEntry): void {
    this.queue.push(entry)
    this.scheduleDrain()
  }

  private scheduleDrain(): void {
    if (this.scheduled || this.draining) return
    this.scheduled = true
    setImmediate(() => {
      this.scheduled = false
      this.drainBatch()
    })
  }

  private drainBatch(): void {
    if (this.draining) return
    this.draining = true
    const startedAt = performance.now()
    let delivered = 0
    try {
      while (
        this.queue.length > 0 &&
        delivered < MAX_EVENTS_PER_DRAIN &&
        performance.now() - startedAt < MAX_DRAIN_TIME_MS
      ) {
        const entry = this.queue.shift()!
        if (entry.event.kind === 'output') {
          this.pendingOutputBytes -= entry.outputBytes
          this.pendingOutputEvents--
        }
        for (const listener of entry.listeners) {
          if (!this.listeners.has(listener)) continue
          try {
            listener(entry.event)
          } catch (error) {
            debugLog('shell-session.listener-error', String(error))
          }
        }
        delivered++
      }
    } finally {
      this.draining = false
    }

    if (this.queue.length > 0) {
      this.scheduleDrain()
      return
    }
    const waiters = this.drainWaiters
    this.drainWaiters = []
    for (const resolve of waiters) resolve()
  }

  private enforceOutputCaps(): void {
    while (this.pendingOutputBytes > MAX_PENDING_OUTPUT_BYTES || this.pendingOutputEvents > MAX_PENDING_OUTPUT_EVENTS) {
      if (!this.evictOldestOutput()) break
    }
  }

  private limitOutputPredecessors(): void {
    while (this.pendingOutputEvents > MAX_OUTPUT_PREDECESSORS_BEFORE_CONTROL) {
      if (!this.evictOldestOutput()) break
    }
  }

  private evictOldestOutput(): boolean {
    const index = this.queue.findIndex((entry) => entry.event.kind === 'output')
    if (index < 0) return false
    const [entry] = this.queue.splice(index, 1)
    if (!entry || entry.event.kind !== 'output') return false
    this.pendingOutputBytes -= entry.outputBytes
    this.pendingOutputEvents--
    const omitted = entry.outputBytes + (entry.event.omittedBytesBefore ?? 0)
    this.uiOmittedByShell.set(
      entry.event.shellId,
      (this.uiOmittedByShell.get(entry.event.shellId) ?? 0) + entry.outputBytes,
    )
    this.pendingOmittedByShell.set(
      entry.event.shellId,
      (this.pendingOmittedByShell.get(entry.event.shellId) ?? 0) + omitted,
    )
    this.attachOmittedToNextOutput(entry.event.shellId, omitted)
    debugLog(
      'shell-session.event-output-dropped',
      `manager=${this.managerInstanceId.slice(0, 16)} id=${entry.event.shellId} bytes=${entry.outputBytes} pendingBytes=${this.pendingOutputBytes} pendingEvents=${this.pendingOutputEvents}`,
    )
    return true
  }

  private attachOmittedToNextOutput(shellId: string, bytes: number): void {
    const next = this.queue.find(
      (entry): entry is QueueEntry & { event: Extract<ShellSessionEvent, { kind: 'output' }> } =>
        entry.event.kind === 'output' && entry.event.shellId === shellId,
    )
    if (!next) return
    next.event.omittedBytesBefore = (next.event.omittedBytesBefore ?? 0) + bytes
    this.pendingOmittedByShell.delete(shellId)
  }

  private takePendingOmitted(shellId: string): number {
    const pending = this.pendingOmittedByShell.get(shellId) ?? 0
    this.pendingOmittedByShell.delete(shellId)
    return pending
  }
}
