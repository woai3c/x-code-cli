// @x-code-cli/core — Plan-mode exit handler.
//
// Extracted from tool-execution.ts to keep handleToolCall at a manageable
// size. Mutates state + pushes result via pushToolResult, and returns void.
import type { AgentCallbacks } from '../types/index.js'
import { extractText } from '../utils/message-helpers.js'
import { markExpectedCacheMiss } from './cache-stats.js'
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
    markExpectedCacheMiss(state, 'permission-mode-change')
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
        'Write tools (writeFile, edit) are now auto-approved (acceptEdits mode); shell commands still go through normal permission classification.',
        persisted ? `The approved plan is saved at: ${persisted}` : '',
        'Start implementing the plan.',
      ]
        .filter(Boolean)
        .join('\n'),
    )
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
