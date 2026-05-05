// @x-code-cli/core — Tool execution & dispatch
import fs from 'node:fs/promises'
import path from 'node:path'

import { checkPermission } from '../permissions/index.js'
import { truncateToolResult } from '../tools/index.js'
import { clearProgressReporter, reportProgress } from '../tools/progress.js'
import { getShellProvider } from '../tools/shell-provider.js'
import type { AgentCallbacks, AgentOptions, LanguageModel } from '../types/index.js'
import { debugLog } from '../utils.js'
import { foldShellErrorNoise } from '../utils/shell-error.js'
import { computeEditDiff, formatDiffForModel } from './diff.js'
import { checkForLoop, recordToolCall } from './loop-guard.js'
import type { LoopState } from './loop-state.js'
import { isToolErrorString, toolErrorFromUnknown, toolErrorString, toolResultMessage } from './messages.js'
import { handleEnterPlanMode, handleExitPlanMode, handleTodoWrite } from './plan-tools.js'
import { runSubAgent } from './sub-agents/runner.js'

/** Parse a positive integer from an env var, falling back when unset,
 *  empty, NaN, or non-positive. Used for XC_BASH_TIMEOUT_MS overrides. */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n
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

/** Replace common Unicode "fancy" punctuation with their ASCII equivalents.
 *  Models routinely paste straight quotes / regular hyphens when the actual
 *  file uses curly quotes, en/em dashes, or NBSPs — string-equality fails
 *  silently. CC normalizes both sides through the same map (DESANITIZATIONS
 *  in their FileEditTool/utils.ts) and finds the match anyway. We do the
 *  same as a FALLBACK only — if the literal match worked, never normalize. */
const QUOTE_NORMALIZE_MAP: Array<[RegExp, string]> = [
  [/[‘’‚‛]/g, "'"], // left/right single, low/high single
  [/[“”„‟]/g, '"'], // left/right double, low/high double
  [/[–—]/g, '-'], // en dash, em dash
  [/ /g, ' '], // non-breaking space
  [/​/g, ''], // zero-width space (silent killer)
  [/…/g, '...'], // horizontal ellipsis
]

function normalizeQuotes(s: string): string {
  let out = s
  for (const [re, sub] of QUOTE_NORMALIZE_MAP) out = out.replace(re, sub)
  return out
}

/** Build a model-friendly error message for a failed string match. Tries
 *  three remediations in order:
 *
 *  1. Quote-normalized match: if the file's content normalized matches the
 *     model's normalized oldString, tell the model the file uses fancy
 *     punctuation it didn't include — cheap fix, no re-read needed.
 *  2. First-line probe: if the model's oldString starts with a line that
 *     DOES appear in the file, point at where it appears. Often the model
 *     missed a trailing whitespace or copied a stale line continuation.
 *  3. Fallback: just say "not found".
 *
 *  Mirrors CC's findActualString + DESANITIZATIONS approach — saves a
 *  ~3-round round-trip when the model would otherwise re-read the file
 *  to figure out what shape the content is actually in. */
function buildOldStringNotFoundError(filePath: string, content: string, oldString: string): string {
  const normalizedFile = normalizeQuotes(content)
  const normalizedNeedle = normalizeQuotes(oldString)
  // Hint applies whenever normalization made the difference — either the
  // file had fancy chars and the needle didn't, or vice versa. The
  // simple "needle changed" check misses the more common case (file
  // contains curly quotes the model didn't include).
  const normalizationHelped = normalizedFile !== content || normalizedNeedle !== oldString
  if (normalizationHelped && normalizedFile.includes(normalizedNeedle)) {
    return toolErrorString(
      `old_string not found in ${filePath}, but a quote-normalized match exists. ` +
        `The file likely uses curly quotes / en-dash / em-dash / NBSP / zero-width characters where you used the ASCII equivalent. ` +
        `Re-read the file in the affected region and copy the exact bytes (including punctuation) into oldString.`,
    )
  }
  // First-line probe — useful when the model copied a long block but the
  // first line is intact. Empty oldString shouldn't reach here (handled
  // earlier), but guard anyway.
  const firstLine = oldString.split('\n')[0]?.trim()
  if (firstLine && firstLine.length >= 6 && content.includes(firstLine)) {
    return toolErrorString(
      `old_string not found in ${filePath}. The first line ("${firstLine.slice(0, 80)}") DOES appear in the file, ` +
        `so the mismatch is in the trailing lines — check trailing whitespace, line endings, or content drift between your assumption and the actual file. ` +
        `Re-read the file in that region.`,
    )
  }
  return toolErrorString(`old_string not found in ${filePath}`)
}

/** Verify the model has read this file (in full) recently and that the
 *  file's mtime hasn't changed since. Returns null on success, or an
 *  error string suitable for use as the tool result on failure.
 *
 *  Two gates:
 *
 *  1. **Must read first** (matches CC FileEditTool's `validateInput`).
 *     The model must have called readFile on this exact path in this
 *     session, with NO offset/limit (a partial view doesn't qualify —
 *     the model could clobber content it never saw). Without the gate,
 *     a model can blind-edit a file it never opened, acting on stale
 *     assumptions from training data or another file.
 *
 *  2. **No external modification since read** (matches CC's
 *     FILE_UNEXPECTEDLY_MODIFIED_ERROR). If the file's mtime changed
 *     since the recorded read, refuse and ask the model to re-read.
 *     Catches the common case of the user editing the same file in
 *     their IDE while the agent is mid-task — without the check, the
 *     agent's read-modify-write quietly overwrites the user's edits.
 *
 *  `isCreatingNew` short-circuits both checks for writeFile when the
 *  target doesn't exist on disk (creating a fresh file — nothing to
 *  read first, no mtime to compare). */
async function checkFileReadGate(
  toolName: string,
  filePath: string,
  state: LoopState,
  isCreatingNew: boolean,
): Promise<string | null> {
  if (isCreatingNew) return null

  const known = state.readFiles.get(filePath)
  if (!known) {
    return toolErrorString(
      `Cannot ${toolName} ${filePath}: this file has not been read in the current session. Call readFile on it first so you're working from the actual current contents, not assumptions.`,
    )
  }
  if (known.isPartialView) {
    return toolErrorString(
      `Cannot ${toolName} ${filePath}: only a partial view was read (offset/limit was used, or the file was head-truncated). Read the full file (or at least the surrounding region you intend to modify) before editing.`,
    )
  }
  // Fresh stat — detect external modifications between read and write.
  // If stat fails the file may have been deleted; let the actual write
  // path produce the canonical error rather than fabricating one here.
  try {
    const stat = await fs.stat(filePath)
    const currentMtime = Math.floor(stat.mtimeMs)
    if (currentMtime !== known.timestamp) {
      return toolErrorString(
        `Cannot ${toolName} ${filePath}: the file was modified externally since you last read it (mtime changed from ${known.timestamp} to ${currentMtime}). Re-read it before editing so you don't overwrite the external changes.`,
      )
    }
  } catch {
    // stat failed — defer to write path's error
  }
  return null
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
  state: LoopState,
  callbacks: AgentCallbacks,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (toolName === 'writeFile') {
    const filePath = input.filePath as string
    const content = input.content as string
    reportProgress(toolCallId, `Writing ${filePath}`)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    // Probe existence before the gate so we know whether to enforce
    // "must read first". A genuine create has nothing to read.
    let exists = true
    try {
      await fs.stat(filePath)
    } catch {
      exists = false
    }
    const gateError = await checkFileReadGate('writeFile', filePath, state, !exists)
    if (gateError) return gateError
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
    // Refresh the read state with the post-write mtime so the model can
    // immediately edit the file again without tripping the mtime gate
    // on its own write. Treat the write itself as a "full read".
    try {
      const newStat = await fs.stat(filePath)
      state.readFiles.set(filePath, { timestamp: Math.floor(newStat.mtimeMs), isPartialView: false })
    } catch {
      // ignore — next read will repopulate
    }
    const isNew = oldContent === null
    const parts = content.split('\n')
    const lineCount = content.endsWith('\n') ? parts.length - 1 : parts.length

    const payload = computeEditDiff(filePath, oldContent, content)
    if (payload && callbacks.onFileEdit) callbacks.onFileEdit(toolCallId, payload)

    // Append a brief diff snippet for the model so it doesn't need to
    // re-read the file to know what actually changed (especially for
    // multi-step refactors where it's about to edit the same file
    // again). The UI gets the full structured payload via onFileEdit;
    // this is only what enters state.messages.
    const modelDiff = formatDiffForModel(payload)
    const diffSuffix = modelDiff ? `\n${modelDiff}` : ''

    if (isNew) {
      return `File created: ${filePath} (${lineCount} lines)${diffSuffix}`
    }
    return `File written: ${filePath} (${lineCount} lines)${diffSuffix}`
  }

  if (toolName === 'edit') {
    const filePath = input.filePath as string
    const oldString = input.oldString as string
    const newString = input.newString as string
    const replaceAll = (input.replaceAll as boolean) ?? false

    reportProgress(toolCallId, `Editing ${filePath}`)
    const gateError = await checkFileReadGate('edit', filePath, state, false)
    if (gateError) return gateError
    const content = await fs.readFile(filePath, { encoding: 'utf-8', signal })
    if (!replaceAll) {
      const count = countOccurrences(content, oldString)
      if (count === 0) return buildOldStringNotFoundError(filePath, content, oldString)
      if (count > 1)
        return toolErrorString(
          `old_string is not unique in ${filePath} (found ${count} occurrences). Provide more context or set replaceAll: true.`,
        )
    }

    const newContent = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString)
    await fs.writeFile(filePath, newContent, { encoding: 'utf-8', signal })
    // Refresh read state with the post-edit mtime so the model can chain
    // a second edit on the same file without the mtime gate firing.
    try {
      const newStat = await fs.stat(filePath)
      state.readFiles.set(filePath, { timestamp: Math.floor(newStat.mtimeMs), isPartialView: false })
    } catch {
      // ignore — next read will repopulate
    }

    const payload = computeEditDiff(filePath, content, newContent)
    if (payload && callbacks.onFileEdit) callbacks.onFileEdit(toolCallId, payload)

    const modelDiff = formatDiffForModel(payload)
    return modelDiff ? `File edited: ${filePath}\n${modelDiff}` : `File edited: ${filePath}`
  }

  return toolErrorString('unknown write tool')
}

/** Execute a shell command with streaming. Persists the post-command cwd
 *  back into LoopState so the NEXT shell call honors any `cd` issued by
 *  this one — without that the shell tool description's promise that
 *  cwd persists would be a lie (every spawn would start at process.cwd()). */
async function executeShell(
  command: string,
  timeout: number,
  signal: AbortSignal | undefined,
  state: LoopState,
  callbacks: AgentCallbacks,
  toolCallId: string,
): Promise<{ output: string; isError: boolean }> {
  const cwd = state.shellCwd ?? process.cwd()
  const { proc, readCwd } = getShellProvider().spawn(command, { timeout, signal, cwd })

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

  // Persist the post-command cwd. readCwd cleans up the temp file
  // unconditionally; null means capture failed (child died before
  // writing, captured path no longer exists, etc.) and we leave the
  // previous cwd untouched.
  const newCwd = await readCwd()
  if (newCwd) state.shellCwd = newCwd
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

/** Tools whose execution is driven by the AI SDK (they have an `execute` on
 *  the tool definition). By the time we see them in `processToolCalls`, the
 *  tool has already run and its result is already in `state.messages`. We
 *  can't pre-block these — only record for loop detection and annotate. */
const AUTO_EXECUTED_TOOLS = new Set(['readFile', 'glob', 'grep', 'listDir', 'webFetch', 'webSearch', 'saveKnowledge'])

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
}

/** Run the loop-guard machinery for a non-bypass tool. Returns true if the
 *  tool was blocked (caller should stop dispatching). */
async function applyLoopGuard(ctx: HandlerCtx): Promise<boolean> {
  const { toolName, input, toolCallId, state, callbacks } = ctx
  const isAutoExecuted = AUTO_EXECUTED_TOOLS.has(toolName)
  const loopCheck = checkForLoop(state, toolName, input, toolCallId)

  if (loopCheck.kind === 'ok') {
    recordToolCall(state, toolName, input, loopCheck.hash)
    return false
  }

  recordToolCall(state, toolName, input, loopCheck.hash)
  const guardMessage = `[loop-guard] ${loopCheck.message}`

  if (isAutoExecuted) {
    // The tool result already exists in state.messages. Append a follow-up
    // user-role notice so the model's next step has explicit context that
    // this path is spinning — without this nudge, some models keep trying.
    state.messages.push({ role: 'user', content: guardMessage })
    callbacks.onToolResult(toolCallId, guardMessage, true)
  } else {
    // Manual tool — short-circuit by synthesising the result. The tool body
    // never runs; no side effects, no permission prompt.
    pushToolResult(state, callbacks, toolCallId, toolName, guardMessage, true)
  }

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
      state.messages.push({
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
      const output = await executeWriteTool(toolName, input, toolCallId, state, callbacks, options.abortSignal)
      // executeWriteTool returns "Error: ..." strings for in-band failures
      // (missing match, non-unique match) rather than throwing — surface
      // those as errored results so the scrollback line flips to red.
      const isError = isToolErrorString(output)
      if (!isError) state.filesModified.add(input.filePath as string)
      return { output, isError }
    }
    if (toolName === 'shell') {
      // Default 120 s (matches Claude Code's BASH_DEFAULT_TIMEOUT_MS), max
      // 600 s. Env-overridable for users on slow networks / hardware. The
      // previous 30 s default was too low for almost everything that
      // actually matters: pnpm install, cargo build, tsc -b on a large
      // repo, integration test suites — every one of those would SIGTERM
      // out and trigger model-side retry guesswork.
      const defaultTimeout = parsePositiveInt(process.env.XC_BASH_TIMEOUT_MS, 120_000)
      const maxTimeout = parsePositiveInt(process.env.XC_BASH_MAX_TIMEOUT_MS, 600_000)
      const requested = (input.timeout as number) ?? defaultTimeout
      const timeout = Math.min(requested, maxTimeout)
      const shellResult = await executeShell(
        input.command as string,
        timeout,
        options.abortSignal,
        state,
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
 *  by the task tool to pass as fallback when the sub-agent doesn't override. */
async function handleToolCall(
  tc: ToolCall,
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  parentModel: LanguageModel,
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

  const bypassHandler = BYPASS_LOOP_GUARD_HANDLERS[ctx.toolName]
  if (bypassHandler) {
    await bypassHandler(ctx)
    return
  }

  if (await applyLoopGuard(ctx)) return
  if (!(await checkWriteOrShellPermission(ctx))) return

  const result = await executeWriteOrShell(ctx)
  if (result == null) return

  pushToolResult(state, callbacks, ctx.toolCallId, ctx.toolName, truncateToolResult(result.output), result.isError)
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

/** Handle all tool calls from a single model turn, sequentially.
 *  `parentModel` is threaded through so the task tool can pass it to runSubAgent. */
export async function processToolCalls(
  toolCalls: ToolCall[],
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  parentModel: LanguageModel,
): Promise<void> {
  const activeIds = collectActiveAssistantToolCallIds(state)

  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i]!
    // User pressed Esc / Ctrl+C. The currently running tool (if any) has
    // already been SIGKILL'd via the shell provider's cancelSignal. For
    // every remaining tool_call from this turn we still need to push a
    // synthetic tool_result — orphan tool_calls without a matching result
    // would make the next API request fail with "tool_use without
    // tool_result" the moment the user types another prompt.
    if (options.abortSignal?.aborted) {
      for (let j = i; j < toolCalls.length; j++) {
        const skipped = toolCalls[j]!
        pushToolResult(
          state,
          callbacks,
          skipped.toolCallId,
          skipped.toolName,
          '[Tool execution interrupted by user]',
          true,
        )
      }
      return
    }

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

    await handleToolCall(tc, state, options, callbacks, parentModel)
  }
}
