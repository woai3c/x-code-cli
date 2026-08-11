import type { ModelMessage } from 'ai'

import { classifyApiError } from './api-errors.js'

const INITIAL_STREAM_RETRY_DELAY_MS = 1000
const MAX_STREAM_RETRY_DELAY_MS = 30_000
const STREAM_WATCHDOG_POLL_MS = 1000

export type StreamRetryReason = 'network' | 'idle-timeout'

export interface StreamAttemptControl {
  signal: AbortSignal | undefined
  touch: () => void
  dispose: () => void
  didIdleTimeout: () => boolean
}

/** Activity watchdog for one provider stream. Wall-clock activity tracking
 *  catches an overdue stream after system resume without treating shorter
 *  event-loop stalls as a disconnect. */
export function createStreamAttemptControl(
  externalSignal: AbortSignal | undefined,
  idleTimeoutMs: number,
): StreamAttemptControl {
  if (idleTimeoutMs <= 0) {
    return {
      signal: externalSignal,
      touch: () => {},
      dispose: () => {},
      didIdleTimeout: () => false,
    }
  }

  const idleController = new AbortController()
  const signal = externalSignal ? AbortSignal.any([externalSignal, idleController.signal]) : idleController.signal
  let timer: ReturnType<typeof setTimeout> | null = null
  let idleTimedOut = false
  let lastActivityAt = Date.now()

  const poll = () => {
    if (signal.aborted) return
    const now = Date.now()
    const idle = now - lastActivityAt >= idleTimeoutMs
    if (idle) {
      idleTimedOut = true
      idleController.abort(new Error(`Streaming response timed out after ${idleTimeoutMs}ms without data`))
      return
    }
    timer = setTimeout(poll, Math.min(STREAM_WATCHDOG_POLL_MS, idleTimeoutMs))
  }

  timer = setTimeout(poll, Math.min(STREAM_WATCHDOG_POLL_MS, idleTimeoutMs))
  return {
    signal,
    touch: () => {
      lastActivityAt = Date.now()
    },
    dispose: () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
    didIdleTimeout: () => idleTimedOut,
  }
}

export function streamRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1)
  return Math.min(INITIAL_STREAM_RETRY_DELAY_MS * 2 ** exponent, MAX_STREAM_RETRY_DELAY_MS)
}

/** Wait for a reconnect backoff without making Esc/Ctrl+C wait for the timer. */
export function waitForStreamRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  if (delayMs <= 0) return Promise.resolve(true)

  return new Promise((resolve) => {
    let settled = false
    const finish = (ready: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(ready)
    }
    const timer = setTimeout(() => finish(true), delayMs)
    const onAbort = () => finish(false)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

/** The AI SDK already retries HTTP statuses such as 429/5xx. The outer
 *  reconnect loop is deliberately limited to transport failures so an
 *  exhausted rate limit does not multiply the SDK's request budget. */
export function isRetryableStreamTransportError(error: unknown): boolean {
  const classified = classifyApiError(error)
  return classified.retryable && classified.message.startsWith('Network connection failed')
}

const RECOVERY_PROMPT =
  'The previous assistant response was interrupted by a network disconnect. Continue directly from the exact point where it stopped. Do not repeat any text already emitted, do not mention the interruption, and preserve the original task and formatting.'

/** Add request-only recovery context. These messages are never committed to
 *  LoopState, so aborting another attempt cannot leave an unmatched synthetic
 *  user turn in the canonical conversation. */
export function appendStreamRecoveryContext(messages: ModelMessage[], visibleText: string): ModelMessage[] {
  if (!visibleText) return messages
  return [...messages, { role: 'assistant', content: visibleText }, { role: 'user', content: RECOVERY_PROMPT }]
}

/** Fold text already shown before a reconnect into the successful response
 *  before it is persisted. The UI only receives the continuation, while the
 *  next model turn sees one complete assistant answer. */
export function prependRecoveredText(messages: ModelMessage[], visibleText: string): void {
  if (!visibleText) return
  const assistant = messages.find((message) => message.role === 'assistant')
  if (!assistant) {
    messages.unshift({ role: 'assistant', content: visibleText })
    return
  }

  if (typeof assistant.content === 'string') {
    assistant.content = visibleText + assistant.content
    return
  }
  if (!Array.isArray(assistant.content)) return

  const content = assistant.content as Array<{ type: string; text?: string }>
  const textPart = content.find((part) => part.type === 'text' && typeof part.text === 'string')
  if (textPart) {
    textPart.text = visibleText + textPart.text
    return
  }

  const firstNonReasoning = content.findIndex((part) => part.type !== 'reasoning')
  content.splice(firstNonReasoning < 0 ? content.length : firstNonReasoning, 0, {
    type: 'text',
    text: visibleText,
  })
}

/** Providers occasionally ignore the continuation instruction and replay the
 *  full prefix. Hold only the ambiguous initial bytes: an exact replay is
 *  discarded, while a genuine continuation is released as soon as it differs. */
export class StreamReplayFilter {
  private candidate = ''
  private decided = false
  private replaySuppressed = false

  constructor(
    private readonly replayPrefix: string,
    private readonly emit: (text: string) => void,
  ) {
    this.decided = replayPrefix.length === 0
  }

  push(text: string): void {
    if (!text) return
    if (this.decided) {
      this.emit(text)
      return
    }

    this.candidate += text
    if (this.replayPrefix.startsWith(this.candidate)) return

    if (this.candidate.startsWith(this.replayPrefix)) {
      const remainder = this.candidate.slice(this.replayPrefix.length)
      this.candidate = ''
      this.decided = true
      this.replaySuppressed = true
      if (remainder) this.emit(remainder)
      return
    }

    const candidate = this.candidate
    this.candidate = ''
    this.decided = true
    this.emit(candidate)
  }

  finish(): void {
    if (this.decided || !this.candidate) return
    const candidate = this.candidate
    this.candidate = ''
    this.decided = true
    if (candidate === this.replayPrefix) this.replaySuppressed = true
    else this.emit(candidate)
  }

  suppressedReplay(): boolean {
    return this.replaySuppressed
  }
}
