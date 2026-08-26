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
): Promise<void> {
  const deferredNames = new Set((state.deferredCatalog ?? []).map((entry) => entry.name))
  const suppressedDeferredCallIds = new Set<string>()
  const suppressedMemoryAccessCallIds = new Set<string>()
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
      debugLog('stream.text-delta', `bytes=${Buffer.byteLength(text, 'utf8')}`)
      textFilter.push(text)
    } else if (chunk.type === 'tool-call') {
      markToolActivity()
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
      markToolActivity()
      const raw = typeof chunk.output === 'string' ? chunk.output : JSON.stringify(chunk.output ?? '')
      debugLog('stream.tool-result', `${chunk.toolCallId ?? ''} bytes=${Buffer.byteLength(raw, 'utf8')}`)
      if (chunk.toolCallId) clearProgressReporter(chunk.toolCallId)
      if (suppressedMemoryAccessCallIds.has(chunk.toolCallId ?? '')) continue
      const isError = /^Error(?:\s|:)/i.test(raw.trimStart())
      callbacks.onToolResult(chunk.toolCallId ?? '', truncateToolResult(raw), isError)
    } else if (chunk.type === 'tool-error') {
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
      debugLog('stream.other-chunk', chunk.type)
    }
  }
  textFilter.finish()
  tracker.suppressedReplay = textFilter.suppressedReplay()
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
      timestamp: requestTimestamp,
    })
    debugLog(
      'cache.usage',
      `model=${effectiveModelId} input=${turnUsage.inputTokens ?? 'unreported'} read=${turnUsage.cacheReadTokens ?? 'unreported'} write=${turnUsage.cacheCreationTokens ?? 'unreported'} readReported=${turnUsage.cacheReadReported} writeReported=${turnUsage.cacheCreationReported} expectedMiss=${expectedMissReasons.join(',') || 'none'}`,
    )
    const cacheMiss = appendProviderTurnUsage(state, turnUsage)
    if (cacheMiss && !cacheMiss.expected) {
      debugLog(
        'cache-break',
        `Estimated ${cacheMiss.missedTokens} re-billed input tokens after ${cacheMiss.idleMs}ms idle.`,
      )
    }
    state.prevTurnCacheRead = normalized.cacheReadTokens
    callbacks.onUsageUpdate(state.tokenUsage)
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
