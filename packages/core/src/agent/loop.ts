// @x-code-cli/core — Agent Loop (orchestration: streaming, tool calls, permission)
//
// Context compression lives in `./compression.ts`; this file just
// orchestrates the per-turn streaming + tool dispatch loop.
import fs from 'node:fs/promises'
import path from 'node:path'

import { streamText } from 'ai'
import type { LanguageModel, UserContent } from 'ai'

import { loadUserConfig } from '../config/index.js'
import { aggregateUserPromptSubmit } from '../hooks/bus.js'
import type { HookEvent } from '../hooks/types.js'
import { buildKnowledgeContext } from '../knowledge/loader.js'
import { listMcpResources, readMcpResource } from '../mcp/resources.js'
import { bridgeMcpTool, toSystemPromptEntries } from '../mcp/tool-bridge.js'
import { applyCacheControl } from '../providers/cache-control.js'
import { getThinkingProviderOptions, mergeThinkingOptions } from '../providers/thinking.js'
import { createActivateSkillTool } from '../tools/activate-skill.js'
import { createGetGoalTool } from '../tools/get-goal.js'
import { toolRegistry, truncateToolResult } from '../tools/index.js'
import { clearProgressReporter, setProgressReporter } from '../tools/progress.js'
import { createReadFileTool } from '../tools/read-file.js'
import { createTaskTool } from '../tools/task.js'
import { toolSearch } from '../tools/tool-search.js'
import { createUpdateGoalTool } from '../tools/update-goal.js'
import type { AgentCallbacks, AgentOptions } from '../types/index.js'
import { debugLog } from '../utils.js'
import { classifyApiError, isContextTooLongError } from './api-errors.js'
import { checkAndCompressContext, handleContextTooLong } from './compression.js'
import { getCompressionThreshold, getContextWindow, getMaxOutputTokens } from './context-window.js'
import { createLoopState } from './loop-state.js'
import type { LoopState } from './loop-state.js'
import { runMemoryExtractor } from './memory-extractor.js'
import { toolErrorString } from './messages.js'
import { generateTaskSlug, makePlanFilePath } from './plan-storage.js'
import {
  downgradeBinaryPartsForProvider,
  ensureReasoningContentParts,
  reattachToolResultImagesForProvider,
} from './provider-compat.js'
import { appendCheckpoint, appendHeader, appendUsage, flushPendingMessages } from './session-store.js'
import { createCheckpoint } from './snapshot.js'
import { drainStreamResult } from './stream-utils.js'
import type { StreamResult } from './stream-utils.js'
import { buildSystemPrompt } from './system-prompt.js'
import { processToolCalls } from './tool-execution.js'
import { collapseStaleToolResults } from './tool-result-pruning.js'
import { repairOrphanToolCalls, truncateToolResultsInMessages } from './tool-result-sanitize.js'
import { DEFERRED_BUILTIN_TOOLS, buildDeferredCatalog, composeTurnTools } from './tool-search/catalog.js'

/** Prepend an injected context block to a UserContent payload. Used by
 *  the UserPromptSubmit hook decision: plugins can inject context (e.g.
 *  current sprint info) before the model sees the user's actual prompt.
 *  We prepend INTO the user message rather than insert a separate user
 *  message to avoid producing two consecutive user turns (some providers
 *  reject that — Claude refuses to alternate role==='user' twice). */
function prependContext(userMessage: UserContent, context: string): UserContent {
  const block = `<plugin_context>\n${context}\n</plugin_context>\n\n`
  if (typeof userMessage === 'string') return block + userMessage
  return [{ type: 'text', text: block }, ...userMessage]
}

/** Drain the UI's mid-turn message queue into `state.messages` as ONE
 *  merged user message. Multiple queued texts are joined rather than
 *  pushed as consecutive user turns — back-to-back user messages break
 *  some providers' tool-call sequencing (see prependContext). Returns
 *  true when a message was injected. Called at tool-batch boundaries
 *  and on `stop`, never mid-stream. */
function drainQueuedInputs(state: LoopState, options: AgentOptions): boolean {
  const queued = options.consumeQueuedInputs?.()
  if (!queued?.length) return false
  const text = queued
    .map((t) => t.trim())
    .filter(Boolean)
    .join('\n\n')
  if (!text) return false
  // Wrap with temporal context (Claude Code's wrapCommandText phrasing):
  // without it the model can't tell a mid-turn steer from a post-task
  // instruction and may abandon the unfinished half of the current task.
  // Pure text — works on every provider, no API feature required.
  const wrapped =
    'The user sent a new message while you were working:\n' +
    text +
    "\n\nIMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it."
  state.messages.push({ role: 'user', content: wrapped })
  return true
}

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

/** What `agentLoop` returns to its caller.
 *
 *  - `state` is the long-lived session state (messages, tokenUsage, etc.).
 *    The main interactive CLI stores it in `loopStateRef` and feeds it
 *    back as `existingState` on the next user submit.
 *  - `turnCount` is how many rounds of streamText this single invocation
 *    ran. It's NOT on `state` because that would imply it accumulates
 *    across submits — it doesn't. Sub-agent runner and `--print` mode
 *    are the real consumers; the main interactive loop ignores it. */
export interface AgentLoopResult {
  state: LoopState
  turnCount: number
}

/** Consume streamText output, dispatching chunks to the UI via callbacks.
 *  Reasoning-delta chunks (thinking-mode models — DeepSeek-reasoner, o1,
 *  etc.) are deliberately ignored: that's the model's internal chain of
 *  thought, not user-facing output. The final user-facing answer arrives
 *  as regular text-delta chunks. */
async function streamChunksToUI(result: StreamResult, callbacks: AgentCallbacks, state: LoopState): Promise<void> {
  // Deferred tools (webSearch / MCP / etc.) are name-only until the model loads
  // them via toolSearch. If the model calls one BEFORE loading it, the tool
  // isn't in this turn's tools map and the SDK rejects it with a tool-error.
  // Track those calls so we can keep them out of the UI entirely.
  const deferredNames = new Set((state.deferredCatalog ?? []).map((e) => e.name))
  const suppressedDeferredCallIds = new Set<string>()
  for await (const chunk of result.fullStream) {
    if (chunk.type === 'error') {
      // AI SDK doesn't throw from fullStream iteration on request failure —
      // it enqueues this chunk and closes the stream (stream-text.ts:1910).
      // Without this re-throw the loop completes normally, then
      // `await result.response` rejects with NoOutputGeneratedError —
      // user sees that generic message instead of the real provider error
      // (e.g. "insufficient balance"). Throw the original wrapped error so
      // the outer try/catch can pass it to classifyApiError.
      throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error))
    }
    if (chunk.type === 'text-delta') {
      const text = chunk.text ?? ''
      debugLog('stream.text-delta', text)
      callbacks.onTextDelta(text)
    } else if (chunk.type === 'tool-call') {
      debugLog('stream.tool-call', `${chunk.toolName ?? ''} ${JSON.stringify(chunk.input ?? {})}`)
      const toolCallId = chunk.toolCallId ?? ''
      const toolName = chunk.toolName ?? ''
      // Deferred tool called before it was loaded: its schema isn't in this
      // turn's tools map, so the SDK will immediately reject it with a
      // tool-error (NoSuchToolError). Suppress the UI row entirely — otherwise
      // onToolCall paints a live "Running…" line that the tool-error chunk
      // below can't clear (there's no result), leaving a phantom row that hangs
      // until the whole turn ends. state.messages still carries the SDK's error
      // result, so the model sees what happened and self-corrects via toolSearch.
      if (deferredNames.has(toolName) && !state.activatedTools.has(toolName)) {
        suppressedDeferredCallIds.add(toolCallId)
        debugLog('stream.deferred-early-call', `${toolName} ${toolCallId} — suppressed (not loaded yet)`)
        continue
      }
      // Register the progress side-channel BEFORE tools start executing —
      // AI SDK will synchronously invoke `execute(input, { toolCallId })`
      // for auto-executed tools right after this event, and those tools
      // call reportProgress(toolCallId, ...) to stream status updates.
      if (toolCallId) {
        setProgressReporter(toolCallId, (msg) => callbacks.onToolProgress(toolCallId, msg))
      }
      callbacks.onToolCall(toolCallId, toolName, (chunk.input ?? {}) as Record<string, unknown>)
    } else if (chunk.type === 'tool-result') {
      // Notify UI about auto-executed tool results (readFile, glob, grep, etc.)
      const raw = typeof chunk.output === 'string' ? chunk.output : JSON.stringify(chunk.output ?? '')
      debugLog('stream.tool-result', `${chunk.toolCallId ?? ''} ${raw}`)
      if (chunk.toolCallId) clearProgressReporter(chunk.toolCallId)
      callbacks.onToolResult(chunk.toolCallId ?? '', truncateToolResult(raw))
    } else if (chunk.type === 'tool-error') {
      // The SDK rejected a tool call mid-stream. Two cases:
      //  1. A deferred tool called before loading — already suppressed above,
      //     so there's no UI row to clear; stay silent.
      //  2. A genuine failure (malformed input on a loaded tool, or a
      //     hallucinated tool name) where onToolCall DID paint a "Running…"
      //     row. Resolve it to a visible error instead of letting it hang —
      //     the old code dropped this chunk into the `else` below and the row
      //     stayed "Running…" until the turn ended.
      const toolCallId = chunk.toolCallId ?? ''
      if (toolCallId) clearProgressReporter(toolCallId)
      if (suppressedDeferredCallIds.has(toolCallId)) {
        debugLog('stream.tool-error', `${chunk.toolName ?? ''} ${toolCallId} — suppressed deferred early-call`)
        continue
      }
      const message = chunk.error instanceof Error ? chunk.error.message : String(chunk.error ?? 'tool call failed')
      debugLog('stream.tool-error', `${chunk.toolName ?? ''} ${toolCallId} ${message}`)
      callbacks.onToolResult(toolCallId, toolErrorString(message), true)
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
    // AI SDK v6 (createOpenAICompatible) returns inputTokens / outputTokens
    // as objects { total, noCache, cacheRead, etc. }; older adapters
    // (DeepSeek, Anthropic, etc.) return them as raw numbers. Normalize.
    const raw = usage as Record<string, unknown>
    const inputTokens =
      typeof raw.inputTokens === 'number'
        ? raw.inputTokens
        : typeof raw.inputTokens === 'object' && raw.inputTokens !== null
          ? (((raw.inputTokens as Record<string, unknown>).total as number) ?? 0)
          : 0
    const outputTokens =
      typeof raw.outputTokens === 'number'
        ? raw.outputTokens
        : typeof raw.outputTokens === 'object' && raw.outputTokens !== null
          ? (((raw.outputTokens as Record<string, unknown>).total as number) ?? 0)
          : 0
    state.tokenUsage.inputTokens += inputTokens
    state.tokenUsage.outputTokens += outputTokens
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
    state.tokenUsage.currentContextTokens = inputTokens + outputTokens
    if (raw.inputTokens != null) state.lastInputTokens = inputTokens
    callbacks.onUsageUpdate(state.tokenUsage)

    // ── Cache break detection ──
    const turnCacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0
    if (state.expectCacheMiss) {
      state.expectCacheMiss = false
    } else if (state.prevTurnCacheRead > 2000 && turnCacheRead < state.prevTurnCacheRead * 0.5) {
      debugLog(
        'cache-break',
        `Cache read dropped ${state.prevTurnCacheRead} → ${turnCacheRead} (${Math.round((1 - turnCacheRead / state.prevTurnCacheRead) * 100)}% drop). Possible unintended cache invalidation.`,
      )
    }
    state.prevTurnCacheRead = turnCacheRead

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

/** Build the BASE tool set for this loop. "Base" = everything directly loaded
 *  on every turn; the per-turn `composeTurnTools` call then splices in any
 *  deferred tools the model has activated via `toolSearch`.
 *
 *  Two modes:
 *  1. Top-level agent (no toolFilter) — DEFERRED loading. Core tools + the
 *     `toolSearch` entry point are loaded directly; non-core built-ins and ALL
 *     MCP tools are pushed into `state.deferredCatalog` (name-only until the
 *     model loads them). This is the whole point: a few connected MCP servers
 *     no longer cost tens of thousands of tokens of tool schema on every
 *     request.
 *  2. Sub-agent (toolFilter present) — FULL injection, unchanged. Sub-agents
 *     already run a curated, small tool set, so there's no context-bloat
 *     problem to solve and adding a search round-trip would only slow them
 *     down. They never get a deferredCatalog.
 *
 *  Computed once per session — the base set is stable within a session. */
function buildTools(options: AgentOptions, state: LoopState) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = { ...toolRegistry }

  // Override readFile with a cache-backed instance so re-reading an unchanged
  // file returns a stub instead of re-sending its content. Re-assigning an
  // existing key keeps key order stable, so the cached tool-schema prefix
  // stays byte-stable (see cache-control.ts).
  tools.readFile = createReadFileTool(state.readFileCache)

  if (options.subAgentRegistry) {
    tools.task = createTaskTool(options.subAgentRegistry)
  }

  if (options.skillRegistry && options.skillRegistry.names().length > 0) {
    tools.activateSkill = createActivateSkillTool(options.skillRegistry)
  }

  if (!options.toolFilter && state.goal?.status === 'active') {
    tools.getGoal = createGetGoalTool(state)
    tools.updateGoal = createUpdateGoalTool(state)
  }

  // Deferred loading is a top-level-agent feature only. The presence of a
  // toolFilter is the authoritative "this is a sub-agent" signal (runner.ts
  // always passes one; the main loop never does).
  const deferralActive = !options.toolFilter
  if (!deferralActive) {
    state.deferredCatalog = undefined
  }
  if (deferralActive) {
    const catalog = buildDeferredCatalog(options, getContextWindow(options.modelId))
    state.deferredCatalog = catalog

    if (catalog.length > 0) {
      // Deferral enabled: strip non-core built-ins (they're in the catalog)
      // and register toolSearch as the entry point.
      for (const name of DEFERRED_BUILTIN_TOOLS) delete tools[name]
      tools.toolSearch = toolSearch
      return tools
    }

    // Deferral disabled (weak model / below threshold): fall through to the
    // full-injection path below so all MCP tools get loaded directly.
  }

  // ── Sub-agent path: full injection + toolFilter (unchanged behavior) ──
  // MCP tools: declared without `execute` so the AI SDK leaves them in
  // `result.toolCalls` for processToolCalls to hand-dispatch through the
  // permission / loop-guard / abortSignal pipeline.
  if (options.mcpRegistry) {
    // Two universal MCP-aware built-ins. Only registered when MCP is
    // active so a model without any MCP context doesn't see them and
    // start hallucinating resource URIs.
    tools.listMcpResources = listMcpResources
    tools.readMcpResource = readMcpResource
    for (const entry of options.mcpRegistry.list()) {
      tools[entry.callableName] = bridgeMcpTool(entry)
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
  /** Current turn number — diagnostic only, threaded in so the debug log
   *  can tag each finish with which iteration of the outer loop it was. */
  turn: number,
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

  // Collapse stale, fully-superseding tool results (browser snapshots /
  // screenshots) to placeholders before the request is built, so only the
  // latest of each is billed. No-op unless the agent opted in (browser only).
  if (options.collapseStaleToolResults?.length) {
    collapseStaleToolResults(state.messages, options.collapseStaleToolResults)
  }

  // Chat Completions providers keep the tool role text-only and receive raw
  // tool images in one following user message. This also handles images from
  // auto-executed tools such as readFile, which bypass manual tool dispatch.
  const requestMessages = reattachToolResultImagesForProvider(state.messages, options.modelId)

  // Text-only providers (DeepSeek, custom) would 400 on any surviving
  // image/file parts. Rewrite those parts to OCR'd text in-place before
  // the stream starts. Multimodal providers short-circuit inside the
  // helper based on their capability flags.
  await downgradeBinaryPartsForProvider(requestMessages, options.modelId)

  // Per-provider prompt caching: Anthropic gets cache_control breakpoints on
  // the system prompt + last tool + last two messages (4 total, the API
  // maximum); OpenAI and Moonshot get a stable cache key keyed on sessionId;
  // the remaining OpenAI-compatible providers rely on the system-prompt
  // cache in LoopState keeping the prefix byte-stable.
  const cached = applyCacheControl({
    system: systemPrompt,
    messages: requestMessages,
    tools: effectiveTools,
    modelId: options.modelId,
    sessionId: state.sessionId,
  })

  // Extended-thinking / reasoning toggle. The user-facing `/thinking on|off`
  // command (App.tsx) flips `options.thinking`; we translate that flag into
  // the provider-specific switch (Anthropic `thinking`, Google
  // `thinkingConfig`, Alibaba `enableThinking`, etc.) and merge it into the
  // existing per-call providerOptions. Models with no thinking concept
  // Models with no thinking concept get an empty entry — the SDK silently
  // ignores the unrelated keys. Defaults to off when undefined so a stale
  // config without the new field doesn't surprise users with a quality /
  // latency change on launch.
  //
  // Tiered reasoning (via /model tier picker) takes priority over the binary
  // /thinking toggle. If the user explicitly chose a reasoning effort level
  // for this model (stored in config.modelReasoningEffort), we use it
  // regardless of the /thinking state. /thinking only applies as a fallback
  // for models without an explicit tier (including providers whose SDK
  // doesn't expose a granular effort knob — deepseek, moonshot, alibaba,
  // zhipu).
  const config = loadUserConfig()
  const effort = config.modelReasoningEffort?.[options.modelId]
  const thinkingOptions = getThinkingProviderOptions(options.modelId, options.thinking ?? false, effort)
  const mergedProviderOptions = mergeThinkingOptions(cached.providerOptions, thinkingOptions)

  let result: StreamResult
  try {
    result = streamText({
      model,
      system: cached.system,
      messages: cached.messages,
      tools: cached.tools ?? effectiveTools,
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
      // Suppress the SDK's default onError, which is `console.error(error)`
      // and dumps the full RetryError object (stack + nested APICallError
      // array + provider response bodies) via util.inspect to stderr. We
      // already classify and surface a one-line user-friendly message via
      // classifyApiError + callbacks.onError in the try/catch blocks below.
      // The raw dump scares users and isn't actionable. Keep a debug hatch.
      onError: ({ error }) => {
        if (process.env.DEBUG_STDOUT) debugLog('stream.onError', String(error))
      },
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
    await streamChunksToUI(result, callbacks, state)
  } catch (err) {
    // Silently drain all pending AI SDK promises so unhandled-rejection
    // warnings (NoOutputGeneratedError) don't leak to stderr.
    drainStreamResult(result)

    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    if (isContextTooLongError(err)) {
      const compressed = await handleContextTooLong(state, model, callbacks, {
        hookBus: options.hookBus,
        modelId: options.modelId,
        cwd: process.cwd(),
        abortSignal: options.abortSignal,
      })
      // Compression makes its own LLM round-trip (2–5s) and doesn't accept
      // an abort signal. If the user Esc'd while it ran, the next runTurn
      // would issue another streamText only to have the SDK reject it
      // immediately on the now-aborted signal — wasted setup. Bail here.
      if (options.abortSignal?.aborted) return { kind: 'aborted' }
      if (compressed) return { kind: 'retry' }
    }
    callbacks.onError(new Error(classifyApiError(err).message))
    return { kind: 'error' }
  }

  try {
    const finishReason = await collectTurnResponse(result, state, options.modelId, callbacks)
    debugLog(
      'turn.finish',
      `reason=${finishReason} turn=${turn} input=${state.lastInputTokens} total=${state.tokenUsage.totalTokens}`,
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
): Promise<AgentLoopResult> {
  const state = existingState ?? createLoopState(options.permissionMode ?? 'default')

  // ── Plugin hook: SessionStart ──
  // First-invocation-of-the-session marker. Fire-and-forget, but awaited
  // so hooks have a chance to inject session-scoped env / state before
  // SessionStart used to fire here on the first agentLoop call. It now
  // fires from the CLI startup path in packages/cli/src/index.ts so
  // hooks can do session-level setup before the user interacts at all —
  // a session that ends without any user message (e.g. user runs only
  // slash commands, then exits) would otherwise silently skip the event.
  // Sub-agent invocations always pass an existingState so they never
  // triggered this branch anyway; library consumers calling agentLoop
  // directly need to fire SessionStart themselves at session boundaries.

  // ── Plugin hook: UserPromptSubmit ──
  // Runs BEFORE the message is pushed into state.messages so a `deny`
  // decision keeps the transcript clean (no stranded prompt). A
  // `modify` with `context` prepends the injected text into the user
  // message itself rather than as a second user message — back-to-back
  // user messages confuse some providers' tool-call sequencing.
  let effectiveUserMessage = userMessage
  if (options.hookBus?.has('UserPromptSubmit')) {
    const promptText = userContentToText(userMessage)
    try {
      const decisions = await options.hookBus.emit(
        { name: 'UserPromptSubmit', session: { cwd: process.cwd(), modelId: options.modelId }, prompt: promptText },
        { signal: options.abortSignal },
      )
      const effect = aggregateUserPromptSubmit(decisions)
      if (effect.decision === 'deny') {
        const reason = effect.reason ?? 'blocked by plugin hook'
        const notice = `[Prompt blocked by plugin hook: ${reason}]`
        callbacks.onTextDelta(notice)
        // Push BOTH the user's original message and a synthetic assistant
        // response — keeps state.messages valid as alternating user /
        // assistant turns the next submit can build on.
        state.messages.push({ role: 'user', content: userMessage })
        state.messages.push({ role: 'assistant', content: notice })
        return { state, turnCount: 0 }
      }
      if (effect.context) {
        effectiveUserMessage = prependContext(userMessage, effect.context)
      }
    } catch (err) {
      if (options.abortSignal?.aborted) {
        return { state, turnCount: 0 }
      }
      debugLog('agent.hook-user-prompt-error', String(err))
    }
  }

  state.messages.push({ role: 'user', content: effectiveUserMessage })

  // Per-invocation turn counter. Scoped to this single `agentLoop` call
  // — re-entering the function (next user submit) starts at 0 again.
  // This is the structural fix for the "Reached maximum turns" bug
  // that fired on later submits because the counter used to live on
  // `state` and accumulate across the whole CLI session.
  let turn = 0

  // Derive the task slug locally. It is used for plan-file names and
  // retained in session metadata for legacy lookup compatibility.
  //
  // Session naming is local-only metadata and must never delay the first
  // model request. Non-ASCII input can produce an empty slug, in which case
  // session and plan files use their timestamp-only fallback.
  const taskText = userContentToText(userMessage)
  // Strip <activated_skill> XML blocks so the session slug and firstPrompt
  // reflect the user's real intent rather than injected skill content.
  const taskTextForMeta = taskText.replace(/<activated_skill\b[^>]*>[\s\S]*?<\/activated_skill>/gi, '').trim()
  if (!state.taskSlug) state.taskSlug = generateTaskSlug(taskTextForMeta || taskText)

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

  // Write the session header to its timestamp-named jsonl file (idempotent
  // for resumes — the header line already exists in that case and we skip).
  // Awaited so the header is guaranteed on disk before the first
  // flushPendingMessages inside the turn loop below — fire-and-forget
  // creates a race where message lines can land before the header line,
  // breaking loadSession's assumption that the header is always the first
  // entry. appendHeader's I/O is internally catch-safe (appendRawLines
  // swallows FS errors) so this won't throw.
  await appendHeader(state, options.modelId, taskTextForMeta || taskText)

  const compressionThreshold = getCompressionThreshold(options.modelId)

  // Build the BASE tool set once per session (core tools + toolSearch, or the
  // full filtered set for sub-agents). The deferred catalog — when deferral is
  // active — is stashed on `state` here. Each turn, `composeTurnTools` splices
  // in whatever the model has activated via toolSearch so far.
  const baseTools = buildTools(options, state)

  // Auto-continuation on `length` finish. Reasoning models can exhaust the
  // output token budget before the user-visible reply completes — the old
  // behavior was to stop mid-sentence and surface an error, which looks
  // broken to the user. Instead, we push a short "continue" nudge and loop,
  // capped so a pathologically runaway reply still terminates eventually.
  const MAX_CONTINUATIONS = 3
  let continuationAttempts = 0
  // Tracks whether we exited the loop on a clean `stop` finish reason —
  // the only case where the post-turn memory extractor should run.
  let completedNormally = false

  // No `maxTurns` → run until the model says stop or the user aborts.
  // This is the default for interactive mode (and Codex's main loop has
  // no cap at all). `--print` and sub-agents pass a value.
  while (options.maxTurns === undefined || turn < options.maxTurns) {
    turn++

    // Sweep any unpersisted messages from the prior iteration (or the
    // initial user message on iter 1) into the jsonl. Diff-based: only
    // appends `state.messages.slice(persistedMessageCount)`, so it's a
    // no-op when nothing has changed. Must come BEFORE
    // checkAndCompressContext — if compaction fires it rewrites the array
    // in place and writes its own boundary + re-flush, which assumes the
    // pre-compaction tail is already on disk.
    void flushPendingMessages(state)

    await checkAndCompressContext(state, model, compressionThreshold, callbacks, {
      hookBus: options.hookBus,
      modelId: options.modelId,
      cwd: process.cwd(),
      abortSignal: options.abortSignal,
    })

    // ── Rewind checkpoint (first turn only) ──
    // Snapshot the working tree AFTER compaction so that
    // markBoundaryAndReflush (which clears state.checkpoints) can't
    // evict the checkpoint we just created. Skipped for sub-agents.
    if (turn === 1 && options.subAgentRegistry) {
      const promptPreview = userContentToText(effectiveUserMessage).slice(0, 200)
      const ckpt = await createCheckpoint(state, promptPreview)
      if (ckpt) void appendCheckpoint(state, ckpt)
    }

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
      // Names actually going into the system prompt — used to verify that
      // disabled skills are filtered out (registry.list() drops them) and
      // that the names you see match the registry's enabled set. Fires
      // once per session because the prompt is built once and cached.
      if (options.skillRegistry) {
        const enabled = options.skillRegistry.list().map((s) => s.name)
        const disabled = options.skillRegistry
          .listAll()
          .filter((s) => s.disabled)
          .map((s) => s.name)
        debugLog('agent.skills.system-prompt', `enabled=[${enabled.join(',')}] disabled=[${disabled.join(',')}]`)
      }
      state.systemPromptCache = buildSystemPrompt({
        knowledgeContext: fullKnowledgeContext,
        modelId: options.modelId,
        isGitRepo,
        planMode: state.permissionMode === 'plan',
        planFilePath: state.currentPlanPath ?? undefined,
        // When deferral is active (top-level agent), MCP tools + non-core
        // built-ins are in the catalog, listed by NAME under `## Deferred
        // Tools` instead of the old `## MCP Tools` block — the model loads
        // them on demand via toolSearch. The full name list is fixed at boot,
        // so the prompt stays byte-stable for prefix caching.
        //
        // Sub-agents (no catalog) keep the old `## MCP Tools` block. Empty /
        // absent registry → both placeholders resolve to "" and the prompt is
        // byte-identical to the pre-MCP shape.
        deferredTools: state.deferredCatalog?.map((e) => ({
          name: e.name,
          serverName: e.serverName,
          source: e.source,
        })),
        mcpTools: state.deferredCatalog
          ? undefined
          : options.mcpRegistry
            ? toSystemPromptEntries(options.mcpRegistry.list())
            : undefined,
        skills: options.skillRegistry ? options.skillRegistry.list() : undefined,
      })
    }
    const systemPrompt = state.systemPromptCache

    // Splice in any deferred tools the model has loaded via toolSearch. Returns
    // `baseTools` unchanged until the first activation, so sessions that never
    // search keep a byte-stable tools prefix across turns.
    const effectiveTools = composeTurnTools(baseTools, state.deferredCatalog, state.activatedTools)

    const outcome = await runTurn(state, model, options, systemPrompt, callbacks, effectiveTools, turn)

    // ── Plugin hook: TurnComplete ──
    // Fires regardless of finish reason (including error / abort) so
    // notification / audit hooks see every turn, not just clean stops.
    // Parallel + best-effort: hook failures and aborts can't block the
    // outcome dispatch below.
    if (options.hookBus?.has('TurnComplete')) {
      const event: HookEvent = {
        name: 'TurnComplete',
        session: { cwd: process.cwd(), modelId: options.modelId },
        turn,
        tokenUsage: {
          inputTokens: state.tokenUsage.inputTokens,
          outputTokens: state.tokenUsage.outputTokens,
          totalTokens: state.tokenUsage.totalTokens,
        },
      }
      void options.hookBus
        .emit(event, { signal: options.abortSignal })
        .catch((err) => debugLog('agent.hook-turn-complete-error', String(err)))
    }

    if (outcome.kind === 'error') break
    if (outcome.kind === 'aborted') break
    if (outcome.kind === 'retry') {
      // Don't count a failed attempt that got recovered via reactive compaction.
      turn--
      continue
    }

    if (state.goal?.pendingTransition) {
      // updateGoal is auto-executed, so its result is already recorded when
      // runTurn returns. The host goal runner owns the next decision; another
      // inner round would only repeat work before blocker counts can advance.
      debugLog('turn.goal-transition-stop', state.goal.pendingTransition.kind)
      completedNormally = true
      break
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
      // Mid-turn steering: inject user messages queued while this tool
      // batch ran. Safe only here — the batch's tool_results are all
      // recorded, so the merged user message never interleaves with
      // pending tool_result parts (providers reject that ordering).
      drainQueuedInputs(state, options)
      continue
    }

    if (outcome.finishReason === 'length') {
      if (continuationAttempts < MAX_CONTINUATIONS) {
        continuationAttempts++
        debugLog('turn.length-continuation', `attempt=${continuationAttempts}/${MAX_CONTINUATIONS} turn=${turn}`)
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
    } else if (outcome.finishReason === 'stop') {
      // Follow-up: the user queued messages while this turn was streaming.
      // Inject and keep looping instead of returning to the UI — Codex's
      // needs_follow_up equivalent. Messages that land after this drain
      // (sub-millisecond race) stay queued; the UI's idle-drain submits
      // them as a fresh agentLoop call.
      if (drainQueuedInputs(state, options)) {
        continuationAttempts = 0
        continue
      }
      completedNormally = true
    }

    break
  }

  // Only report "max turns reached" when:
  //   1. A cap was actually set (interactive mode has none — there's no
  //      cap to "reach"), AND
  //   2. We hit it, AND
  //   3. The model didn't already finish cleanly on the same turn — the
  //      `!completedNormally` guard handles the boundary where 'stop'
  //      lands exactly on the maxTurns-th turn.
  if (options.maxTurns !== undefined && turn >= options.maxTurns && !completedNormally) {
    callbacks.onError(new Error(`Reached maximum turns (${options.maxTurns}). Stopping agent loop.`))
  }

  // Final flush — catches the last iteration's content when we exit via
  // 'stop'/'error' (the next-iter flush at the top of the loop never
  // runs in those cases). Abort path: useAgent.abort() pushes the
  // `[Request interrupted by user]` notice AFTER agentLoop returns, so
  // it's responsible for its own flush — see use-agent.ts.
  void flushPendingMessages(state)

  // Post-turn memory extractor: runs ONLY on a clean `stop` finish (no
  // error, no abort, no content-filter, no length-cap give-up). Fire-and-
  // forget — the user can type the next prompt immediately while a single
  // generateText + Output.object call scans the transcript for durable
  // knowledge to persist. Writes go directly to AutoMemory (silent path)
  // so the ChatInput frame doesn't render a tool row after the user's
  // reply is already complete.
  if (completedNormally && !options.abortSignal?.aborted) {
    void runMemoryExtractor({
      parentState: state,
      parentModel: model,
      abortSignal: options.abortSignal,
      onWrite: callbacks.onMemoryWrite,
    })
  }

  return { state, turnCount: turn }
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
  // agentLoop's final flush is fire-and-forget and pre-bumps
  // persistedMessageCount so the guard inside flushPendingMessages
  // skips on the next call.  That means the only actual write is the
  // fire-and-forget one — if process.exit() fires before the append
  // lands, the last turn's messages are lost.  Wait for any in-flight
  // flush FIRST, then run our own drain to catch messages that arrived
  // after the pre-bump (rare: goal runner input promotion).
  await (state.pendingFlush ?? Promise.resolve())
  await flushPendingMessages(state)
}
