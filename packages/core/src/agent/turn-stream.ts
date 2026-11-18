import { performance } from 'node:perf_hooks'

import type { ModelMessage } from 'ai'

import { truncateToolResult } from '../tools/index.js'
import { clearProgressReporter, setProgressReporter } from '../tools/progress.js'
import type { AgentCallbacks, AgentOptions } from '../types/index.js'
import { debugLog, isAbortError } from '../utils.js'
import { classifyApiError } from './api-errors.js'
import { appendProviderTurnUsage, consumeExpectedCacheMissReasons, createProviderTurnUsage } from './cache-stats.js'
import type { LoopState } from './loop-state.js'
import { isManagedMemoryAccess } from './managed-memory-boundary.js'
import { toolErrorString } from './messages.js'
import { appendUsage } from './session-store.js'
import { StreamReplayFilter, isRetryableStreamTransportError, prependRecoveredText } from './stream-retry.js'
import type { StreamAttemptControl, StreamRetryReason } from './stream-retry.js'
import type { StreamResult } from './stream-utils.js'
import { truncateToolResultsInMessages } from './tool-result-sanitize.js'
import { accumulateUsage, attributedModelId, normalizeLanguageModelUsage } from './usage.js'

export interface StreamAttemptTracker {
  visibleText: string
  toolActivity: boolean
  receivedData: boolean
  suppressedReplay: boolean
  requestStartedAtMs?: number
  firstOutputChunkAtMs?: number | null
  streamEndedAtMs?: number | null
  sawReasoningDelta?: boolean
}

export interface StepSpeedAccumulator {
  outputTokens: number
  durationMs: number
}

const LIVE_SPEED_MIN_ELAPSED_MS = 300
const LIVE_SPEED_THROTTLE_MS = 400
const MIN_DECODE_WINDOW_MS = 150
const MIN_MEASURABLE_DURATION_MS = 15
const MIN_OUTPUT_TOKENS = 3
const BYTES_PER_TOKEN_ESTIMATE = 3.0

/** Compute a completed API turn's token-generation sample, excluding TTFT when
 *  a real streaming decode window exists and guarding against silent server-side
 *  reasoning inflating visible decode rates. */
export function computeTurnSpeedSample(input: {
  requestStartedAtMs: number
  firstOutputChunkAtMs: number | null
  streamEndedAtMs: number
  sawReasoningDelta: boolean
  outputTokens: number
  reasoningTokens: number
}): { tokens: number; durationMs: number } | null {
  if (input.outputTokens < MIN_OUTPUT_TOKENS) return null
  const decodeMs = input.firstOutputChunkAtMs != null ? input.streamEndedAtMs - input.firstOutputChunkAtMs : -1
  if (decodeMs >= MIN_DECODE_WINDOW_MS) {
    if (input.reasoningTokens > 0 && !input.sawReasoningDelta) {
      const visibleTokens = Math.max(0, input.outputTokens - input.reasoningTokens)
      if (visibleTokens >= MIN_OUTPUT_TOKENS) {
        return { tokens: visibleTokens, durationMs: decodeMs }
      }
      const e2eMs = input.streamEndedAtMs - input.requestStartedAtMs
      return e2eMs >= MIN_MEASURABLE_DURATION_MS ? { tokens: input.outputTokens, durationMs: e2eMs } : null
    }
    return { tokens: input.outputTokens, durationMs: decodeMs }
  }
  const e2eMs = input.streamEndedAtMs - input.requestStartedAtMs
  return e2eMs >= MIN_MEASURABLE_DURATION_MS ? { tokens: input.outputTokens, durationMs: e2eMs } : null
}

export type TurnOutcome =
  | { kind: 'done'; finishReason: string; result: StreamResult }
  | { kind: 'error' }
  | {
      kind: 'stream-error'
      error: unknown
      partialText: string
      toolActivity: boolean
      reason: StreamRetryReason
    }
  | { kind: 'retry' }
  | { kind: 'aborted' }

export type FinalTurnOutcome = Exclude<TurnOutcome, { kind: 'stream-error' }>

/** Consume provider stream chunks and project user-visible events to callbacks. */
export async function streamChunksToUI(
  result: StreamResult,
  callbacks: AgentCallbacks,
  state: LoopState,
  options: AgentOptions,
  tracker: StreamAttemptTracker,
  attemptControl: StreamAttemptControl,
  recoveryText: string,
  retrying: boolean,
  stepSpeed?: StepSpeedAccumulator,
  now: () => number = () => performance.now(),
): Promise<void> {
  const deferredNames = new Set((state.deferredCatalog ?? []).map((entry) => entry.name))
  const suppressedDeferredCallIds = new Set<string>()
  const suppressedMemoryAccessCallIds = new Set<string>()
  if (tracker.requestStartedAtMs === undefined) tracker.requestStartedAtMs = now()
  tracker.firstOutputChunkAtMs = null
  tracker.streamEndedAtMs = null
  tracker.sawReasoningDelta = false
  let streamedBytes = 0
  const streamedToolInputIds = new Set<string>()
  let lastLiveEmitAtMs = -Infinity
  let lastLiveRounded = -1
  let lastModelChunkAtMs: number | null = null
  let sawInlineToolOutput = false

  const recordOutputBytes = (bytes: number): void => {
    if (bytes <= 0) return
    const ts = now()
    lastModelChunkAtMs = ts
    if (tracker.firstOutputChunkAtMs == null) tracker.firstOutputChunkAtMs = ts
    streamedBytes += bytes
    if (state.agentRole !== 'root' || !callbacks.onTokenSpeedUpdate) return
    const elapsedMs = ts - tracker.firstOutputChunkAtMs
    if (elapsedMs < LIVE_SPEED_MIN_ELAPSED_MS || ts - lastLiveEmitAtMs < LIVE_SPEED_THROTTLE_MS) return
    const estimatedTokens = Math.ceil(streamedBytes / BYTES_PER_TOKEN_ESTIMATE)
    if (estimatedTokens < MIN_OUTPUT_TOKENS) return
    const totalTokens = (stepSpeed?.outputTokens ?? 0) + estimatedTokens
    const totalDurationMs = (stepSpeed?.durationMs ?? 0) + elapsedMs
    const tps = (totalTokens * 1000) / totalDurationMs
    const rounded = Math.round(tps)
    if (!Number.isFinite(tps) || tps <= 0 || rounded === lastLiveRounded) return
    lastLiveEmitAtMs = ts
    lastLiveRounded = rounded
    callbacks.onTokenSpeedUpdate({ tokensPerSecond: tps, isEstimate: true })
  }

  const textFilter = new StreamReplayFilter(recoveryText, (text) => {
    tracker.visibleText += text
    callbacks.onTextDelta(text)
  })
  const markToolActivity = () => {
    tracker.toolActivity = true
  }

  for await (const chunk of result.stream) {
    attemptControl.touch()
    if (chunk.type === 'error') {
      throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error))
    }
    if (!tracker.receivedData) {
      tracker.receivedData = true
      if (retrying) callbacks.onStreamRetry?.(null)
    }
    if (chunk.type === 'text-delta') {
      const text = chunk.text ?? ''
      const bytes = Buffer.byteLength(text, 'utf8')
      debugLog('stream.text-delta', `bytes=${bytes}`)
      recordOutputBytes(bytes)
      textFilter.push(text)
    } else if (chunk.type === 'tool-input-delta') {
      const delta = chunk.delta ?? ''
      const deltaId = chunk.id ?? chunk.toolCallId ?? ''
      if (delta) {
        if (deltaId) streamedToolInputIds.add(deltaId)
        recordOutputBytes(Buffer.byteLength(delta, 'utf8'))
      }
    } else if (chunk.type === 'tool-call') {
      markToolActivity()
      lastModelChunkAtMs = now()
      const callId = chunk.toolCallId ?? ''
      if ((!callId || !streamedToolInputIds.has(callId)) && chunk.input !== undefined) {
        try {
          recordOutputBytes(Buffer.byteLength(JSON.stringify(chunk.input), 'utf8'))
        } catch {
          /* ignore non-serializable mock input */
        }
      }
      const inputKeys =
        chunk.input && typeof chunk.input === 'object' && !Array.isArray(chunk.input)
          ? Object.keys(chunk.input as Record<string, unknown>).sort()
          : []
      debugLog('stream.tool-call', `${chunk.toolName ?? ''} keys=[${inputKeys.join(',')}]`)
      const toolCallId = chunk.toolCallId ?? ''
      const toolName = chunk.toolName ?? ''
      if (
        isManagedMemoryAccess(
          toolName,
          (chunk.input ?? {}) as Record<string, unknown>,
          options.memoryService?.memoryRoot,
        )
      ) {
        suppressedMemoryAccessCallIds.add(toolCallId)
        debugLog('stream.memory-access-call', `${toolName} ${toolCallId} — suppressed`)
        continue
      }
      if (deferredNames.has(toolName) && !state.activatedTools.has(toolName)) {
        suppressedDeferredCallIds.add(toolCallId)
        debugLog('stream.deferred-early-call', `${toolName} ${toolCallId} — suppressed (not loaded yet)`)
        continue
      }
      if (toolCallId) {
        setProgressReporter(toolCallId, (message) => callbacks.onToolProgress(toolCallId, message))
      }
      callbacks.onToolCall(toolCallId, toolName, (chunk.input ?? {}) as Record<string, unknown>)
    } else if (chunk.type === 'tool-result') {
      sawInlineToolOutput = true
      markToolActivity()
      const raw = typeof chunk.output === 'string' ? chunk.output : JSON.stringify(chunk.output ?? '')
      debugLog('stream.tool-result', `${chunk.toolCallId ?? ''} bytes=${Buffer.byteLength(raw, 'utf8')}`)
      if (chunk.toolCallId) clearProgressReporter(chunk.toolCallId)
      if (suppressedMemoryAccessCallIds.has(chunk.toolCallId ?? '')) continue
      const isError = /^Error(?:\s|:)/i.test(raw.trimStart())
      callbacks.onToolResult(chunk.toolCallId ?? '', truncateToolResult(raw), isError)
    } else if (chunk.type === 'reasoning-delta') {
      // Providers only send thought summaries when the request asks for them
      // (Gemini includeThoughts). There is no renderer for them yet, so record
      // the volume and drop the payload instead of pricing it into the turn.
      const bytes = Buffer.byteLength(chunk.text ?? '', 'utf8')
      if (bytes > 0) {
        tracker.sawReasoningDelta = true
        recordOutputBytes(bytes)
      }
      debugLog('stream.reasoning-delta', `bytes=${bytes}`)
    } else if (chunk.type === 'tool-error') {
      sawInlineToolOutput = true
      markToolActivity()
      const toolCallId = chunk.toolCallId ?? ''
      if (toolCallId) clearProgressReporter(toolCallId)
      if (suppressedMemoryAccessCallIds.has(toolCallId)) {
        debugLog('stream.tool-error', `${chunk.toolName ?? ''} ${toolCallId} — suppressed memory access`)
        continue
      }
      if (suppressedDeferredCallIds.has(toolCallId)) {
        debugLog('stream.tool-error', `${chunk.toolName ?? ''} ${toolCallId} — suppressed deferred early-call`)
        continue
      }
      const message = chunk.error instanceof Error ? chunk.error.message : String(chunk.error ?? 'tool call failed')
      debugLog(
        'stream.tool-error',
        `${chunk.toolName ?? ''} ${toolCallId} messageBytes=${Buffer.byteLength(message, 'utf8')}`,
      )
      callbacks.onToolResult(toolCallId, toolErrorString(message), true)
    } else {
      if (
        chunk.type === 'text-end' ||
        chunk.type === 'reasoning-end' ||
        chunk.type === 'tool-input-end' ||
        chunk.type === 'finish-step' ||
        chunk.type === 'finish'
      ) {
        if (!sawInlineToolOutput) lastModelChunkAtMs = now()
      }
      debugLog('stream.other-chunk', chunk.type)
    }
  }
  textFilter.finish()
  tracker.suppressedReplay = textFilter.suppressedReplay()
  tracker.streamEndedAtMs = sawInlineToolOutput && lastModelChunkAtMs != null ? lastModelChunkAtMs : now()
}

/** Collect the completed response and usage into canonical session state. */
export async function collectTurnResponse(
  result: StreamResult,
  state: LoopState,
  modelId: string,
  callbacks: AgentCallbacks,
  turnMessages: ModelMessage[],
  recoveredText: string,
  suppressedReplay: boolean,
  requestTimestamp: string,
  cacheComparisonTtlMs?: number | null,
  tracker?: StreamAttemptTracker,
  stepSpeed?: StepSpeedAccumulator,
  now: () => number = () => performance.now(),
): Promise<string> {
  const response = await result.response
  if (!suppressedReplay) prependRecoveredText(response.messages, recoveredText)
  truncateToolResultsInMessages(response.messages)
  state.messages.push(...response.messages)
  turnMessages.push(...response.messages)

  const usage = await result.usage
  if (usage) {
    const expectedMissReasons = consumeExpectedCacheMissReasons(state)
    const raw = usage as Record<string, unknown>
    const normalized = normalizeLanguageModelUsage(raw)
    const effectiveModelId = attributedModelId(modelId, response.modelId)
    accumulateUsage(
      state,
      { source: 'main', modelId: effectiveModelId, usage: normalized },
      { updateCurrentContext: true },
    )
    if (raw.inputTokens != null) state.lastInputTokens = normalized.inputTokens

    const turnUsage = createProviderTurnUsage({
      modelId: effectiveModelId,
      usage: raw,
      normalized,
      expectedMissReasons,
      cacheComparisonTtlMs,
      timestamp: requestTimestamp,
    })
    debugLog(
      'cache.usage',
      `model=${effectiveModelId} input=${turnUsage.inputTokens ?? 'unreported'} read=${turnUsage.cacheReadTokens ?? 'unreported'} write=${turnUsage.cacheCreationTokens ?? 'unreported'} readReported=${turnUsage.cacheReadReported} writeReported=${turnUsage.cacheCreationReported} expectedMiss=${expectedMissReasons.join(',') || 'none'}`,
    )
    // Separate line on purpose: this is the value to compare across turns when
    // a provider looks like it stopped thinking. A 0 can mean either the
    // provider billed no reasoning tokens or it omitted the field entirely —
    // a missing thought summary on its own is not evidence either way.
    debugLog('thinking.usage', `model=${effectiveModelId} reasoningTokens=${normalized.reasoningTokens}`)
    const cacheMiss = appendProviderTurnUsage(state, turnUsage)
    if (cacheMiss && !cacheMiss.expected) {
      debugLog(
        'cache-break',
        `Estimated ${cacheMiss.missedTokens} re-billed input tokens after ${cacheMiss.idleMs}ms idle.`,
      )
    }
    state.prevTurnCacheRead = normalized.cacheReadTokens
    callbacks.onUsageUpdate(state.tokenUsage)
    if (state.agentRole === 'root' && callbacks.onTokenSpeedUpdate && tracker?.requestStartedAtMs !== undefined) {
      const sample = computeTurnSpeedSample({
        requestStartedAtMs: tracker.requestStartedAtMs,
        firstOutputChunkAtMs: tracker.firstOutputChunkAtMs ?? null,
        streamEndedAtMs: tracker.streamEndedAtMs ?? now(),
        sawReasoningDelta: tracker.sawReasoningDelta ?? false,
        outputTokens: normalized.outputTokens,
        reasoningTokens: normalized.reasoningTokens,
      })
      if (sample) {
        if (stepSpeed) {
          stepSpeed.outputTokens += sample.tokens
          stepSpeed.durationMs += sample.durationMs
        }
        const totalTokens = stepSpeed ? stepSpeed.outputTokens : sample.tokens
        const totalDurationMs = stepSpeed ? stepSpeed.durationMs : sample.durationMs
        const tps = (totalTokens * 1000) / totalDurationMs
        if (Number.isFinite(tps) && tps > 0) {
          callbacks.onTokenSpeedUpdate({ tokensPerSecond: tps, isEstimate: false })
        }
      }
    }
    void appendUsage(state, effectiveModelId, turnUsage)
  }

  return result.finishReason
}

export function classifyTurnFailure(
  error: unknown,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  tracker: StreamAttemptTracker,
  attemptControl: StreamAttemptControl,
): TurnOutcome {
  if (options.abortSignal?.aborted) return { kind: 'aborted' }

  const idleTimedOut = attemptControl.didIdleTimeout()
  if (idleTimedOut || isRetryableStreamTransportError(error)) {
    return {
      kind: 'stream-error',
      error: idleTimedOut ? new Error('Network stream timed out while waiting for response data') : error,
      partialText: tracker.visibleText,
      toolActivity: tracker.toolActivity,
      reason: idleTimedOut ? 'idle-timeout' : 'network',
    }
  }

  if (isAbortError(error, options.abortSignal)) return { kind: 'aborted' }
  callbacks.onError(new Error(classifyApiError(error).message))
  return { kind: 'error' }
}
