// @x-code-cli/core — Tool execution & dispatch
import fs from 'node:fs/promises'
import path from 'node:path'

import { checkPermission } from '../permissions/index.js'
import { truncateToolResult } from '../tools/index.js'
import { clearProgressReporter, reportProgress } from '../tools/progress.js'
import { getShellProvider } from '../tools/shell-provider.js'
import type { AgentCallbacks, AgentOptions, LanguageModel, TodoItem } from '../types/index.js'
import { foldShellErrorNoise } from '../utils/shell-error.js'
import { computeEditDiff } from './diff.js'
import { checkForLoop, recordToolCall } from './loop-guard.js'
import type { LoopState } from './loop-state.js'
import { toolResultMessage } from './messages.js'
import { makePlanFilePath, readPlan, writePlan } from './plan-storage.js'
import { runSubAgent } from './sub-agents/runner.js'

/** Walk back through state.messages and grab the most recent user
 *  message's text — used as the slug source for the plan filename. */
function lastUserMessageText(messages: LoopState['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user') {
      const content = m.content
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
    }
  }
  return ''
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
      oldContent = await fs.readFile(filePath, 'utf-8')
    } catch {
      oldContent = null
    }
    await fs.writeFile(filePath, content, 'utf-8')
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
    const content = await fs.readFile(filePath, 'utf-8')
    if (!replaceAll) {
      const count = countOccurrences(content, oldString)
      if (count === 0) return `Error: old_string not found in ${filePath}`
      if (count > 1)
        return `Error: old_string is not unique in ${filePath} (found ${count} occurrences). Provide more context or set replaceAll: true.`
    }

    const newContent = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString)
    await fs.writeFile(filePath, newContent, 'utf-8')

    const payload = computeEditDiff(filePath, content, newContent)
    if (payload && callbacks.onFileEdit) callbacks.onFileEdit(toolCallId, payload)

    return `File edited: ${filePath}`
  }

  return 'Error: unknown write tool'
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
  const stdout = foldShellErrorNoise(toStr(result.stdout))
  const stderr = foldShellErrorNoise(toStr(result.stderr))
  const output = [stdout, stderr].filter(Boolean).join('\n').trim()
  if (result.exitCode !== 0) {
    const text = output ? `${output}\nExit code ${result.exitCode}` : `Exit code ${result.exitCode}`
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
  const { toolName, input, toolCallId } = tc

  // ── askUser tool ──
  // Skip the loop guard for askUser — the model asking the user the same
  // clarifying question twice is almost always intentional (e.g. the user
  // answered ambiguously) and blocking it would silently break the UX.
  if (toolName === 'askUser') {
    const question = input.question as string
    const optionsList = input.options as { label: string; description: string }[]
    const answer = await callbacks.onAskUser(question, optionsList)
    pushToolResult(state, callbacks, toolCallId, toolName, `User answered: ${answer}`)
    return
  }

  // ── todoWrite tool ──
  // Full-replacement semantics: every call rewrites state.todos with
  // the model's payload. Auto-clears (drops to []) when every item is
  // completed, mirroring Claude Code's TodoWriteTool behavior — the
  // user's live UI panel goes back to "no checklist" once the work is
  // done, instead of showing a stale all-✓ list forever.
  if (toolName === 'todoWrite') {
    // Schema is intentionally lenient (see todo-write.ts) — every
    // field is optional at the wire level so weaker models that drop
    // a field per item don't poison the conversation. We patch
    // missing pieces here and silently drop items that have nothing
    // useful to render.
    type RawTodo = { content?: string; activeForm?: string; status?: TodoItem['status'] }
    const raw = (input.todos as RawTodo[] | undefined) ?? []
    const normalized: TodoItem[] = []
    for (const t of raw) {
      const content = (t.content ?? '').trim()
      const activeForm = (t.activeForm ?? '').trim()
      // Need at least one identity field — otherwise this is just an
      // empty entry and there's nothing useful to show or track.
      if (!content && !activeForm) continue
      normalized.push({
        content: content || activeForm,
        activeForm: activeForm || content,
        status: t.status ?? 'pending',
      })
    }
    const allDone = normalized.length > 0 && normalized.every((t) => t.status === 'completed')
    state.todos = allDone ? [] : normalized
    callbacks.onTodosUpdate(state.todos)
    const dropped = raw.length - normalized.length
    const droppedNote =
      dropped > 0
        ? ` ${dropped} entr${dropped === 1 ? 'y was' : 'ies were'} dropped because they had neither content nor activeForm — please include both fields next time so the user sees clean labels.`
        : ''
    // Verification nudge: when completing a 3+ item list and none of
    // them look like a verification step, remind the model to verify.
    const VERIFY_RE = /\b(verif|test|check|lint|build|typecheck|tsc)\b/i
    const needsVerifyNudge =
      allDone &&
      normalized.length >= 3 &&
      !normalized.some((t) => VERIFY_RE.test(t.content) || VERIFY_RE.test(t.activeForm))
    const verifyNote = needsVerifyNudge
      ? ' Before wrapping up, verify your work — run tests, lint, or type-check as appropriate for this project.'
      : ''
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      allDone
        ? `All todos completed. Checklist cleared.${verifyNote}${droppedNote}`
        : `Todo list updated. Keep the checklist current — mark items completed immediately when finished, and ensure exactly one item is in_progress.${droppedNote}`,
    )
    return
  }

  // ── task tool (sub-agent dispatch) ──
  if (toolName === 'task') {
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
    return
  }

  // ── enterPlanMode tool ──
  // Flip state.permissionMode → 'plan', invalidate the system-prompt
  // cache so the next turn rebuilds it with the overlay, and reserve a
  // plan-file path on state.currentPlanPath WITHOUT actually creating
  // the file (the path is just a string until the model decides it
  // wants a scratchpad). Plan mode is a conversation state, not a
  // forced "write to a file" workflow — for Q&A and discussion the
  // model never touches the file. The path is created lazily, the
  // first time the model calls writeFile/edit on it (or when
  // exitPlanMode persists the approved plan).
  if (toolName === 'enterPlanMode') {
    if (state.permissionMode === 'plan') {
      pushToolResult(
        state,
        callbacks,
        toolCallId,
        toolName,
        'Already in plan mode. Continue the conversation; call exitPlanMode when the user has asked for an implementation and you have a plan ready.',
      )
      return
    }
    // Approval gate. Mirrors Claude Code: model can recommend plan
    // mode but cannot enter on its own — user has to consent so the
    // mode flip never feels like the model unilaterally hijacking the
    // session. The same dialog component the write-tool path uses
    // renders a "X-Code wants to enter plan mode" prompt with Yes/No.
    const approved = await callbacks.onAskPermission({ toolCallId, toolName, input })
    if (options.abortSignal?.aborted) {
      pushToolResult(
        state,
        callbacks,
        toolCallId,
        toolName,
        '[Tool execution interrupted by user]',
        true,
      )
      return
    }
    if (!approved) {
      pushToolResult(
        state,
        callbacks,
        toolCallId,
        toolName,
        "User declined to enter plan mode. Continue with the user's request in default mode — make whatever edits or shell calls the task requires (subject to per-tool permission).",
        true,
      )
      return
    }
    state.permissionMode = 'plan'
    state.systemPromptCache = null
    // Derive the plan file path. Slug priority:
    //   1. Model-supplied `topic` (3-5 English words specific to the
    //      current task — most accurate when the user is mid-session
    //      and the topic has shifted).
    //   2. `state.taskSlug` (set once per session by agentLoop using
    //      either local slugify or a one-shot LLM summary — already
    //      handles CJK first messages).
    //   3. Raw last-user-message text (final fallback; slugify will
    //      reduce CJK to empty → timestamp-only filename).
    if (!state.currentPlanPath) {
      const topic = (input.topic as string | undefined)?.trim()
      const fallbackText = lastUserMessageText(state.messages)
      const explicitSlug = topic && topic.length > 0 ? topic : state.taskSlug || undefined
      state.currentPlanPath = makePlanFilePath(fallbackText, { slug: explicitSlug })
    }
    callbacks.onPlanModeChange('plan')
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      [
        'Entered plan mode (user approved).',
        '',
        'Read-only tools are unrestricted (readFile, glob, grep, listDir, webSearch, webFetch).',
        `Plan file path for this session: ${state.currentPlanPath}`,
        'Use writeFile/edit on the plan file to build your plan; do NOT edit any other files',
        'or run state-changing shell commands until the user approves your plan via exitPlanMode.',
        '',
        'Workflow: explore → update plan file → askUser → repeat.',
        '',
        'CRITICAL: when the plan is ready, call **exitPlanMode** to request approval — NOT',
        'askUser. askUser cannot leave plan mode no matter how the user answers; only',
        'exitPlanMode flips the mode and unblocks your writeFile/edit/shell calls.',
      ].join('\n'),
    )
    return
  }

  // ── exitPlanMode tool ──
  // Triggers the user-approval gate. The plan body comes from
  // `input.plan` (passed verbatim by the model). We persist it to the
  // session's plan file as a permanent record before showing the
  // approval dialog — that way even rejected plans leave a trace, and
  // approved plans live alongside the implementation that follows.
  // Approval flips state back to 'default' and invalidates the
  // system-prompt cache so the next turn drops the plan-mode overlay.
  // Rejection keeps the model in plan mode and tells it to revise.
  if (toolName === 'exitPlanMode') {
    if (state.permissionMode !== 'plan') {
      pushToolResult(
        state,
        callbacks,
        toolCallId,
        toolName,
        'Error: not in plan mode. exitPlanMode is only valid when the session is in plan mode.',
        true,
      )
      return
    }
    // Source of truth for the plan body is the plan file the model has
    // been writing to during planning (matches Claude Code: the model
    // builds the plan incrementally via writeFile/edit, then calls
    // exitPlanMode which reads the file). The optional `plan` override
    // exists for rare cases where the model wants to substitute the
    // file content with something different.
    const planPath =
      state.currentPlanPath ??
      makePlanFilePath(lastUserMessageText(state.messages), { slug: state.taskSlug || undefined })
    state.currentPlanPath = planPath
    const planOverride = (input.plan as string | undefined)?.trim()
    let planBody = planOverride ?? ''
    if (!planBody) {
      planBody = (await readPlan(planPath)).trim()
    }
    if (!planBody) {
      pushToolResult(
        state,
        callbacks,
        toolCallId,
        toolName,
        `Error: the plan file at ${planPath} is empty. Write your plan to that file using writeFile or edit, then call exitPlanMode again.`,
        true,
      )
      return
    }

    // If the model passed an override, persist it back to the plan
    // file so the on-disk record matches what the user sees / approves.
    let savedPath: string | null = planPath
    if (planOverride) {
      try {
        savedPath = await writePlan(planPath, planBody)
        state.currentPlanPath = savedPath
      } catch {
        // Disk failure (read-only fs, permissions) is non-fatal — fall
        // through to the approval dialog with the in-memory body.
      }
    }

    const approved = await callbacks.onPlanApprovalRequest(planBody)
    if (approved) {
      // Default post-approval mode is `acceptEdits` — the user just
      // vetted the plan, so making them click "Yes" on every writeFile
      // / edit during implementation is pure friction. Shell commands
      // still go through normal classification (always-allow for read-
      // only, ask for mixed, deny for destructive) so we don't blanket-
      // approve `rm -rf` on plan approval. Matches Claude Code's
      // default "Yes, auto-accept edits" behavior.
      state.permissionMode = 'acceptEdits'
      state.systemPromptCache = null
      const persisted = savedPath ?? state.currentPlanPath
      state.currentPlanPath = null
      callbacks.onPlanModeChange('acceptEdits')
      pushToolResult(
        state,
        callbacks,
        toolCallId,
        toolName,
        [
          'Plan approved by user. Plan mode has been exited.',
          persisted ? `The approved plan is saved at: ${persisted}` : '',
          'You can now edit files and run shell commands. Start implementing the plan.',
          '',
          'For multi-step plans, call **todoWrite** first to break the plan into a',
          'tracked checklist — the user sees a live panel of your progress and you',
          'avoid losing track of remaining steps mid-implementation.',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      // Also inject a system-reminder-style user-role meta message so
      // the model treats the mode flip as a fresh top-level instruction
      // rather than just a tool result. Mirrors Claude Code's
      // `## Exited Plan Mode` attachment (messages.ts:3847-3852) — gives
      // the next turn a clear "the rules just changed" anchor.
      state.messages.push({
        role: 'user',
        content: [
          '## Exited Plan Mode',
          '',
          'You have exited plan mode. You can now make edits, run tools, and take actions.',
          'Write tools (writeFile, edit) are now auto-approved (acceptEdits mode); shell commands',
          'still go through normal permission classification.',
          persisted ? `The plan file is located at ${persisted} if you need to reference it.` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      })
      return
    }
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      [
        'Plan rejected by user. You are still in plan mode.',
        "Read the user's next message for feedback, revise the plan accordingly,",
        'and call exitPlanMode again with the revised body. Consider asking the user',
        'a clarifying question via askUser if you are unsure what to change.',
      ].join('\n'),
      true,
    )
    return
  }

  // ── Doom-loop detection ──
  // For manual tools we pre-block. For auto-executed tools the call has
  // already run (result landed in state.messages via collectTurnResponse);
  // we still record the hash and, on soft-block, push a supplemental notice
  // so the next turn sees a clear stop signal. On hard-block, we additionally
  // prompt the user before returning.
  const isAutoExecuted = AUTO_EXECUTED_TOOLS.has(toolName)
  const loopCheck = checkForLoop(state, toolName, input, toolCallId)
  if (loopCheck.kind !== 'ok') {
    recordToolCall(state, toolName, input, loopCheck.hash)

    if (isAutoExecuted) {
      // The tool result already exists in state.messages. Append a follow-up
      // user-role notice so the model's next step has explicit context that
      // this path is spinning — without this nudge, some models keep trying.
      state.messages.push({
        role: 'user',
        content: `[loop-guard] ${loopCheck.message}`,
      })
      callbacks.onToolResult(toolCallId, `[loop-guard] ${loopCheck.message}`, true)
    } else {
      // Manual tool — short-circuit by synthesising the result. The tool body
      // never runs; no side effects, no permission prompt.
      pushToolResult(state, callbacks, toolCallId, toolName, `[loop-guard] ${loopCheck.message}`, true)
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
    return
  }

  recordToolCall(state, toolName, input, loopCheck.hash)

  // ── Permission check for write tools and shell ──
  if (toolName === 'writeFile' || toolName === 'edit' || toolName === 'shell') {
    const approved = await checkPermission(
      { toolCallId, toolName, input },
      options.trustMode,
      callbacks.onAskPermission,
      state.permissionMode,
      process.cwd(),
    )
    if (options.abortSignal?.aborted) {
      pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
      return
    }
    if (!approved) {
      pushToolResult(state, callbacks, toolCallId, toolName, 'Permission denied by user.')
      return
    }
  }

  // ── Execute tool ──
  let output: string
  let isError = false
  try {
    if (toolName === 'writeFile' || toolName === 'edit') {
      output = await executeWriteTool(toolName, input, toolCallId, callbacks)
      // executeWriteTool returns "Error: ..." strings for in-band failures
      // (missing match, non-unique match) rather than throwing — surface
      // those as errored results so the scrollback line flips to red.
      if (output.startsWith('Error:')) isError = true
      else state.filesModified.add(input.filePath as string)
    } else if (toolName === 'shell') {
      const timeout = (input.timeout as number) ?? 30000
      const shellResult = await executeShell(
        input.command as string,
        timeout,
        options.abortSignal,
        callbacks,
        toolCallId,
      )
      output = shellResult.output
      isError = shellResult.isError
    } else {
      // Tools with execute (readFile, glob, grep, etc.) are auto-executed by AI SDK
      return
    }
  } catch (err) {
    output = `Error: ${err instanceof Error ? err.message : String(err)}`
    isError = true
  }

  pushToolResult(state, callbacks, toolCallId, toolName, truncateToolResult(output), isError)
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
    await handleToolCall(tc, state, options, callbacks, parentModel)
  }
}
