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

  debugLog('goal.runner.start', `${goal.id} ${goal.objective}`)
  while (goal.status === 'active') {
    if (signal?.aborted || input.options.abortSignal?.aborted) break

    if (tokenBudgetReached(goal, state)) {
      await finalizeBySummary(input, goal, 'budget_limited')
      break
    }
    if (goal.turnCount >= goal.maxTurns) {
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
        attempt.finish = 'complete'
        updateGoalStatus(goal, 'complete', transition.summary ?? verification.summary)
        clearPendingTransition(goal)
        void appendGoalState(state)
        break
      }
      attempt.finish = 'verification_failed'
      const nextInput = admitGoalInput(state, {
        goalId: goal.id,
        kind: 'verifier_failure',
        content: buildVerifierFailurePrompt(goal, verification.results, verification.summary),
      })
      void appendGoalInput(state, nextInput)
      clearPendingTransition(goal)
      void appendGoalState(state)
      continue
    }

    if (transition?.kind === 'blocked_requested') {
      const blocker = transition.blocker ?? transition.evidence
      const repeated = goal.lastBlocker === blocker ? goal.repeatedBlockerCount + 1 : 1
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
  updateGoalStatus(goal, reason, summary)
  void appendGoalState(input.state)
}

function preview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 240)
}
