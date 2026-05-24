// @x-code-cli/core — Tool execution & dispatch
import fs from 'node:fs/promises'
import path from 'node:path'

import type { ModelMessage } from 'ai'

import { aggregatePostToolUse, aggregatePreToolUse } from '../hooks/bus.js'
import { classifyDecision } from '../mcp/permissions.js'
import { checkPermission } from '../permissions/index.js'
import { truncateToolResult } from '../tools/index.js'
import { clearProgressReporter, reportProgress } from '../tools/progress.js'
import { getShellProvider } from '../tools/shell-provider.js'
import type { AgentCallbacks, AgentOptions, LanguageModel } from '../types/index.js'
import { debugLog } from '../utils.js'
import { foldShellErrorNoise } from '../utils/shell-error.js'
import { computeEditDiff } from './diff.js'
import { checkForLoop, recordToolCall } from './loop-guard.js'
import type { LoopState } from './loop-state.js'
import { isToolErrorString, toolErrorFromUnknown, toolErrorString, toolResultMessage } from './messages.js'
import { handleEnterPlanMode, handleExitPlanMode, handleTodoWrite } from './plan-tools.js'
import { runSubAgent } from './sub-agents/runner.js'

/** Detect AbortError from any source. Kept local (duplicates the helper
 *  in loop.ts) because making it a shared utility would force a new
 *  module just for six lines. Same logic both places. */
function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true
    if (/aborted|AbortError/i.test(err.message)) return true
  }
  return false
}

/** Count occurrences of a substring without creating intermediate arrays. */
function countOccurrences(content: string, search: string): number {
  let count = 0
  let pos = 0
  while ((pos = content.indexOf(search, pos)) !== -1) {
    count++
    pos += search.length
  }
  return count
}

/** Execute a write tool (writeFile / edit).
 *
 *  In addition to returning the model-facing result string, fires
 *  `callbacks.onFileEdit` (when defined) with the structured patch so the
 *  UI can render a colored diff under the tool bullet. The diff payload is
 *  a UI-only side channel — it never lands in `state.messages` and the
 *  model only sees the short result string. */
async function executeWriteTool(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
  callbacks: AgentCallbacks,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (toolName === 'writeFile') {
    const filePath = input.filePath as string
    const content = input.content as string
    reportProgress(toolCallId, `Writing ${filePath}`)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    // Read old content BEFORE writing so we can diff. Treat any read
    // failure as "file did not exist" — covers the common ENOENT path
    // plus permission / EISDIR edge cases (we'd error on write anyway).
    let oldContent: string | null = null
    try {
      oldContent = await fs.readFile(filePath, { encoding: 'utf-8', signal })
    } catch {
      oldContent = null
    }
    await fs.writeFile(filePath, content, { encoding: 'utf-8', signal })
    const isNew = oldContent === null
    const parts = content.split('\n')
    const lineCount = content.endsWith('\n') ? parts.length - 1 : parts.length

    const payload = computeEditDiff(filePath, oldContent, content)
    if (payload && callbacks.onFileEdit) callbacks.onFileEdit(toolCallId, payload)

    if (isNew) {
      return `File created: ${filePath} (${lineCount} lines)`
    }
    return `File written: ${filePath} (${lineCount} lines)`
  }

  if (toolName === 'edit') {
    const filePath = input.filePath as string
    const oldString = input.oldString as string
    const newString = input.newString as string
    const replaceAll = (input.replaceAll as boolean) ?? false

    reportProgress(toolCallId, `Editing ${filePath}`)
    const content = await fs.readFile(filePath, { encoding: 'utf-8', signal })
    if (!replaceAll) {
      const count = countOccurrences(content, oldString)
      if (count === 0) return toolErrorString(`old_string not found in ${filePath}`)
      if (count > 1)
        return toolErrorString(
          `old_string is not unique in ${filePath} (found ${count} occurrences). Provide more context or set replaceAll: true.`,
        )
    }

    const newContent = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString)
    await fs.writeFile(filePath, newContent, { encoding: 'utf-8', signal })

    const payload = computeEditDiff(filePath, content, newContent)
    if (payload && callbacks.onFileEdit) callbacks.onFileEdit(toolCallId, payload)

    return `File edited: ${filePath}`
  }

  return toolErrorString('unknown write tool')
}

/** Execute a shell command with streaming. */
async function executeShell(
  command: string,
  timeout: number,
  signal: AbortSignal | undefined,
  callbacks: AgentCallbacks,
  toolCallId: string,
): Promise<{ output: string; isError: boolean }> {
  const proc = getShellProvider().spawn(command, { timeout, signal })

  reportProgress(toolCallId, 'Running command...')

  // Throttle the live progress message to at most one update per 50ms.
  // Why: PowerShell `Format-Table` and similar table-rendering commands
  // emit many lines in a single ~1ms burst, each as its own `data` event
  // here. Without throttling we'd fire reportProgress 5-10× per millisec,
  // each one becoming a setState → ChatInput render → deferred stdout
  // write. The deferred queue absorbs most of the burst into one frame,
  // but if the deferred-fire timer happens to land ~1ms before the
  // tool-result commit arrives, the user sees a visible "progress text
  // flashes, then result block scrolls in" pair. Throttling at the
  // source cuts the storm to ≤20 updates/sec — fast enough to feel
  // live, slow enough to dramatically reduce the chance that any
  // deferred-fire collides with the upcoming tool-result commit.
  // The model still sees full output via the `result` field; this only
  // throttles the live progress display, not what reaches the LLM.
  let lastProgressTime = 0
  const PROGRESS_THROTTLE_MS = 50

  const onChunk = (chunk: Buffer) => {
    const s = chunk.toString()
    callbacks.onShellOutput(s)
    const now = Date.now()
    if (now - lastProgressTime < PROGRESS_THROTTLE_MS) return
    // Take the last non-empty line of the chunk as the progress message.
    // Long-running commands (tsc, test suites) stream many lines; showing
    // the most recent is a natural "what's happening right now" signal.
    const lines = s.split(/\r?\n/).filter((l) => l.trim().length > 0)
    const last = lines[lines.length - 1]
    if (last) {
      lastProgressTime = now
      const trimmed = last.length > 120 ? last.slice(0, 117) + '...' : last
      reportProgress(toolCallId, trimmed)
    }
  }

  proc.stdout?.on('data', onChunk)
  proc.stderr?.on('data', onChunk)

  const result = await proc
  // Fold PowerShell/cmd multi-line error blocks to a single line before they
  // reach the model. A misquoted command on Windows emits 5–10 lines per
  // attempt; across a loop of failed retries those stacks accumulate faster
  // than the actual diagnostic signal. execa's stdout/stderr are typed as
  // `string | unknown[] | Uint8Array` — we spawn with default string mode, so
  // a cast is safe, but keep a defensive fallback for non-string just in case.
  const toStr = (v: unknown): string => (typeof v === 'string' ? v : '')
  let stdout = foldShellErrorNoise(toStr(result.stdout))
  let stderr = foldShellErrorNoise(toStr(result.stderr))

  // When execa kills the child for exceeding maxBuffer, the partial
  // output is still available in stdout/stderr. Surface a clear
  // truncation notice so the model doesn't silently lose context.
  const isMaxBuffer = result.isMaxBuffer ?? false
  if (isMaxBuffer) {
    const INLINE_CAP = 30_000
    if (stdout.length > INLINE_CAP)
      stdout = stdout.slice(0, INLINE_CAP) + '\n... [stdout truncated — exceeded buffer limit]'
    if (stderr.length > INLINE_CAP)
      stderr = stderr.slice(0, INLINE_CAP) + '\n... [stderr truncated — exceeded buffer limit]'
  }

  const output = [stdout, stderr].filter(Boolean).join('\n').trim()
  if (result.exitCode !== 0 || isMaxBuffer) {
    const suffix = isMaxBuffer ? ' (output exceeded buffer limit)' : ''
    const text = output ? `${output}\nExit code ${result.exitCode}${suffix}` : `Exit code ${result.exitCode}${suffix}`
    return { output: text, isError: true }
  }
  return { output: output || 'Done', isError: false }
}

/** Push a tool result to state and notify the UI. */
function pushToolResult(
  state: LoopState,
  callbacks: AgentCallbacks,
  toolCallId: string,
  toolName: string,
  output: string,
  isError = false,
): void {
  state.messages.push(toolResultMessage(toolCallId, toolName, output))
  // Clear the progress reporter for manually-dispatched tools (shell,
  // writeFile, edit, askUser). Auto-executed tools go through the SDK
  // stream's `tool-result` event and are cleared there — this call is
  // a no-op in that case since the reporter would already be gone.
  clearProgressReporter(toolCallId)
  callbacks.onToolResult(toolCallId, output, isError)
}

type ToolCall = { toolName: string; toolCallId: string; input: Record<string, unknown> }

/** Context passed to every per-tool handler — saves us from re-listing
 *  five identical positional params at each call site. */
interface HandlerCtx {
  toolName: string
  input: Record<string, unknown>
  toolCallId: string
  state: LoopState
  options: AgentOptions
  callbacks: AgentCallbacks
  parentModel: LanguageModel
}

/** Wrap pushToolResult with a PostToolUse hook emission. Only the two
 *  "real" success-result call sites use this — error / interrupt /
 *  permission-denial paths still call pushToolResult directly because
 *  emitting PostToolUse on a synthetic deny would be confusing for hook
 *  authors. Bypass handlers (askUser / task / MCP resources) also push
 *  directly today; lifting them to this helper is a follow-up. */
async function pushSuccessfulToolResult(ctx: HandlerCtx, output: string, isError: boolean): Promise<void> {
  let effectiveOutput = output
  if (ctx.options.hookBus?.has('PostToolUse')) {
    try {
      const decisions = await ctx.options.hookBus.emit(
        {
          name: 'PostToolUse',
          session: { cwd: process.cwd(), modelId: ctx.options.modelId },
          tool: { name: ctx.toolName, args: ctx.input, callId: ctx.toolCallId, output, isError },
        },
        { signal: ctx.options.abortSignal },
      )
      const effect = aggregatePostToolUse(decisions)
      if (effect.output !== undefined) effectiveOutput = effect.output
    } catch (err) {
      if (ctx.options.abortSignal?.aborted) return
      debugLog('agent.hook-post-tool-error', String(err))
    }
  }
  pushToolResult(ctx.state, ctx.callbacks, ctx.toolCallId, ctx.toolName, effectiveOutput, isError)
}

type ToolHandler = (ctx: HandlerCtx) => Promise<void>

/** ── askUser ──
 *  Bypasses the loop guard intentionally. The model asking the user the same
 *  clarifying question twice is almost always deliberate (e.g. the user
 *  answered ambiguously); blocking it would silently break the UX. */
async function handleAskUser(ctx: HandlerCtx): Promise<void> {
  const { input, toolCallId, toolName, state, callbacks } = ctx
  const question = input.question as string
  const optionsList = input.options as { label: string; description: string }[]
  const answer = await callbacks.onAskUser(question, optionsList)
  pushToolResult(state, callbacks, toolCallId, toolName, `User answered: ${answer}`)
}

/** ── task (sub-agent dispatch) ── */
async function handleTask(ctx: HandlerCtx): Promise<void> {
  const { input, toolCallId, toolName, state, options, callbacks, parentModel } = ctx
  const agentName = input.subagent_type as string
  const description = input.description as string
  const taskPrompt = input.prompt as string

  reportProgress(toolCallId, `Task: ${description} (${agentName})`)

  const result = await runSubAgent(
    {
      parentState: state,
      parentOptions: options,
      callbacks,
      toolCallId,
      agentName,
      description,
      prompt: taskPrompt,
      knowledgeContext: state.knowledgeContext ?? '',
      isGitRepo: state.isGitRepo ?? false,
    },
    parentModel,
  )

  const statsLine = `<task_stats tool_calls="${result.toolCallCount}" tokens="${result.tokenUsage.totalTokens}" duration_ms="${result.durationMs}" />`
  pushToolResult(state, callbacks, toolCallId, toolName, `${result.resultText}\n${statsLine}`)
}

/** ── listMcpResources ──
 *  Pure read against the in-memory registry; no side effects, no need
 *  for loop-guard or permission. Server filter is optional. */
async function handleListMcpResources(ctx: HandlerCtx): Promise<void> {
  const { input, toolCallId, toolName, state, options, callbacks } = ctx
  const registry = options.mcpRegistry
  if (!registry) {
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('MCP not configured'), true)
    return
  }
  const filter = (input.server as string | undefined)?.trim() || undefined
  const items = registry.listResources().filter((r) => !filter || r.serverName === filter)
  if (items.length === 0) {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      filter ? `No resources on server "${filter}".` : 'No resources from any connected MCP server.',
    )
    return
  }
  const lines = items.map((r) => {
    const mime = r.mimeType ? ` (${r.mimeType})` : ''
    const desc = r.description ? `\n    ${r.description}` : ''
    return `${r.uri}\t[${r.serverName}] ${r.name}${mime}${desc}`
  })
  pushToolResult(state, callbacks, toolCallId, toolName, lines.join('\n'))
}

/** ── readMcpResource ──
 *  Forwards to the owning server's client. Errors / abort handled the
 *  same way as MCP tool calls. */
async function handleReadMcpResource(ctx: HandlerCtx): Promise<void> {
  const { input, toolCallId, toolName, state, options, callbacks } = ctx
  const registry = options.mcpRegistry
  if (!registry) {
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('MCP not configured'), true)
    return
  }
  const uri = (input.uri as string | undefined) ?? ''
  if (!uri) {
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('Missing `uri` argument'), true)
    return
  }
  const client = registry.resourceServer(uri)
  if (!client) {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      toolErrorString(`Resource URI not known: ${uri} — call listMcpResources first`),
      true,
    )
    return
  }
  reportProgress(toolCallId, `Reading ${uri}`)
  try {
    const result = await client.readResource(uri, options.abortSignal)
    pushToolResult(state, callbacks, toolCallId, toolName, truncateToolResult(result.text))
  } catch (err) {
    if (isAbortError(err, options.abortSignal)) {
      pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
      return
    }
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorFromUnknown(err), true)
  }
}

/** Manual tools that bypass the loop guard and the writeFile/edit/shell
 *  permission + execution pipeline below. Each handler owns its own
 *  pushToolResult call. Adding a new bypass tool is a one-line entry here. */
const BYPASS_LOOP_GUARD_HANDLERS: Record<string, ToolHandler> = {
  askUser: handleAskUser,
  task: handleTask,
  todoWrite: ({ input, toolCallId, state, callbacks }) =>
    handleTodoWrite(input, toolCallId, state, callbacks, pushToolResult),
  enterPlanMode: ({ input, toolCallId, state, options, callbacks }) =>
    handleEnterPlanMode(input, toolCallId, state, options, callbacks, pushToolResult),
  exitPlanMode: ({ input, toolCallId, state, callbacks }) =>
    handleExitPlanMode(input, toolCallId, state, callbacks, pushToolResult),
  listMcpResources: handleListMcpResources,
  readMcpResource: handleReadMcpResource,
}

/** Run the loop-guard machinery for a non-bypass tool. Returns true if the
 *  tool was blocked (caller should stop dispatching).
 *
 *  Auto-executed tools never reach this path — `processToolCalls` skips
 *  them earlier because their result is already in `state.messages` from
 *  the SDK's `response.messages`, and re-running the loop-guard here would
 *  push the synthesized result on top of that or inject a mid-iteration
 *  user message that breaks the assistant→tool ordering strict providers
 *  require.
 *
 *  `deferred` collects messages that must land AFTER the iteration's tool
 *  results — pushing them mid-loop creates the
 *  `assistant → tool A → user → tool B` pattern that DeepSeek 400s on. */
async function applyLoopGuard(ctx: HandlerCtx, deferred: ModelMessage[]): Promise<boolean> {
  const { toolName, input, toolCallId, state, callbacks } = ctx
  const loopCheck = checkForLoop(state, toolName, input, toolCallId)

  if (loopCheck.kind === 'ok') {
    recordToolCall(state, toolName, input, loopCheck.hash)
    return false
  }

  recordToolCall(state, toolName, input, loopCheck.hash)
  const guardMessage = `[loop-guard] ${loopCheck.message}`
  // Manual tool — short-circuit by synthesising the result. The tool body
  // never runs; no side effects, no permission prompt.
  pushToolResult(state, callbacks, toolCallId, toolName, guardMessage, true)

  if (loopCheck.kind === 'hard-block') {
    const answer = await callbacks
      .onAskUser(`The model keeps calling ${toolName} with identical arguments. How do you want to proceed?`, [
        { label: 'Pause', description: 'Pause the turn — you can type a new instruction.' },
        { label: 'Continue', description: 'Let the model keep trying; the loop guard stays armed.' },
      ])
      .catch(() => 'Pause')
    if (answer.toLowerCase().startsWith('pause')) {
      // Clear the recent-calls window so the guard doesn't immediately
      // re-trigger on the next turn if the model legitimately retries
      // once with the same args under the user's guidance.
      state.recentToolCalls = []
      // Defer until after the iteration so the user-role message lands at
      // the END of this turn's messages, not between tool results.
      deferred.push({
        role: 'user',
        content: '[loop-guard] User paused the loop. Wait for further instructions rather than calling more tools.',
      })
    }
  }
  return true
}

/** Permission gate for writeFile/edit/shell. Returns true if execution
 *  should continue, false if it was blocked / denied / aborted. */
async function checkWriteOrShellPermission(ctx: HandlerCtx): Promise<boolean> {
  const { toolName, input, toolCallId, state, options, callbacks } = ctx
  if (toolName !== 'writeFile' && toolName !== 'edit' && toolName !== 'shell') return true

  const approved = await checkPermission(
    { toolCallId, toolName, input },
    options.trustMode,
    callbacks.onAskPermission,
    state.permissionMode,
    process.cwd(),
  )
  if (options.abortSignal?.aborted) {
    pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
    return false
  }
  if (!approved) {
    pushToolResult(state, callbacks, toolCallId, toolName, 'Permission denied by user.')
    return false
  }
  return true
}

/** Run the underlying side-effecting tool body for writeFile/edit/shell.
 *  Auto-executed tools return early because the AI SDK has already produced
 *  their result. Returns the post-execution { output, isError } pair, or
 *  null when there's nothing to push (auto-executed). */
async function executeWriteOrShell(ctx: HandlerCtx): Promise<{ output: string; isError: boolean } | null> {
  const { toolName, input, toolCallId, state, options, callbacks } = ctx
  try {
    if (toolName === 'writeFile' || toolName === 'edit') {
      const output = await executeWriteTool(toolName, input, toolCallId, callbacks, options.abortSignal)
      // executeWriteTool returns "Error: ..." strings for in-band failures
      // (missing match, non-unique match) rather than throwing — surface
      // those as errored results so the scrollback line flips to red.
      const isError = isToolErrorString(output)
      if (!isError) state.filesModified.add(input.filePath as string)
      return { output, isError }
    }
    if (toolName === 'shell') {
      const timeout = (input.timeout as number) ?? 30000
      const shellResult = await executeShell(
        input.command as string,
        timeout,
        options.abortSignal,
        callbacks,
        toolCallId,
      )
      return { output: shellResult.output, isError: shellResult.isError }
    }
    // Tools with execute (readFile, glob, grep, etc.) are auto-executed by AI SDK
    return null
  } catch (err) {
    return { output: toolErrorFromUnknown(err), isError: true }
  }
}

/** Handle a single tool call. Returns when the call has been fully dispatched.
 *  `parentModel` is the LanguageModel instance for the current loop — needed
 *  by the task tool to pass as fallback when the sub-agent doesn't override.
 *  `deferred` is the per-turn deferred-message queue threaded down to
 *  `applyLoopGuard`; messages collected here are flushed after the entire
 *  iteration in `processToolCalls`. */
async function handleToolCall(
  tc: ToolCall,
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  parentModel: LanguageModel,
  deferred: ModelMessage[],
): Promise<void> {
  const ctx: HandlerCtx = {
    toolName: tc.toolName,
    input: tc.input,
    toolCallId: tc.toolCallId,
    state,
    options,
    callbacks,
    parentModel,
  }

  // ── Plugin hook: PreToolUse ──
  // Fires before bypass-handler routing and before MCP dispatch so the
  // hook sees EVERY tool the model attempts (including askUser, task,
  // and MCP tools). A deny becomes a synthetic tool_result the model
  // sees, keeping state.messages valid. A modify can rewrite the input
  // record (mutated in-place on ctx.input so downstream handlers and
  // the loop guard see the post-modification args).
  if (ctx.options.hookBus?.has('PreToolUse')) {
    try {
      const decisions = await ctx.options.hookBus.emit(
        {
          name: 'PreToolUse',
          session: { cwd: process.cwd(), modelId: ctx.options.modelId },
          tool: { name: ctx.toolName, args: ctx.input, callId: ctx.toolCallId },
        },
        { signal: ctx.options.abortSignal },
      )
      const effect = aggregatePreToolUse(decisions)
      if (effect.decision === 'deny') {
        const reason = effect.reason ?? 'blocked by plugin hook'
        pushToolResult(
          state,
          callbacks,
          ctx.toolCallId,
          ctx.toolName,
          toolErrorString(`Tool denied by plugin hook: ${reason}`),
          true,
        )
        return
      }
      if (effect.args && typeof effect.args === 'object' && !Array.isArray(effect.args)) {
        ctx.input = effect.args as Record<string, unknown>
      }
    } catch (err) {
      if (ctx.options.abortSignal?.aborted) return
      debugLog('agent.hook-pre-tool-error', String(err))
    }
  }

  const bypassHandler = BYPASS_LOOP_GUARD_HANDLERS[ctx.toolName]
  if (bypassHandler) {
    await bypassHandler(ctx)
    return
  }

  // MCP tools route through their own permission path (per-tool ask +
  // always-allow file) rather than the writeFile/edit/shell rules. They
  // still go through the loop-guard so the model can't spin on a
  // failing MCP call indefinitely.
  //
  // Routing is by registry lookup, not name pattern: MCP tool names are
  // `<server>__<tool>` (no special prefix), so the only authoritative
  // "is this MCP?" answer is "is it registered with the MCP registry?".
  if (ctx.options.mcpRegistry?.get(ctx.toolName)) {
    await handleMcpToolCall(ctx, deferred)
    return
  }

  if (await applyLoopGuard(ctx, deferred)) return
  if (!(await checkWriteOrShellPermission(ctx))) return

  const result = await executeWriteOrShell(ctx)
  if (result == null) return

  await pushSuccessfulToolResult(ctx, truncateToolResult(result.output), result.isError)
}

/** Dispatch an MCP tool call. Sits parallel to the writeFile/edit/shell
 *  pipeline above — same loop-guard, same abort handling, but using the
 *  per-tool permission store and the MCP registry's callTool. */
async function handleMcpToolCall(ctx: HandlerCtx, deferred: ModelMessage[]): Promise<void> {
  const { toolName, input, toolCallId, state, options, callbacks } = ctx
  const registry = options.mcpRegistry
  const permissions = options.mcpPermissionStore

  if (!registry) {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      toolErrorString(`MCP not configured; tool ${toolName} unavailable`),
      true,
    )
    return
  }

  const entry = registry.get(toolName)
  if (!entry) {
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString(`MCP tool not found: ${toolName}`), true)
    return
  }

  // Loop-guard FIRST: even denied-by-mode calls count as the model
  // "attempting" something, and we want to catch a loop of denials too.
  if (await applyLoopGuard(ctx, deferred)) return

  // Plan mode: MCP tools are opaque (we don't know if they write or
  // not), so the only safe stance is "no". The model will see the
  // denial as a tool result and should call exitPlanMode if it really
  // needs external tools to proceed.
  if (state.permissionMode === 'plan') {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      'MCP tools are disabled in plan mode. Call exitPlanMode first if you need this tool.',
      true,
    )
    return
  }

  // Permission gate. trustMode bypasses everything; otherwise consult
  // the store (session + persisted), and fall back to asking the user.
  let approved = options.trustMode
  if (!approved && permissions) approved = await permissions.isApproved(toolName)

  if (!approved) {
    let decision: 'yes' | 'always' | 'no'
    try {
      decision = await callbacks.onAskPermission({ toolCallId, toolName, input })
    } catch (err) {
      if (isAbortError(err, options.abortSignal)) {
        pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
        return
      }
      throw err
    }
    if (options.abortSignal?.aborted) {
      pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
      return
    }
    const choice = classifyDecision(decision)
    if (choice === 'deny') {
      pushToolResult(state, callbacks, toolCallId, toolName, 'Permission denied by user.')
      return
    }
    if (permissions) {
      if (choice === 'allow-always') await permissions.approvePermanently(toolName)
      else permissions.approveForSession(toolName)
    }
  }

  // Execute. abortSignal threaded all the way down to the SDK request
  // so Esc immediately cancels in-flight MCP calls.
  reportProgress(toolCallId, `Calling ${entry.serverName}/${entry.rawName}`)
  try {
    const result = await registry.callTool(toolName, ctx.input, options.abortSignal)
    await pushSuccessfulToolResult(ctx, truncateToolResult(result.text), result.isError)
  } catch (err) {
    if (isAbortError(err, options.abortSignal)) {
      pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
      return
    }
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorFromUnknown(err), true)
  }
}

/** Collect every toolCallId the AI SDK actually committed to the
 *  assistant message in this turn. The SDK's `result.toolCalls` promise
 *  is independent of `response.messages` — when zod validation rejects
 *  a malformed tool input mid-stream the SDK emits a `tool-error` chunk
 *  and excludes that tool_call from response.messages, but it can still
 *  surface in `toolCalls`. Running such a "ghost" call would have two
 *  bad outcomes:
 *    1. write/edit/shell would fire a real side effect for a call the
 *       model never officially committed to.
 *    2. The pushed tool_result would be an orphan in state.messages
 *       (no preceding assistant tool_call with that id) and the next
 *       API request would 400 with "tool must be a response to a
 *       preceding message with tool_calls".
 *  Returning the set lets `processToolCalls` filter the SDK's list
 *  before any handler runs.
 *
 *  Walks from the END of state.messages backwards, collecting tool-call
 *  ids from EVERY assistant message we encounter until we hit a
 *  non-assistant/tool boundary — covers multi-assistant turn structures
 *  some providers produce while still cutting off at the previous user
 *  message so old turns' ids don't bleed in. */
function collectActiveAssistantToolCallIds(state: LoopState): Set<string> {
  const ids = new Set<string>()
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i]
    if (!msg) continue
    if (msg.role === 'user') break
    if (msg.role !== 'assistant') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-call' && typeof part.toolCallId === 'string') {
        ids.add(part.toolCallId)
      }
    }
  }
  return ids
}

/** Collect tool_call_ids that ALREADY have a tool-result message in the
 *  current turn's window of state.messages. Two distinct upstream paths
 *  drop a result here before `processToolCalls` runs:
 *    1. AI SDK auto-executed tools (readFile / glob / grep / listDir /
 *       webFetch / webSearch) — their result is in `response.messages`
 *       and gets pushed by `collectTurnResponse` before we iterate.
 *    2. AI SDK auto-rejection of an unavailable tool — when a sub-agent's
 *       toolFilter excludes a tool the model still emits a tool-call for
 *       (e.g. `general-purpose` agent calling `writeFile`), the SDK
 *       synthesizes an `error-text` tool-result so the assistant message
 *       isn't left with an orphan tool-call.
 *  In both cases re-running the tool here is wrong:
 *    - For (1) the tool already executed; another run would duplicate
 *      side effects (re-fetch a webpage, re-trigger a saveKnowledge).
 *    - For (2) the tool isn't supposed to run at all in this agent's
 *      filter, but `executeWriteTool` dispatches by name and would
 *      happily fire writeFile, creating a real side effect AND pushing
 *      a duplicate tool-result that DeepSeek 400s on next turn.
 *  Same turn-boundary logic as collectActiveAssistantToolCallIds —
 *  walk back from end-of-messages, stop at the first user message. */
function collectFulfilledToolCallIds(state: LoopState): Set<string> {
  const ids = new Set<string>()
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i]
    if (!msg) continue
    if (msg.role === 'user') break
    if (msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        ids.add(part.toolCallId)
      }
    }
  }
  return ids
}

/** Group consecutive `task` tool-calls into a single batch so they can be
 *  dispatched in parallel; everything else gets a singleton batch and
 *  dispatches one-at-a-time. Sub-agents launched by the `task` tool are
 *  the only manual tool we hand-execute in `processToolCalls` that's
 *  truly isolated:
 *    - each `runSubAgent` builds a fresh `LoopState` (own messages, own
 *      `recentToolCalls`, own todos, own permission mode)
 *    - `parentState.tokenUsage` is updated by additive accumulation only
 *      after the sub-agent completes, so concurrent updates can't get
 *      torn (single-threaded event loop + plain `+=` writes)
 *    - permission dialogs from concurrent sub-agents queue naturally on
 *      the parent UI's `permissionResolversRef`
 *  Every other manual tool mutates shared state and must stay serial:
 *    - `writeFile` / `edit` mutate the filesystem and `state.filesModified`
 *    - `shell` streams stdout/stderr to the parent UI as it arrives —
 *      interleaved bytes from concurrent shells would scramble the live
 *      indicator
 *    - `askUser` / permission dialogs hold the UI; running two at once
 *      would race the dialog state machine
 *    - `todoWrite` / `enterPlanMode` / `exitPlanMode` mutate `LoopState`
 *      fields that the next turn reads
 *  Auto-executed tools (readFile / glob / grep / listDir / webFetch /
 *  webSearch) don't appear here — by the time `processToolCalls` runs,
 *  the SDK has already executed them and the skip-fulfilled pre-pass
 *  short-circuits them out. */
export function partitionToolCalls(calls: ToolCall[]): ToolCall[][] {
  const batches: ToolCall[][] = []
  let i = 0
  while (i < calls.length) {
    let end = i + 1
    if (calls[i]!.toolName === 'task') {
      while (end < calls.length && calls[end]!.toolName === 'task') {
        end++
      }
    }
    batches.push(calls.slice(i, end))
    i = end
  }
  return batches
}

/** Handle all tool calls from a single model turn.
 *
 *  Consecutive `task` tool-calls dispatch in parallel via Promise.all;
 *  every other tool runs one at a time. See `partitionToolCalls` for the
 *  full rationale on why only sub-agents are safe to fan out.
 *
 *  `parentModel` is threaded through so the task tool can pass it to
 *  `runSubAgent`. */
export async function processToolCalls(
  toolCalls: ToolCall[],
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  parentModel: LanguageModel,
): Promise<void> {
  const activeIds = collectActiveAssistantToolCallIds(state)
  const fulfilledIds = collectFulfilledToolCallIds(state)
  // Per-turn queue for messages that must land AFTER every tool-result
  // we push in this loop. Pushing a `role: 'user'` message between two
  // tool-results creates the shape that DeepSeek's strict ordering
  // rejects — we collect them here and flush at the end of the loop.
  const deferred: ModelMessage[] = []

  // Pre-pass: drop ghost calls and account for already-fulfilled calls.
  // What survives goes into `liveCalls` which is what we actually
  // dispatch. Doing this BEFORE partitioning keeps the parallel-batch
  // dispatch simple — every entry in the batch is a real call we need
  // to run.
  const liveCalls: ToolCall[] = []
  for (const tc of toolCalls) {
    // Skip ghost calls the SDK rejected mid-stream — see
    // collectActiveAssistantToolCallIds for the full rationale. Don't
    // pushToolResult either: the assistant message has no matching
    // tool_call, so any result we emit would be an orphan that the
    // sanitizer drops next turn anyway. Belt-and-suspenders: the
    // sanitizer's reverse-orphan branch would still clean up if this
    // check ever lets one through.
    if (activeIds.size > 0 && !activeIds.has(tc.toolCallId)) {
      debugLog(
        'tool-exec.skip-ghost',
        `${tc.toolName} ${tc.toolCallId} — not in assistant tool_calls, likely SDK tool-error reject`,
      )
      continue
    }

    // Skip already-fulfilled calls — see collectFulfilledToolCallIds.
    // Still record the call in the loop-guard window so a runaway
    // pattern on the same auto-executed tool can be circuit-broken on
    // a future turn; if the guard fires, defer the user-role nudge
    // until after iteration.
    if (fulfilledIds.has(tc.toolCallId)) {
      debugLog('tool-exec.skip-fulfilled', `${tc.toolName} ${tc.toolCallId} — tool-result already in state.messages`)
      const loopCheck = checkForLoop(state, tc.toolName, tc.input, tc.toolCallId)
      recordToolCall(state, tc.toolName, tc.input, loopCheck.hash)
      if (loopCheck.kind !== 'ok') {
        deferred.push({ role: 'user', content: `[loop-guard] ${loopCheck.message}` })
      }
      continue
    }

    liveCalls.push(tc)
  }

  // Dispatch in batches. A batch of size 1 is functionally identical to
  // a plain `await handleToolCall(...)` — Promise.all over a single
  // promise resolves the same way — so the parallel path uniformly
  // handles both cases.
  const batches = partitionToolCalls(liveCalls)
  let dispatched = 0
  for (const batch of batches) {
    // User pressed Esc / Ctrl+C. The currently running tool (if any) has
    // already been SIGKILL'd via the shell provider's cancelSignal. For
    // every remaining tool_call we still need to push a synthetic
    // tool_result — orphan tool_calls without a matching result would
    // make the next API request fail with "tool_use without tool_result"
    // the moment the user types another prompt.
    if (options.abortSignal?.aborted) {
      for (let j = dispatched; j < liveCalls.length; j++) {
        pushToolResult(
          state,
          callbacks,
          liveCalls[j]!.toolCallId,
          liveCalls[j]!.toolName,
          '[Tool execution interrupted by user]',
          true,
        )
      }
      break
    }

    await Promise.all(batch.map((tc) => handleToolCall(tc, state, options, callbacks, parentModel, deferred)))
    dispatched += batch.length
  }

  // Flush deferred messages AFTER all tool_results in this turn — they
  // sit at the very end of state.messages, where the next runTurn sees
  // them as the most recent context but they don't break the
  // assistant→tool ordering the SDK will replay to the provider.
  if (deferred.length > 0) state.messages.push(...deferred)
}
