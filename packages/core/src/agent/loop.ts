// @x-code-cli/core — Agent Loop (orchestration: streaming, tool calls, permission, context compression)
import fs from 'node:fs/promises'
import path from 'node:path'

import { generateText, streamText } from 'ai'
import type { LanguageModel, ModelMessage, UserContent } from 'ai'

import { buildKnowledgeContext } from '../knowledge/loader.js'
import { generateSessionSummary, saveSessionSummary } from '../knowledge/session.js'
import { persistUsageSnapshot } from '../knowledge/session-usage.js'
import { applyCacheControl } from '../providers/cache-control.js'
import { getThinkingProviderOptions, mergeThinkingOptions } from '../providers/thinking.js'
import { clearProgressReporter, setProgressReporter } from '../tools/progress.js'
import { toolRegistry, truncateToolResult } from '../tools/index.js'
import type { AgentCallbacks, AgentOptions } from '../types/index.js'
import { debugLog } from '../utils.js'
import { classifyApiError, isContextTooLongError } from './api-errors.js'
import { estimateTokenCount, getCompressionThreshold, getMaxOutputTokens } from './context-window.js'
import { lightCompactMessages } from './light-compact.js'
import { createLoopState } from './loop-state.js'
import { makePlanFilePath, slugify } from './plan-storage.js'

/** Pull plain text out of a UserContent payload for slugification.
 *  UserContent can be a string OR a multi-part array (text/image/file
 *  parts after `buildUserContent` ingests `@path` references); we only
 *  care about the text segments — image / file parts contribute
 *  nothing to a human-readable filename. */
function userContentToText(content: UserContent): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: 'text'; text: string } => p?.type === 'text' && typeof (p as { text?: unknown }).text === 'string')
      .map((p) => p.text)
      .join(' ')
  }
  return ''
}
import type { LoopState } from './loop-state.js'
import { downgradeBinaryPartsForProvider, ensureReasoningContentParts } from './provider-compat.js'
import { drainStreamResult } from './stream-utils.js'
import type { StreamResult } from './stream-utils.js'
import { buildSystemPrompt } from './system-prompt.js'
import { processToolCalls } from './tool-execution.js'
import { repairOrphanToolCalls, truncateToolResultsInMessages } from './tool-result-sanitize.js'

export type { LoopState } from './loop-state.js'

/** Number of recent messages to keep verbatim when compressing. */
const KEEP_RECENT = 6

/** Compress old messages into a summary. */
export async function compressMessages(messages: ModelMessage[], model: LanguageModel): Promise<ModelMessage[]> {
  const recent = messages.slice(-KEEP_RECENT)
  const old = messages.slice(0, -KEEP_RECENT)

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
async function checkAndCompressContext(
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
    if (!stillOver) return
  }

  try {
    const summary = await generateSessionSummary(state.messages, model, state.sessionId, state.startedAt, [
      ...state.filesModified,
    ])
    await saveSessionSummary(summary)
  } catch {
    // Don't block compression on session save failure
  }
  state.messages = await compressMessages(state.messages, model)
  state.lastInputTokens = 0
  callbacks.onContextCompressed('Context compressed to fit context window.')
}

/**
 * Reactive compact: when a stream errors because the prompt was too long,
 * compress and signal the caller to retry. Mirrors Claude Code's reactiveCompact.
 * Returns true if compression happened (caller should retry this turn).
 */
async function handleContextTooLong(
  state: LoopState,
  model: LanguageModel,
  callbacks: AgentCallbacks,
): Promise<boolean> {
  if (state.messages.length <= KEEP_RECENT) return false
  state.messages = await compressMessages(state.messages, model)
  state.lastInputTokens = 0
  callbacks.onContextCompressed('Context too long — automatically compressed. Retrying...')
  return true
}

/** Consume streamText output, dispatching chunks to the UI via callbacks.
 *  Reasoning-delta chunks (thinking-mode models — DeepSeek-reasoner, o1,
 *  etc.) are deliberately ignored: that's the model's internal chain of
 *  thought, not user-facing output. The final user-facing answer arrives
 *  as regular text-delta chunks. */
async function streamChunksToUI(result: StreamResult, callbacks: AgentCallbacks): Promise<void> {
  for await (const chunk of result.fullStream) {
    if (chunk.type === 'text-delta') {
      const text = chunk.text ?? ''
      debugLog('stream.text-delta', text)
      callbacks.onTextDelta(text)
    } else if (chunk.type === 'tool-call') {
      debugLog('stream.tool-call', `${chunk.toolName ?? ''} ${JSON.stringify(chunk.input ?? {})}`)
      const toolCallId = chunk.toolCallId ?? ''
      // Register the progress side-channel BEFORE tools start executing —
      // AI SDK will synchronously invoke `execute(input, { toolCallId })`
      // for auto-executed tools right after this event, and those tools
      // call reportProgress(toolCallId, ...) to stream status updates.
      if (toolCallId) {
        setProgressReporter(toolCallId, (msg) => callbacks.onToolProgress(toolCallId, msg))
      }
      callbacks.onToolCall(toolCallId, chunk.toolName ?? '', (chunk.input ?? {}) as Record<string, unknown>)
    } else if (chunk.type === 'tool-result') {
      // Notify UI about auto-executed tool results (readFile, glob, grep, etc.)
      const raw = typeof chunk.output === 'string' ? chunk.output : JSON.stringify(chunk.output ?? '')
      debugLog('stream.tool-result', `${chunk.toolCallId ?? ''} ${raw}`)
      if (chunk.toolCallId) clearProgressReporter(chunk.toolCallId)
      callbacks.onToolResult(chunk.toolCallId ?? '', truncateToolResult(raw))
    } else {
      debugLog('stream.other-chunk', chunk.type)
    }
    // reasoning-delta / reasoning-start / reasoning-end: intentionally dropped from UI
    // but logged above under stream.other-chunk so we can see them in debug mode.
  }
}

/** Pull the response + usage off a completed stream and fold into state. */
async function collectTurnResponse(
  result: StreamResult,
  state: LoopState,
  modelId: string,
  callbacks: AgentCallbacks,
): Promise<string> {
  const response = await result.response
  // CRITICAL: auto-executed tools (readFile / grep / glob / listDir / webFetch
  // / webSearch) return their results through `response.messages` without
  // passing through the manual `pushToolResult` path. Without a sanitizer
  // pass here, reading an 800-line file or a grep that matched 2k times dumps
  // the full content into `state.messages` and then rides along on every
  // subsequent turn. The worst realized case before this sanitizer was a
  // 9M-token context built from cumulative failed-shell stacks + unsliced
  // file reads. Truncate here so the messages we persist match the per-tool
  // budget used elsewhere in the loop.
  truncateToolResultsInMessages(response.messages)
  state.messages.push(...response.messages)
  ensureReasoningContentParts(state.messages, modelId)

  const usage = await result.usage
  if (usage) {
    state.tokenUsage.inputTokens += usage.inputTokens ?? 0
    state.tokenUsage.outputTokens += usage.outputTokens ?? 0
    // AI SDK v6 normalizes provider cache fields into inputTokenDetails:
    //   cacheReadTokens  ← Anthropic cache_read_input_tokens / OpenAI cached_tokens
    //   cacheWriteTokens ← Anthropic cache_creation_input_tokens (others: 0)
    // Both are subsets of inputTokens, so we don't double-count into total.
    state.tokenUsage.cacheReadTokens += usage.inputTokenDetails?.cacheReadTokens ?? 0
    state.tokenUsage.cacheCreationTokens += usage.inputTokenDetails?.cacheWriteTokens ?? 0
    state.tokenUsage.totalTokens = state.tokenUsage.inputTokens + state.tokenUsage.outputTokens
    if (usage.inputTokens != null) state.lastInputTokens = usage.inputTokens
    callbacks.onUsageUpdate(state.tokenUsage)
    void persistUsageSnapshot(state, modelId)
  }

  return result.finishReason
}

type TurnOutcome =
  /** Turn completed normally; `finishReason` says what to do next. */
  | { kind: 'done'; finishReason: string; result: StreamResult }
  /** Fatal error (already reported to callbacks); caller should break the loop. */
  | { kind: 'error' }
  /** Context overflowed and was compressed; caller should retry this turn. */
  | { kind: 'retry' }
  /** User aborted the request (Esc / Ctrl+C). NOT reported to onError —
   *  the UI shows a `[Request interrupted by user]` notice instead. */
  | { kind: 'aborted' }

/** AbortError from streamText / fetch is the SDK's signal that we cancelled
 *  the request. We also accept any error that lands while abortSignal is
 *  already aborted — some providers wrap the underlying AbortError into their
 *  own error class but still flip the signal first. */
function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true
    if (/aborted|AbortError/i.test(err.message)) return true
  }
  return false
}

/** Run one agent turn: stream to UI, collect response. Resilient to errors. */
async function runTurn(
  state: LoopState,
  model: LanguageModel,
  options: AgentOptions,
  systemPrompt: string,
  callbacks: AgentCallbacks,
): Promise<TurnOutcome> {
  // Defensive sweep BEFORE every API call: if the previous turn left
  // an assistant tool_call without a paired tool_result anywhere in
  // state.messages (model emitted malformed tool input → SDK rejected
  // with tool-error and never produced a result; or a turn errored
  // mid-flight), append a synthetic error result so the request body
  // is well-formed. Providers strictly require tool_call ↔ tool_result
  // pairing and reject the whole request with confusing errors like
  // "tool must be a response to a preceding message with tool_calls".
  // Idempotent — running every turn is cheap and bulletproof.
  repairOrphanToolCalls(state.messages)

  // Text-only providers (DeepSeek, custom) would 400 on any surviving
  // image/file parts. Rewrite those parts to OCR'd text in-place before
  // the stream starts. Multimodal providers short-circuit inside the
  // helper based on their capability flags.
  await downgradeBinaryPartsForProvider(state.messages, options.modelId)

  // Per-provider prompt caching: Anthropic gets cache_control breakpoints on
  // the system prompt + last two messages; OpenAI gets a stable
  // promptCacheKey keyed on sessionId; OpenAI-compatible providers rely on
  // the system-prompt cache in LoopState keeping the prefix byte-stable.
  const cached = applyCacheControl({
    system: systemPrompt,
    messages: state.messages,
    modelId: options.modelId,
    sessionId: state.sessionId,
  })

  // Extended-thinking / reasoning toggle. The user-facing `/thinking on|off`
  // command (App.tsx) flips `options.thinking`; we translate that flag into
  // the provider-specific switch (Anthropic `thinking`, Google
  // `thinkingConfig`, Alibaba `enableThinking`, etc.) and merge it into the
  // existing per-call providerOptions. Models with no thinking concept
  // (gpt-4.1, grok-3, glm-4-plus) get an empty entry — the SDK silently
  // ignores the unrelated keys. Defaults to off when undefined so a stale
  // config without the new field doesn't surprise users with a quality /
  // latency change on launch.
  const thinkingOptions = getThinkingProviderOptions(options.modelId, options.thinking ?? false)
  const mergedProviderOptions = mergeThinkingOptions(cached.providerOptions, thinkingOptions)

  let result: StreamResult
  try {
    result = streamText({
      model,
      system: cached.system,
      messages: cached.messages,
      tools: toolRegistry,
      maxRetries: 3,
      abortSignal: options.abortSignal,
      // Explicit ceiling so provider defaults don't silently truncate long
      // replies. Most providers clamp a too-high value, but some reject it
      // outright with HTTP 400. getMaxOutputTokens applies per-model ceilings;
      // unknown models fall through to the module-level default.
      maxOutputTokens: getMaxOutputTokens(options.modelId),
      // AI SDK types `providerOptions` as `SharedV3ProviderOptions` (nested
      // JSONObject). Our cache-control helper returns a looser
      // `Record<string, unknown>` shape because provider-specific field sets
      // drift too fast to keep a strict union in sync. The runtime contract
      // is narrow JSON and we cast here at the single call site.
      providerOptions: mergedProviderOptions as Parameters<typeof streamText>[0]['providerOptions'],
    }) as unknown as StreamResult
  } catch (err) {
    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    callbacks.onError(new Error(classifyApiError(err).message))
    return { kind: 'error' }
  }

  // Pre-attach .catch(noop) handlers to every sibling promise the SDK exposes
  // (response/usage/finishReason/toolCalls) BEFORE we await the stream. On
  // request failure the SDK rejects all of them in the same tick — if we wait
  // for fullStream to throw and only then drain, Node's unhandled-rejection
  // sweep can run first and terminate the process. Attaching catch handlers
  // early is idempotent: a later `await result.response` still rejects and
  // propagates normally through our error path.
  drainStreamResult(result)

  try {
    await streamChunksToUI(result, callbacks)
  } catch (err) {
    // Silently drain all pending AI SDK promises so unhandled-rejection
    // warnings (NoOutputGeneratedError) don't leak to stderr.
    drainStreamResult(result)

    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    if (isContextTooLongError(err)) {
      const compressed = await handleContextTooLong(state, model, callbacks)
      if (compressed) return { kind: 'retry' }
    }
    callbacks.onError(new Error(classifyApiError(err).message))
    return { kind: 'error' }
  }

  try {
    const finishReason = await collectTurnResponse(result, state, options.modelId, callbacks)
    debugLog(
      'turn.finish',
      `reason=${finishReason} turn=${state.turnCount} input=${state.lastInputTokens} total=${state.tokenUsage.totalTokens}`,
    )
    return { kind: 'done', finishReason, result }
  } catch (err) {
    drainStreamResult(result)
    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    callbacks.onError(new Error(classifyApiError(err).message))
    return { kind: 'error' }
  }
}

/** Main agent loop. */
export async function agentLoop(
  userMessage: UserContent,
  model: LanguageModel,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  existingState?: LoopState,
): Promise<LoopState> {
  const state = existingState ?? createLoopState(options.permissionMode ?? 'default')
  state.messages.push({ role: 'user', content: userMessage })

  // Derive the session task-slug ONCE per session, on the first turn.
  // Drives session-usage filenames (`<slug>-<sessionId>.usage.json`).
  // Set-once: changing it mid-session would orphan the file the
  // previous turn already wrote to. Empty for CJK-only first messages
  // — session-usage then falls back to pure timestamp naming.
  if (!state.taskSlug) {
    state.taskSlug = slugify(userContentToText(userMessage))
  }

  // Lazy plan-file path derivation. We derive ONCE per plan-mode
  // session (the first turn that's in plan mode without a path
  // already set) from the user's task text. Re-deriving on every
  // plan-mode turn would overwrite the path the model has been
  // editing, so the !currentPlanPath guard is critical.
  if (state.permissionMode === 'plan' && !state.currentPlanPath) {
    state.currentPlanPath = makePlanFilePath(userContentToText(userMessage))
  }

  // Session continuation is handled explicitly by the UI: if the user accepts
  // the resume prompt, the pending work is embedded directly in their first
  // user message. Auto-injecting it into every system prompt made the model
  // treat trivial greetings as "continue exploring", so we no longer do that.
  const fullKnowledgeContext = await buildKnowledgeContext()

  // Detect git repo once — cheap stat, avoids per-turn disk hit
  const isGitRepo = await fs
    .stat(path.join(process.cwd(), '.git'))
    .then(() => true)
    .catch(() => false)

  const compressionThreshold = getCompressionThreshold(options.modelId)

  // Auto-continuation on `length` finish. Reasoning models can exhaust the
  // output token budget before the user-visible reply completes — the old
  // behavior was to stop mid-sentence and surface an error, which looks
  // broken to the user. Instead, we push a short "continue" nudge and loop,
  // capped so a pathologically runaway reply still terminates eventually.
  const MAX_CONTINUATIONS = 3
  let continuationAttempts = 0

  while (state.turnCount < options.maxTurns) {
    state.turnCount++

    await checkAndCompressContext(state, model, compressionThreshold, callbacks)

    // Build the system prompt once per session and reuse it across turns.
    // Stable byte-level prefix is a prerequisite for OpenAI-compatible
    // providers' automatic prefix caching (DeepSeek, Moonshot, Alibaba,
    // Zhipu, xAI). If this string changes between turns — e.g. because
    // buildSystemPrompt interpolates a fresh timestamp — the cache misses
    // every request.
    //
    // The plan-mode overlay is folded into this same byte-stable cache.
    // tool-execution invalidates the cache (sets it to null) when
    // permissionMode flips, so each mode's prompt stays cache-friendly
    // for as long as the mode is active. Only the boundary turn pays the
    // cache miss.
    if (!state.systemPromptCache) {
      state.systemPromptCache = buildSystemPrompt({
        knowledgeContext: fullKnowledgeContext,
        modelId: options.modelId,
        isGitRepo,
        planMode: state.permissionMode === 'plan',
        planFilePath: state.currentPlanPath ?? undefined,
      })
    }
    const systemPrompt = state.systemPromptCache

    const outcome = await runTurn(state, model, options, systemPrompt, callbacks)

    if (outcome.kind === 'error') break
    if (outcome.kind === 'aborted') break
    if (outcome.kind === 'retry') {
      // Don't count a failed attempt that got recovered via reactive compaction.
      state.turnCount--
      continue
    }

    if (outcome.finishReason === 'tool-calls') {
      // Any successful tool round means the model is making real progress —
      // reset the consecutive-truncation counter.
      continuationAttempts = 0
      let toolCalls: Awaited<StreamResult['toolCalls']>
      try {
        toolCalls = await outcome.result.toolCalls
      } catch (err) {
        if (isAbortError(err, options.abortSignal)) break
        callbacks.onError(new Error(classifyApiError(err).message))
        break
      }
      await processToolCalls(toolCalls, state, options, callbacks)
      // processToolCalls short-circuits on abort with synthetic results;
      // skip the next streamText call which would just throw AbortError.
      if (options.abortSignal?.aborted) break
      continue
    }

    if (outcome.finishReason === 'length') {
      if (continuationAttempts < MAX_CONTINUATIONS) {
        continuationAttempts++
        debugLog(
          'turn.length-continuation',
          `attempt=${continuationAttempts}/${MAX_CONTINUATIONS} turn=${state.turnCount}`,
        )
        // Nudge the model to pick up exactly where it stopped. This goes
        // into state.messages but NOT into UI messages, so the user sees
        // one continuous streamed reply with at most a brief pause.
        state.messages.push({
          role: 'user',
          content:
            'Output token limit hit. Resume directly — no apology, no recap. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.',
        })
        continue
      }
      callbacks.onError(
        new Error(
          `Response still truncated after ${MAX_CONTINUATIONS} continuation attempts — ask a narrower question.`,
        ),
      )
      break
    }

    if (outcome.finishReason === 'content-filter') {
      callbacks.onError(new Error('Response stopped by the provider content filter.'))
    }

    break
  }

  if (state.turnCount >= options.maxTurns) {
    callbacks.onError(new Error(`Reached maximum turns (${options.maxTurns}). Stopping agent loop.`))
  }

  return state
}

/** Save session on exit. Summary generation makes an LLM call that can be
 *  slow, so we bound it with a 2s timeout — on Ctrl+C we want to return
 *  to the shell promptly, not wait for a roundtrip. If the timeout fires
 *  or the call fails, we silently skip (session summaries are nice-to-have,
 *  not critical for exit). */
export async function saveSession(state: LoopState, model: LanguageModel, timeoutMs = 2000): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const summary = await generateSessionSummary(
      state.messages,
      model,
      state.sessionId,
      state.startedAt,
      [...state.filesModified],
      controller.signal,
    )
    await saveSessionSummary(summary)
  } catch {
    // Timeout or any other failure — skip summary silently.
  } finally {
    clearTimeout(timer)
  }
}
