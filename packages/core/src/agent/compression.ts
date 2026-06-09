// @x-code-cli/core — Context-window compression
//
// Two paths share the same primitives:
//   - Proactive (`checkAndCompressContext`): runs before every turn and
//     trims old messages once we cross the per-model token threshold.
//   - Reactive (`handleContextTooLong`): runs when a stream errors with
//     a "prompt too long" classification; compresses and signals retry.
//
// Both first try a cheap, in-process light compaction (drops loop-guard
// pairs — no LLM call). Only if that's insufficient do we fall through
// to `compressMessages`, which makes a generateText round-trip for an
// LLM-written summary.
import { generateText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'

import type { HookBus } from '../hooks/bus.js'
import { generateSessionSummary } from '../knowledge/session.js'
import type { AgentCallbacks } from '../types/index.js'
import { debugLog } from '../utils.js'
import { estimateTokenCount } from './context-window.js'
import { lightCompactMessages, truncateOldToolResults } from './light-compact.js'
import type { LoopState } from './loop-state.js'
import { markBoundaryAndReflush } from './session-store.js'

/** Optional hook surface threaded through both compression paths. Lets
 *  plugins observe (PreCompact) and react to (PostCompact) the act of
 *  trimming context — useful for checkpoint persistence or audit. */
export interface CompactionHookContext {
  hookBus?: HookBus
  modelId: string
  cwd: string
  abortSignal?: AbortSignal
}

/** Number of recent messages to keep verbatim when compressing. */
export const KEEP_RECENT = 6

/** Compress old messages into a summary. */
export async function compressMessages(messages: ModelMessage[], model: LanguageModel): Promise<ModelMessage[]> {
  // Ensure the "recent" slice doesn't start with an orphaned tool
  // result — providers reject tool messages that lack a preceding
  // assistant message with the matching tool_calls.
  let keepCount = KEEP_RECENT
  while (keepCount < messages.length && messages[messages.length - keepCount]?.role === 'tool') {
    keepCount++
  }
  const recent = messages.slice(-keepCount)
  const old = messages.slice(0, -keepCount)

  if (old.length === 0) return messages

  const { text: summary } = await generateText({
    model,
    system:
      'Summarize the following conversation concisely, preserving key decisions, file changes, and context needed to continue.',
    messages: old,
  })

  return [{ role: 'user', content: `[Previous conversation summary]\n${summary}` }, ...recent]
}

/**
 * Proactive compression: compress when either the last real input-token count
 * or the character-based estimate has crossed the threshold.
 *
 * Runs a light O(n) compaction first (drops loop-guard pairs — no LLM call,
 * no network). If that brings us back under the threshold, we skip the
 * expensive LLM-summary path entirely. This is the difference between a
 * $0 10ms pass and a full summarisation round trip — for loop-induced
 * bloat (by far the common case), the light path is enough.
 */
export async function checkAndCompressContext(
  state: LoopState,
  model: LanguageModel,
  threshold: number,
  callbacks: AgentCallbacks,
  hookCtx?: CompactionHookContext,
): Promise<void> {
  const needsCompression = state.lastInputTokens > threshold || estimateTokenCount(state.messages) > threshold
  if (!needsCompression || state.messages.length <= KEEP_RECENT) return

  // PreCompact — fires before either compaction path runs. We don't
  // wait for hook decisions to influence behaviour (compaction is
  // mandatory once we cross the threshold), so this is fire-and-forget.
  const messageCountBefore = state.messages.length
  const tokenEstimateBefore = estimateTokenCount(state.messages)
  emitCompactionHook(hookCtx, {
    name: 'PreCompact',
    trigger: 'proactive',
    messageCount: messageCountBefore,
    tokenEstimate: tokenEstimateBefore,
  })

  callbacks.onCompressionProgress?.('Removing duplicate tool calls...')
  const light = lightCompactMessages(state.messages)
  if (light.dropped > 0) {
    state.messages = light.messages
    const stillOver = estimateTokenCount(state.messages) > threshold
    callbacks.onContextCompressed(
      `Dropped ${light.dropped} looped tool-call message(s) to reclaim context${stillOver ? ' — still over threshold, summarising' : ''}.`,
    )
    if (!stillOver) {
      // Light compaction succeeded — write a boundary so resume won't
      // resurrect the dropped loop-guard pairs (they're still on disk
      // pre-boundary, but the loader cuts at the latest boundary). The
      // boundary carries no summary text since nothing was summarised.
      void markBoundaryAndReflush(state)
      emitCompactionHook(hookCtx, {
        name: 'PostCompact',
        trigger: 'proactive',
        messageCount: state.messages.length,
        summary: '',
      })
      return
    }
  }

  callbacks.onCompressionProgress?.('Truncating old tool results...')
  const trunc = truncateOldToolResults(state.messages)
  if (trunc.truncatedCount > 0) {
    const stillOver = estimateTokenCount(state.messages) > threshold
    callbacks.onContextCompressed(
      `Truncated ${trunc.truncatedCount} old tool result(s), saved ~${Math.round(trunc.charsSaved / 3)} tokens${stillOver ? ' — still over threshold, summarising' : ''}.`,
    )
    if (!stillOver) {
      void markBoundaryAndReflush(state)
      emitCompactionHook(hookCtx, {
        name: 'PostCompact',
        trigger: 'proactive',
        messageCount: state.messages.length,
        summary: '',
      })
      return
    }
  }

  callbacks.onCompressionProgress?.('Generating session summary...')
  let summaryText = ''
  try {
    const summary = await generateSessionSummary(state.messages, model, state.sessionId, state.startedAt, [
      ...state.filesModified,
    ])
    summaryText = summary.summary
  } catch {
    // Summary generation failed — fall through with empty text. The
    // compressMessages call below still runs its own LLM summarisation,
    // so context still shrinks; we just lose the structured summary
    // that would have ridden along on the boundary line for picker UX.
  }
  callbacks.onCompressionProgress?.('Summarizing conversation...')
  const tokensBefore = estimateTokenCount(state.messages)
  state.messages = await compressMessages(state.messages, model)
  state.lastInputTokens = 0
  state.expectCacheMiss = true
  const tokensAfter = estimateTokenCount(state.messages)
  // Write a compact-boundary line + re-flush the trimmed messages so
  // the post-boundary jsonl content equals the new in-memory state.
  void markBoundaryAndReflush(state, summaryText)
  const beforeK = Math.round(tokensBefore / 1000)
  const afterK = Math.round(tokensAfter / 1000)
  callbacks.onContextCompressed(`Context compressed: ~${beforeK}k → ~${afterK}k tokens.`)
  emitCompactionHook(hookCtx, {
    name: 'PostCompact',
    trigger: 'proactive',
    messageCount: state.messages.length,
    summary: summaryText,
  })
}

/**
 * Reactive compact: when a stream errors because the prompt was too long,
 * compress and signal the caller to retry. Mirrors Claude Code's reactiveCompact.
 * Returns true if compression happened (caller should retry this turn).
 */
export async function handleContextTooLong(
  state: LoopState,
  model: LanguageModel,
  callbacks: AgentCallbacks,
  hookCtx?: CompactionHookContext,
): Promise<boolean> {
  if (state.messages.length <= KEEP_RECENT) return false
  emitCompactionHook(hookCtx, {
    name: 'PreCompact',
    trigger: 'reactive',
    messageCount: state.messages.length,
    tokenEstimate: estimateTokenCount(state.messages),
  })
  callbacks.onCompressionProgress?.('Summarizing conversation...')
  const tokensBefore = estimateTokenCount(state.messages)
  state.messages = await compressMessages(state.messages, model)
  state.lastInputTokens = 0
  state.expectCacheMiss = true
  const tokensAfter = estimateTokenCount(state.messages)
  // Same boundary discipline as the proactive path — reactive compact
  // also shrinks state.messages in place, so the jsonl needs a
  // compact-boundary marker to keep loader semantics consistent.
  void markBoundaryAndReflush(state)
  const beforeK = Math.round(tokensBefore / 1000)
  const afterK = Math.round(tokensAfter / 1000)
  callbacks.onContextCompressed(`Context too long — compressed (~${beforeK}k → ~${afterK}k tokens). Retrying...`)
  emitCompactionHook(hookCtx, {
    name: 'PostCompact',
    trigger: 'reactive',
    messageCount: state.messages.length,
    summary: '',
  })
  return true
}

/** Fire a PreCompact / PostCompact hook with the session context. Best
 *  effort — compaction has already happened (or is committed to happen),
 *  so hook failures and aborts must not bubble. */
function emitCompactionHook(
  ctx: CompactionHookContext | undefined,
  partial:
    | { name: 'PreCompact'; trigger: 'proactive' | 'reactive'; messageCount: number; tokenEstimate: number }
    | { name: 'PostCompact'; trigger: 'proactive' | 'reactive'; messageCount: number; summary: string },
): void {
  if (!ctx?.hookBus?.has(partial.name)) return
  void ctx.hookBus
    .emit(
      {
        ...partial,
        session: { cwd: ctx.cwd, modelId: ctx.modelId },
      },
      { signal: ctx.abortSignal },
    )
    .catch((err) => debugLog(`agent.hook-${partial.name.toLowerCase()}-error`, String(err)))
}
