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
import { estimateMessageTokenCount, estimateTokenCount } from './context-window.js'
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

/** Approximate token budget for the "recent" slice kept verbatim.
 *  Messages are walked from newest to oldest; once the running total
 *  exceeds this budget the walk stops and everything older gets
 *  summarized. Prevents a single massive tool result from consuming
 *  the entire keep window (the old KEEP_RECENT=6 messages approach). */
export const KEEP_RECENT_TOKENS = 20_000

/** Minimum messages we'll always preserve even if they exceed
 *  KEEP_RECENT_TOKENS, so we never produce an empty "recent" slice. */
export const MIN_KEEP_MESSAGES = 2

/** @deprecated Use KEEP_RECENT_TOKENS. Kept for backward compat —
 *  now returns MIN_KEEP_MESSAGES (the guard used by /compact). */
export const KEEP_RECENT = MIN_KEEP_MESSAGES

// ── Summarization prompts ──

const INITIAL_SUMMARY_SYSTEM = `You are a context-compression assistant. Summarize the conversation into a structured checkpoint another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user, or "(none)"]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Data, examples, or references needed to continue, or "(none)"]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

const UPDATE_SUMMARY_SYSTEM = `You are a context-compression assistant. The user will provide NEW conversation messages and a <previous-summary>. Update the existing summary with new information.

RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- If something is no longer relevant, you may remove it
- PRESERVE exact file paths, function names, and error messages

Use the SAME structured format as the previous summary (## Goal, ## Constraints & Preferences, ## Progress, ## Key Decisions, ## Next Steps, ## Critical Context).`

/** Compress old messages into a structured summary, preserving the
 *  recent tail based on a token budget rather than a fixed message count.
 *
 *  When a previousSummary exists (from an earlier compaction), the LLM
 *  is asked to incrementally UPDATE it with the new messages rather than
 *  re-summarize from scratch — this preserves earlier decisions that
 *  would otherwise be lost through repeated dilution.
 *
 *  The filesTracked set (if provided) is appended to the summary as
 *  <files-modified> / <files-read> tags so the model knows which files
 *  were touched even after the original messages are gone. */
export async function compressMessages(
  messages: ModelMessage[],
  model: LanguageModel,
  previousSummary?: string,
  filesTracked?: { modified: string[]; read: string[] },
  abortSignal?: AbortSignal,
): Promise<ModelMessage[]> {
  // Walk from newest to oldest accumulating estimated tokens until we
  // hit KEEP_RECENT_TOKENS. This replaces the old fixed-count slice.
  let keepCount = 0
  let tokenBudget = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokenCount(messages[i])
    if (tokenBudget + msgTokens > KEEP_RECENT_TOKENS && keepCount >= MIN_KEEP_MESSAGES) break
    tokenBudget += msgTokens
    keepCount++
  }

  // Ensure the slice doesn't start with an orphaned tool result —
  // providers reject tool messages lacking a preceding assistant.
  while (keepCount < messages.length && messages[messages.length - keepCount]?.role === 'tool') {
    keepCount++
  }

  const recent = messages.slice(-keepCount)
  const old = messages.slice(0, -keepCount)

  if (old.length === 0) return messages

  const isUpdate = !!previousSummary
  const systemPrompt = isUpdate ? UPDATE_SUMMARY_SYSTEM : INITIAL_SUMMARY_SYSTEM

  // For update mode, wrap the previous summary and send the new messages
  // as the conversation to incorporate.
  const userContent = isUpdate
    ? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\nNew messages to incorporate follow in the conversation.`
    : undefined

  const messagesToSummarize: ModelMessage[] = isUpdate
    ? [{ role: 'user' as const, content: userContent! }, ...old]
    : old

  const { text: summary } = await generateText({
    model,
    abortSignal,
    instructions: systemPrompt,
    messages: messagesToSummarize,
  })

  // Append file tracking metadata
  let enrichedSummary = summary
  if (filesTracked) {
    const { modified, read } = filesTracked
    if (modified.length > 0) {
      enrichedSummary += `\n\n<files-modified>\n${modified.join('\n')}\n</files-modified>`
    }
    if (read.length > 0) {
      enrichedSummary += `\n\n<files-read>\n${read.join('\n')}\n</files-read>`
    }
  }

  return [{ role: 'user', content: `[Previous conversation summary]\n${enrichedSummary}` }, ...recent]
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
  if (!needsCompression || state.messages.length <= MIN_KEEP_MESSAGES) return

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
      void markBoundaryAndReflush(state)
      state.lastInputTokens = 0
      state.expectCacheMiss = true
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
      state.lastInputTokens = 0
      state.expectCacheMiss = true
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
    const summary = await generateSessionSummary(
      state.messages,
      model,
      state.sessionId,
      state.startedAt,
      [...state.filesModified],
      hookCtx?.abortSignal,
    )
    summaryText = summary.summary
  } catch {
    // Summary generation failed — fall through with empty text. The
    // compressMessages call below still runs its own LLM summarisation,
    // so context still shrinks; we just lose the structured summary
    // that would have ridden along on the boundary line for picker UX.
  }
  callbacks.onCompressionProgress?.('Summarizing conversation...')
  const tokensBefore = estimateTokenCount(state.messages)

  // Extract previous summary from the first message if it was produced
  // by an earlier compaction (incremental update mode).
  const previousSummary = extractPreviousSummary(state.messages)

  // Build file-tracking metadata from state.filesModified + readFileCache
  const filesTracked = buildFilesTracked(state)

  state.messages = await compressMessages(state.messages, model, previousSummary, filesTracked, hookCtx?.abortSignal)
  state.lastInputTokens = 0
  state.expectCacheMiss = true
  const tokensAfter = estimateTokenCount(state.messages)
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
  if (state.messages.length <= MIN_KEEP_MESSAGES) return false
  emitCompactionHook(hookCtx, {
    name: 'PreCompact',
    trigger: 'reactive',
    messageCount: state.messages.length,
    tokenEstimate: estimateTokenCount(state.messages),
  })
  callbacks.onCompressionProgress?.('Summarizing conversation...')
  const tokensBefore = estimateTokenCount(state.messages)

  const previousSummary = extractPreviousSummary(state.messages)
  const filesTracked = buildFilesTracked(state)

  state.messages = await compressMessages(state.messages, model, previousSummary, filesTracked, hookCtx?.abortSignal)
  state.lastInputTokens = 0
  state.expectCacheMiss = true
  const tokensAfter = estimateTokenCount(state.messages)
  void markBoundaryAndReflush(state)

  // Anti-spin guard. If summarizing barely freed context, the overflow
  // lives in the kept recent messages — bail so the user can /clear.
  if (tokensAfter > tokensBefore * 0.9) {
    debugLog('compression.reactive-no-progress', `before=${tokensBefore} after=${tokensAfter} — not retrying`)
    return false
  }

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

// ── Helpers ──

const SUMMARY_PREFIX = '[Previous conversation summary]\n'

/** Extract the previous compaction summary from messages[0] if it was
 *  produced by an earlier compressMessages call. Returns undefined for
 *  sessions that haven't been compacted yet. */
function extractPreviousSummary(messages: ModelMessage[]): string | undefined {
  if (messages.length === 0) return undefined
  const first = messages[0]
  if (first.role !== 'user' || typeof first.content !== 'string') return undefined
  if (!first.content.startsWith(SUMMARY_PREFIX)) return undefined
  return first.content.slice(SUMMARY_PREFIX.length)
}

/** Build the files-modified / files-read tracking lists from LoopState.
 *  Cost: a few dozen short path strings — negligible token overhead. */
function buildFilesTracked(state: LoopState): { modified: string[]; read: string[] } {
  const modified = [...state.filesModified]
  const read = [...state.readFileCache.keys()].filter((p) => !state.filesModified.has(p))
  return { modified, read }
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
