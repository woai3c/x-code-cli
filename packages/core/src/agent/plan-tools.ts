// @x-code-cli/core — Plan-mode and todoWrite tool handlers.
//
// Extracted from tool-execution.ts to keep handleToolCall at a manageable
// size. Each handler has the same contract: mutate state + push result via
// pushToolResult, and return void.
import type { AgentCallbacks, AgentOptions, TodoItem } from '../types/index.js'
import { extractText } from '../utils/message-helpers.js'
import type { LoopState } from './loop-state.js'
import { toolErrorString } from './messages.js'
import { makePlanFilePath, readPlan, writePlan } from './plan-storage.js'

type PushToolResult = (
  state: LoopState,
  callbacks: AgentCallbacks,
  toolCallId: string,
  toolName: string,
  output: string,
  isError?: boolean,
) => void

function lastUserMessageText(messages: LoopState['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user') {
      return extractText(m.content)
    }
  }
  return ''
}

export async function handleTodoWrite(
  input: Record<string, unknown>,
  toolCallId: string,
  state: LoopState,
  callbacks: AgentCallbacks,
  pushToolResult: PushToolResult,
): Promise<void> {
  type RawTodo = { content?: string; activeForm?: string; status?: TodoItem['status'] }
  const raw = (input.todos as RawTodo[] | undefined) ?? []
  const normalized: TodoItem[] = []
  for (const t of raw) {
    const content = (t.content ?? '').trim()
    const activeForm = (t.activeForm ?? '').trim()
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
    'todoWrite',
    allDone
      ? `All todos completed. Checklist cleared.${verifyNote}${droppedNote}`
      : `Todo list updated. Keep the checklist current — mark items completed immediately when finished, and ensure exactly one item is in_progress.${droppedNote}`,
  )
}

export async function handleEnterPlanMode(
  input: Record<string, unknown>,
  toolCallId: string,
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  pushToolResult: PushToolResult,
): Promise<void> {
  if (state.permissionMode === 'plan') {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      'enterPlanMode',
      'Already in plan mode. Continue the conversation; call exitPlanMode when the user has asked for an implementation and you have a plan ready.',
    )
    return
  }
  const decision = await callbacks.onAskPermission({ toolCallId, toolName: 'enterPlanMode', input })
  if (options.abortSignal?.aborted) {
    pushToolResult(state, callbacks, toolCallId, 'enterPlanMode', '[Tool execution interrupted by user]', true)
    return
  }
  if (decision === 'no') {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      'enterPlanMode',
      "User declined to enter plan mode. Continue with the user's request in default mode — make whatever edits or shell calls the task requires (subject to per-tool permission).",
      true,
    )
    return
  }
  state.permissionMode = 'plan'
  state.systemPromptCache = null
  state.expectCacheMiss = true
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
    'enterPlanMode',
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
}

export async function handleExitPlanMode(
  input: Record<string, unknown>,
  toolCallId: string,
  state: LoopState,
  callbacks: AgentCallbacks,
  pushToolResult: PushToolResult,
): Promise<void> {
  if (state.permissionMode !== 'plan') {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      'exitPlanMode',
      toolErrorString('not in plan mode. exitPlanMode is only valid when the session is in plan mode.'),
      true,
    )
    return
  }
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
      'exitPlanMode',
      toolErrorString(
        `the plan file at ${planPath} is empty. Write your plan to that file using writeFile or edit, then call exitPlanMode again.`,
      ),
      true,
    )
    return
  }

  let savedPath: string | null = planPath
  if (planOverride) {
    try {
      savedPath = await writePlan(planPath, planBody)
      state.currentPlanPath = savedPath
    } catch {
      // Non-fatal — approval dialog uses the in-memory body.
    }
  }

  const approved = await callbacks.onPlanApprovalRequest(planBody)
  if (approved) {
    state.permissionMode = 'acceptEdits'
    state.systemPromptCache = null
    state.expectCacheMiss = true
    const persisted = savedPath ?? state.currentPlanPath
    state.currentPlanPath = null
    callbacks.onPlanModeChange('acceptEdits')
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      'exitPlanMode',
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
    'exitPlanMode',
    [
      'Plan rejected by user. You are still in plan mode.',
      "Read the user's next message for feedback, revise the plan accordingly,",
      'and call exitPlanMode again with the revised body. Consider asking the user',
      'a clarifying question via askUser if you are unsure what to change.',
    ].join('\n'),
    true,
  )
}
