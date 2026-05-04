// @x-code-cli/core — Doom-loop circuit breaker
//
// Detects when the model is repeatedly making the same tool call with the
// same arguments — usually because the previous call failed and the model's
// next best idea is to try it again verbatim. On Windows we see this most
// often with shell commands that fail for quoting reasons: the model tweaks
// nothing and retries the exact same line 5–10 times, each failure padding
// the context with a stack trace.
//
// Two stages:
//   Stage 1 (soft, default threshold 3): inject a synthetic tool-result that
//     tells the model "this exact call failed 3 times, stop and change your
//     approach". The next turn sees the synthetic result and usually pivots.
//   Stage 2 (hard, default threshold 5): abort the turn and prompt the user
//     — 5 identical calls after the soft nudge means the nudge isn't helping
//     and we should not pad another round of context.
//
// Detection is by SHA256 over `{toolName, stableInputJson}`. Stable stringify
// sorts object keys so `{a:1,b:2}` and `{b:2,a:1}` hash to the same value.
//
// Tuning note: we don't use opencode's "exactly 3 identical in a row"
// predicate — that misses the case where the model tries `foo`, then reads a
// file in between, then tries `foo` again. We instead look at the last N
// tool calls of the same toolName and check if K of them share the hash.
import crypto from 'node:crypto'

import type { LoopState } from './loop-state.js'
import { toolResultMessage } from './messages.js'

/** Tool calls at or above this count in the rolling window trigger the soft
 *  synthetic nudge. */
export const SOFT_LOOP_THRESHOLD = 3

/** Tool calls at or above this count abort the turn and prompt the user. */
export const HARD_LOOP_THRESHOLD = 5

/** Size of the rolling window we scan for duplicates. */
export const LOOP_WINDOW_SIZE = 8

/** Stable JSON stringify: sorts object keys deterministically so semantically
 *  identical inputs hash to the same value regardless of key order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}'
}

/** Hash a tool call for duplicate detection. Truncated to 16 hex chars —
 *  collision probability at that length is vanishingly small for the 8-entry
 *  window we're comparing against. */
export function hashToolCall(toolName: string, input: unknown): string {
  const payload = toolName + '\x00' + stableStringify(input)
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

/** Common header carrying the precomputed call hash. Threaded through the
 *  result so {@link recordToolCall} can reuse it instead of hashing twice. */
interface LoopCheckBase {
  hash: string
}

export type LoopCheck =
  /** No loop detected — dispatch this tool call normally. */
  | (LoopCheckBase & { kind: 'ok' })
  /** Loop detected at soft threshold — inject a synthetic tool-result that
   *  tells the model to stop, and SKIP actually running the tool this round.
   *  `toolCallId` is the id of the current call so the synthetic result
   *  reads as the response to it. */
  | (LoopCheckBase & { kind: 'soft-block'; toolCallId: string; message: string })
  /** Loop detected at hard threshold — abort the turn and prompt the user. */
  | (LoopCheckBase & { kind: 'hard-block'; toolName: string; message: string })

/**
 * Check whether the incoming tool call is a duplicate of recent calls in the
 * window, and report what the caller should do. Does NOT mutate state — the
 * caller commits the hash via {@link recordToolCall} once the call proceeds.
 * The returned `hash` should be passed to `recordToolCall` to avoid a second
 * SHA256 of the same input.
 *
 * We only count matches that share the same hash AND the same toolName; a
 * fresh command with identical-looking args under a different tool never
 * triggers the guard.
 */
export function checkForLoop(state: LoopState, toolName: string, input: unknown, toolCallId: string): LoopCheck {
  const hash = hashToolCall(toolName, input)
  const window = state.recentToolCalls.slice(-LOOP_WINDOW_SIZE)

  let priorMatches = 0
  for (const entry of window) {
    if (entry.toolName === toolName && entry.hash === hash) priorMatches++
  }

  // The current incoming call is what pushes us over the threshold, so we
  // compare against N-1 prior matches.

  if (priorMatches + 1 >= HARD_LOOP_THRESHOLD) {
    return {
      kind: 'hard-block',
      hash,
      toolName,
      message: `Tool ${toolName} has been called with identical arguments ${priorMatches + 1} times in a row. The model is looping; aborting this turn.`,
    }
  }

  if (priorMatches + 1 >= SOFT_LOOP_THRESHOLD) {
    return {
      kind: 'soft-block',
      hash,
      toolCallId,
      message:
        `This exact ${toolName} call (same arguments) has already been attempted ${priorMatches + 1} times this session with the same result. ` +
        'DO NOT retry it. Change your approach — alter the arguments meaningfully, try a different tool, or ask the user what to do instead.',
    }
  }

  return { kind: 'ok', hash }
}

/** Commit a tool call to the rolling window. Bound size so the array doesn't
 *  grow for long sessions. Pass the `hash` returned by {@link checkForLoop}
 *  to skip recomputing it; omit only when called outside the check path. */
export function recordToolCall(state: LoopState, toolName: string, input: unknown, hash?: string): void {
  const h = hash ?? hashToolCall(toolName, input)
  state.recentToolCalls.push({ toolName, hash: h })
  // Keep 2x the window to give checkForLoop some history beyond the active
  // comparison window (lets us tune LOOP_WINDOW_SIZE without changing the
  // persistence footprint).
  const cap = LOOP_WINDOW_SIZE * 2
  if (state.recentToolCalls.length > cap) {
    state.recentToolCalls.splice(0, state.recentToolCalls.length - cap)
  }
}

/** Build a synthetic tool-result message telling the model the call was
 *  blocked by the loop guard. The model sees this as if the tool returned it
 *  and usually adjusts on the next turn. */
export function syntheticLoopBlockResult(toolName: string, toolCallId: string, message: string) {
  return toolResultMessage(toolCallId, toolName, `[loop-guard] ${message}`)
}
