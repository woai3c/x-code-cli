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

import { generateSessionSummary } from '../knowledge/session.js'
import type { AgentCallbacks } from '../types/index.js'
import { estimateTokenCount } from './context-window.js'
import { lightCompactMessages } from './light-compact.js'
import type { LoopState } from './loop-state.js'
import { markBoundaryAndReflush } from './session-store.js'

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
): Promise<void> {
  const needsCompression = state.lastInputTokens > threshold || estimateTokenCount(state.messages) > threshold
  if (!needsCompression || state.messages.length <= KEEP_RECENT) return

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
      return
    }
  }

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
  state.messages = await compressMessages(state.messages, model)
  state.lastInputTokens = 0
  // Write a compact-boundary line + re-flush the trimmed messages so
  // the post-boundary jsonl content equals the new in-memory state.
  void markBoundaryAndReflush(state, summaryText)
  callbacks.onContextCompressed('Context compressed to fit context window.')
}

/** Hard cap on consecutive failed auto-compaction attempts. Beyond this,
 *  handleContextTooLong gives up and surfaces the error to the user
 *  instead of compressing-then-erroring forever. Without the cap, a
 *  pathological prompt that compresses but still overflows loops
 *  indefinitely until the user hits Esc, burning API quota every cycle.
 *  Matches Claude Code's MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES. */
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILS = 3

/**
 * Reactive compact: when a stream errors because the prompt was too long,
 * compress and signal the caller to retry. Mirrors Claude Code's reactiveCompact.
 * Returns true if compression happened (caller should retry this turn).
 *
 * Circuit breaker: state.consecutiveAutoCompactFails counts compactions
 * that ran but the very next turn ALSO threw context_length_exceeded.
 * Past MAX_CONSECUTIVE_AUTOCOMPACT_FAILS, we stop and let the error
 * propagate. The counter resets to 0 in runTurn on a successful turn
 * (any finishReason that isn't a context-overflow error).
 */
export async function handleContextTooLong(
  state: LoopState,
  model: LanguageModel,
  callbacks: AgentCallbacks,
): Promise<boolean> {
  if (state.messages.length <= KEEP_RECENT) return false
  if (state.consecutiveAutoCompactFails >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILS) {
    callbacks.onContextCompressed(
      `Context still too long after ${MAX_CONSECUTIVE_AUTOCOMPACT_FAILS} compaction attempts — giving up to avoid an infinite retry loop. Try /clear, or split the request into smaller pieces.`,
    )
    return false
  }
  state.messages = await compressMessages(state.messages, model)
  state.lastInputTokens = 0
  state.consecutiveAutoCompactFails += 1
  // Same boundary discipline as the proactive path — reactive compact
  // also shrinks state.messages in place, so the jsonl needs a
  // compact-boundary marker to keep loader semantics consistent.
  void markBoundaryAndReflush(state)
  callbacks.onContextCompressed(
    `Context too long — automatically compressed (attempt ${state.consecutiveAutoCompactFails}/${MAX_CONSECUTIVE_AUTOCOMPACT_FAILS}). Retrying...`,
  )
  return true
}
