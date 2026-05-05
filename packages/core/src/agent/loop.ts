// @x-code-cli/core — Agent Loop (orchestration: streaming, tool calls, permission)
//
// Context compression lives in `./compression.ts`; this file just
// orchestrates the per-turn streaming + tool dispatch loop.
import fs from 'node:fs/promises'
import path from 'node:path'

import { streamText } from 'ai'
import type { LanguageModel, UserContent } from 'ai'

import { buildKnowledgeContext } from '../knowledge/loader.js'
import { applyCacheControl } from '../providers/cache-control.js'
import { getThinkingProviderOptions, mergeThinkingOptions } from '../providers/thinking.js'
import { toolRegistry, truncateToolResult } from '../tools/index.js'
import { clearProgressReporter, setProgressReporter } from '../tools/progress.js'
import { createTaskTool } from '../tools/task.js'
import type { AgentCallbacks, AgentOptions } from '../types/index.js'
import { debugLog } from '../utils.js'
import { classifyApiError, isContextTooLongError } from './api-errors.js'
import { checkAndCompressContext, handleContextTooLong } from './compression.js'
import { getCompressionThreshold, getMaxOutputTokens } from './context-window.js'
import { createLoopState } from './loop-state.js'
import type { LoopState } from './loop-state.js'
import { generateTaskSlug, makePlanFilePath } from './plan-storage.js'
import { downgradeBinaryPartsForProvider, ensureReasoningContentParts } from './provider-compat.js'
import { appendHeader, appendUsage, flushPendingMessages } from './session-store.js'
import { drainStreamResult } from './stream-utils.js'
import type { StreamResult } from './stream-utils.js'
import { buildSystemPrompt } from './system-prompt.js'
import { processToolCalls } from './tool-execution.js'
import { repairOrphanToolCalls, truncateToolResultsInMessages } from './tool-result-sanitize.js'

/** Pull plain text out of a UserContent payload for slugification.
 *  UserContent can be a string OR a multi-part array (text/image/file
 *  parts after `buildUserContent` ingests `@path` references); we only
 *  care about the text segments — image / file parts contribute
 *  nothing to a human-readable filename. */
function userContentToText(content: UserContent): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { type: 'text'; text: string } =>
          p?.type === 'text' && typeof (p as { text?: unknown }).text === 'string',
      )
      .map((p) => p.text)
      .join(' ')
  }
  return ''
}

export type { LoopState } from './loop-state.js'
// Re-exported for the CLI's resume / manual-compact path (see use-agent.ts).
export { compressMessages } from './compression.js'

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
    // Snapshot the current context-window occupancy from this response —
    // overwrite, not accumulate. Includes input + output because every
    // major provider (Anthropic, OpenAI, Google, DeepSeek, Moonshot,
    // Alibaba, xAI) defines context window as the SHARED budget pool of
    // input + output: input + output ≤ context_window is the architectural
    // constraint (single KV-cache cap). AI SDK's `inputTokens` already
    // includes cache_read + cache_write, so this is the full
    // prompt-the-model-saw plus what it just wrote — directly comparable
    // to `getContextWindow(modelId)` in the footer "N / M · X%" indicator.
    // Cumulative counters above remain for /usage billing summaries.
    state.tokenUsage.currentContextTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    if (usage.inputTokens != null) state.lastInputTokens = usage.inputTokens
    callbacks.onUsageUpdate(state.tokenUsage)
    // Persist a usage snapshot inline with the jsonl transcript. Per-turn
    // cadence: the picker's tail-scan only ever needs the LATEST entry, but
    // we write every turn so a crashed process doesn't lose its final
    // counts. Fire-and-forget — never blocks the loop.
    void appendUsage(state, modelId)
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

/** Build the effective tool set for this loop, applying:
 *  1. The static tool registry (always)
 *  2. The task tool (when subAgentRegistry is present)
 *  3. options.toolFilter allow/deny (for sub-agent loops)
 *
 *  Computed once per session and cached — the tool set is stable within
 *  a session (registry doesn't change, filter doesn't change). */
function buildTools(options: AgentOptions, state: LoopState) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = { ...toolRegistry }

  if (options.subAgentRegistry) {
    tools.task = createTaskTool(options.subAgentRegistry)
  }

  // Wrap readFile to record each successful read into state.readFiles.
  // The edit and writeFile tools then gate on this map: reject when the
  // model has not read the file yet, or when the file's mtime has
  // changed since the recorded read (external modification by the user
  // in another editor). Without this wrapper the gates have nothing to
  // check against and would always succeed — silent clobber risk.
  // Sub-agents wrap their OWN state's map (each sub-agent gets a fresh
  // LoopState in runner.ts) so a sub-agent's reads don't unlock the
  // parent's edits and vice versa.
  if (tools.readFile) {
    const original = tools.readFile
    tools.readFile = {
      ...original,
      execute: async (input: { filePath: string; offset?: number; limit?: number }, ctx: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (original.execute as (i: unknown, c: unknown) => Promise<any>)(input, ctx)
        try {
          const stat = await fs.stat(input.filePath)
          const userSpecifiedRange = input.offset != null || input.limit != null
          // Heuristic for "partial": explicit offset/limit, OR the file
          // is large enough that read-file's head-truncation kicked in
          // (its byte cap is 256 KB; line cap is 2000 lines but at any
          // realistic line density ≥256 KB also exceeds the line cap).
          // Files in the 2000–5000 line / <256 KB range get classified
          // as full when the head was actually truncated, but edit's
          // string-match contract makes that safe (mismatch → error).
          const wasHeadTruncated = !userSpecifiedRange && stat.size > 256 * 1024
          state.readFiles.set(input.filePath, {
            timestamp: Math.floor(stat.mtimeMs),
            isPartialView: userSpecifiedRange || wasHeadTruncated,
          })
        } catch {
          // stat failed (deleted between read and stat, permission,
          // etc.) — read may have errored too. Skip recording; the
          // edit gate will treat it as never-read.
        }
        return result
      },
    }
  }

  const filter = options.toolFilter
  if (filter) {
    if (filter.allow) {
      const allowSet = new Set(filter.allow)
      for (const name of Object.keys(tools)) {
        if (!allowSet.has(name)) delete tools[name]
      }
    }
    if (filter.deny) {
      for (const name of filter.deny) {
        delete tools[name]
      }
    }
  }

  return tools
}

/** Run one agent turn: stream to UI, collect response. Resilient to errors. */
async function runTurn(
  state: LoopState,
  model: LanguageModel,
  options: AgentOptions,
  systemPrompt: string,
  callbacks: AgentCallbacks,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  effectiveTools: Record<string, any>,
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
      tools: effectiveTools,
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
  // Drives session-usage filenames (`<slug>-<sessionId>.usage.json`)
  // and (when in plan mode) plan-file names. Set-once: changing it
  // mid-session would orphan the file the previous turn already wrote
  // to.
  //
  // For non-ASCII first messages (CJK, emoji-only) `generateTaskSlug`
  // makes one isolated generateText round-trip to summarize the task
  // into 2-4 English words; for ASCII messages it short-circuits to a
  // local slugify with no network. We kick it off in parallel with
  // knowledge / git-stat below so the round-trip overlaps with disk
  // work and doesn't add serial latency to the first turn. The
  // resulting slug is awaited before any session-usage write or plan
  // file is created (well before the first runTurn), so paths are
  // never written with a stale empty slug.
  const taskText = userContentToText(userMessage)
  const taskSlugPromise: Promise<string> = state.taskSlug
    ? Promise.resolve(state.taskSlug)
    : generateTaskSlug(taskText, model, options.modelId, options.abortSignal)

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

  // Cache knowledge context and git status on state for sub-agent use
  state.knowledgeContext = fullKnowledgeContext
  state.isGitRepo = isGitRepo

  // Resolve the slug now — must be set before any persistUsageSnapshot
  // (per-turn) or plan-file write below. `generateTaskSlug` returns ''
  // on failure, in which case session/plan files fall back to the
  // pure-timestamp naming we had before this helper existed.
  state.taskSlug = await taskSlugPromise

  // Lazy plan-file path derivation. We derive ONCE per plan-mode
  // session (the first turn that's in plan mode without a path
  // already set) from the user's task text. Re-deriving on every
  // plan-mode turn would overwrite the path the model has been
  // editing, so the !currentPlanPath guard is critical. Pass the
  // session-wide slug so non-ASCII task text still gets a readable
  // filename instead of timestamp-only.
  if (state.permissionMode === 'plan' && !state.currentPlanPath) {
    state.currentPlanPath = makePlanFilePath(taskText, { slug: state.taskSlug })
  }

  // Write the session header to its jsonl file (idempotent for resumes —
  // the header line already exists in that case and we skip). Must come
  // AFTER taskSlug resolution because the filename is `<slug>-<id>.jsonl`.
  // Fire-and-forget — never blocks the loop on FS errors.
  void appendHeader(state, options.modelId, taskText)

  const compressionThreshold = getCompressionThreshold(options.modelId)

  // Build the effective tool set once per session — includes the task
  // tool when a subAgentRegistry is available, and applies toolFilter
  // for sub-agent loops. Stable for the session lifetime.
  const effectiveTools = buildTools(options, state)

  // Auto-continuation on `length` finish. Reasoning models can exhaust the
  // output token budget before the user-visible reply completes — the old
  // behavior was to stop mid-sentence and surface an error, which looks
  // broken to the user. Instead, we push a short "continue" nudge and loop,
  // capped so a pathologically runaway reply still terminates eventually.
  const MAX_CONTINUATIONS = 3
  let continuationAttempts = 0

  while (state.turnCount < options.maxTurns) {
    state.turnCount++

    // Sweep any unpersisted messages from the prior iteration (or the
    // initial user message on iter 1) into the jsonl. Diff-based: only
    // appends `state.messages.slice(persistedMessageCount)`, so it's a
    // no-op when nothing has changed. Must come BEFORE
    // checkAndCompressContext — if compaction fires it rewrites the array
    // in place and writes its own boundary + re-flush, which assumes the
    // pre-compaction tail is already on disk.
    void flushPendingMessages(state)

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

    const outcome = await runTurn(state, model, options, systemPrompt, callbacks, effectiveTools)

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
      await processToolCalls(toolCalls, state, options, callbacks, model)
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

  // Final flush — catches the last iteration's content when we exit via
  // 'stop'/'error' (the next-iter flush at the top of the loop never
  // runs in those cases). Abort path: useAgent.abort() pushes the
  // `[Request interrupted by user]` notice AFTER agentLoop returns, so
  // it's responsible for its own flush — see use-agent.ts.
  void flushPendingMessages(state)

  return state
}

/** Sync any in-memory messages to the session jsonl. Called on exit /
 *  cleanup paths so a process kill doesn't lose the last turn. Per-turn
 *  appends already happen during agentLoop — this is the safety-net
 *  drain for whatever is left. Tolerant of a half-initialized state
 *  (no taskSlug yet etc.); flushPendingMessages no-ops when there's
 *  nothing to write. The `model` parameter is kept for API stability
 *  with the previous summary-generating implementation but is unused
 *  here — summaries now ride along on `compact-boundary` lines, not
 *  on a separate exit-time call. */
export async function saveSession(state: LoopState, _model: LanguageModel): Promise<void> {
  await flushPendingMessages(state)
}
