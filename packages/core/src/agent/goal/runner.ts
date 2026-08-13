import type { LanguageModel } from 'ai'

import type { AgentCallbacks, AgentOptions } from '../../types/index.js'
import { debugLog } from '../../utils.js'
import type { LoopState } from '../loop-state.js'
import type { AgentLoopResult } from '../loop.js'
import { appendGoalInput, appendGoalState, appendGoalVerification } from '../session-store.js'
import { runFinalSummaryTurn } from './final-summary.js'
import { admitGoalInput, hasPendingGoalInput, promoteNextGoalInput } from './input.js'
import {
  buildBlockedRetryPrompt,
  buildContinuationPrompt,
  buildInitialGoalPrompt,
  buildVerifierFailurePrompt,
} from './prompts.js'
import {
  clearPendingTransition,
  recordGoalAttempt,
  recordVerificationFailure,
  resetVerificationFailures,
  snapshotUsage,
  tokenBudgetReached,
  updateGoalStatus,
} from './state.js'
import type { GoalAttempt, GoalInputKind, GoalRunSummary, GoalState } from './types.js'
import { runVerifierLadder } from './verifier.js'

export interface GoalAgentTurnResult extends AgentLoopResult {
  text?: string
}

export interface RunGoalLoopInput {
  state: LoopState
  model: LanguageModel
  options: AgentOptions
  callbacks: AgentCallbacks
  goalId: string
  signal?: AbortSignal
  runAgentTurn: (
    content: string,
    options?: { silent?: boolean; finalSummary?: boolean },
  ) => Promise<GoalAgentTurnResult>
}

export async function runGoalLoop(input: RunGoalLoopInput): Promise<GoalRunSummary> {
  const { state, goalId, signal } = input
  const goal = state.goal
  if (!goal || goal.id !== goalId) throw new Error(`Goal ${goalId} is not the current goal`)
  const goalAuthority = goal.authority ?? { source: 'peer' as const, peerTainted: true }
  goal.authority = structuredClone(goalAuthority)
  if (goalAuthority.peerTainted || goalAuthority.source === 'peer') {
    state.executionAuthority = structuredClone(goalAuthority)
  }

  debugLog('goal.runner.start', `${goal.id} ${goal.objective}`)
  while (goal.status === 'active') {
    if (signal?.aborted || input.options.abortSignal?.aborted) break

    if (tokenBudgetReached(goal, state)) {
      await finalizeBySummary(input, goal, 'budget_limited')
      break
    }
    if (goal.maxTurns !== undefined && goal.turnCount >= goal.maxTurns) {
      await finalizeBySummary(input, goal, 'max_turns')
      break
    }

    await ensurePendingGoalInput(state, goal)
    const goalInput = promoteNextGoalInput(state, goal.id)
    if (!goalInput) break
    await appendGoalInput(state, goalInput)

    const before = snapshotUsage(state.tokenUsage)
    const startedAt = new Date().toISOString()
    let finish: GoalAttempt['finish'] = 'stop'
    let result: GoalAgentTurnResult | null = null
    try {
      result = await input.runAgentTurn(goalInput.content, { silent: true })
    } catch (err) {
      finish = signal?.aborted || input.options.abortSignal?.aborted ? 'aborted' : 'error'
      debugLog('goal.runner.turn-error', err instanceof Error ? err.message : String(err))
    }

    const attempt: GoalAttempt = {
      id: goalInput.id,
      turn: goal.turnCount + 1,
      inputKind: goalInput.kind,
      promptPreview: preview(goalInput.content),
      startedAt,
      endedAt: new Date().toISOString(),
      turnCount: result?.turnCount ?? 0,
      tokenUsageBefore: before,
      tokenUsageAfter: snapshotUsage(state.tokenUsage),
      finish,
    }
    recordGoalAttempt(goal, attempt)

    if (signal?.aborted || input.options.abortSignal?.aborted) {
      attempt.finish = 'aborted'
      break
    }
    if (finish === 'aborted' || finish === 'error') break
    if (goal.status !== 'active') break
    if (tokenBudgetReached(goal, state)) {
      attempt.finish = 'budget_limited'
      await finalizeBySummary(input, goal, 'budget_limited')
      break
    }

    const transition = goal.pendingTransition
    if (transition?.kind === 'complete_requested') {
      const verification = await runVerifierLadder({
        goal,
        state,
        options: input.options,
        callbacks: input.callbacks,
        model: input.model,
      })
      for (const result of verification.results) {
        void appendGoalVerification(state, goal.id, result)
      }
      if (verification.ok) {
        resetVerificationFailures(goal)
        attempt.finish = 'complete'
        updateGoalStatus(goal, 'complete', transition.summary ?? verification.summary)
        clearPendingTransition(goal)
        void appendGoalState(state)
        break
      }
      const repeatedFailureCount = recordVerificationFailure(goal, verification.results)
      if (!verification.retryable) {
        attempt.finish = 'blocked'
        updateGoalStatus(goal, 'blocked', verification.summary)
        clearPendingTransition(goal)
        void appendGoalState(state)
        break
      }
      attempt.finish = 'verification_failed'
      const nextInput = admitGoalInput(state, {
        goalId: goal.id,
        kind: 'verifier_failure',
        content: buildVerifierFailurePrompt(goal, verification.results, verification.summary, repeatedFailureCount),
      })
      void appendGoalInput(state, nextInput)
      clearPendingTransition(goal)
      void appendGoalState(state)
      continue
    }

    if (transition?.kind === 'blocked_requested') {
      const blocker = transition.blocker ?? transition.evidence
      const repeated = goal.lastBlocker && isSameBlocker(goal.lastBlocker, blocker) ? goal.repeatedBlockerCount + 1 : 1
      goal.lastBlocker = blocker
      goal.repeatedBlockerCount = repeated
      clearPendingTransition(goal)
      if (repeated >= 3) {
        attempt.finish = 'blocked'
        updateGoalStatus(goal, 'blocked', transition.summary ?? blocker)
        void appendGoalState(state)
        break
      }
      const nextInput = admitGoalInput(state, {
        goalId: goal.id,
        kind: 'continuation',
        content: buildBlockedRetryPrompt(goal, blocker, repeated),
      })
      void appendGoalInput(state, nextInput)
      void appendGoalState(state)
      continue
    }

    const nextInput = admitGoalInput(state, {
      goalId: goal.id,
      kind: 'continuation',
      content: buildContinuationPrompt(goal),
    })
    void appendGoalInput(state, nextInput)
    void appendGoalState(state)
  }

  debugLog('goal.runner.stop', `${goal.id} ${goal.status}`)
  return { goalId: goal.id, status: goal.status, turns: goal.turnCount, summary: goal.finalSummary }
}

async function ensurePendingGoalInput(state: LoopState, goal: GoalState): Promise<void> {
  if (hasPendingGoalInput(state, goal.id)) return
  const kind: GoalInputKind = goal.turnCount === 0 ? 'initial' : 'continuation'
  const content = kind === 'initial' ? buildInitialGoalPrompt(goal) : buildContinuationPrompt(goal)
  const input = admitGoalInput(state, { goalId: goal.id, kind, content })
  await appendGoalInput(state, input)
}

async function finalizeBySummary(
  input: RunGoalLoopInput,
  goal: GoalState,
  reason: 'max_turns' | 'budget_limited',
): Promise<void> {
  const summary = await runFinalSummaryTurn({
    goal,
    reason,
    runAgentTurn: async (content, options) => input.runAgentTurn(content, options),
  })
  clearPendingTransition(goal)
  updateGoalStatus(goal, reason, summary)
  void appendGoalState(input.state)
}

function preview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 240)
}

export function isSameBlocker(previous: string, current: string): boolean {
  const a = normalizeBlocker(previous)
  const b = normalizeBlocker(current)
  if (!a || !b) return false
  if (a === b || a.includes(b) || b.includes(a)) return true

  const aPairs = bigrams(a)
  const bPairs = bigrams(b)
  let overlap = 0
  for (const pair of aPairs) {
    if (bPairs.has(pair)) overlap++
  }
  return (2 * overlap) / (aPairs.size + bPairs.size) >= 0.4
}

function normalizeBlocker(value: string): string {
  return value
    .toLowerCase()
    .split(/已(?:检查|尝试|穷尽|确认|搜索|查看)/u, 1)[0]!
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .replace(/(?:未包含|没有|无)(?:任何)?(?:具体)?(?:可执行)?(?:的)?(?:任务内容|任务要求|任务|内容)/gu, '缺少任务')
    .replace(/无法确定需要完成什么工作/gu, '缺少任务')
    .replace(/目标描述仅为/gu, '目标')
}

function bigrams(value: string): Set<string> {
  if (value.length < 2) return new Set([value])
  const result = new Set<string>()
  for (let i = 0; i < value.length - 1; i++) result.add(value.slice(i, i + 2))
  return result
}
