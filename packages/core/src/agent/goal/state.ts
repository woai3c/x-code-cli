import { randomUUID } from 'node:crypto'

import type { TokenUsage } from '../../types/index.js'
import type { LoopState } from '../loop-state.js'
import type {
  GoalAttempt,
  GoalPendingTransition,
  GoalState,
  GoalStatus,
  GoalVerificationResult,
  GoalVerifier,
} from './types.js'

export interface CreateGoalInput {
  objective: string
  maxTurns?: number
  tokenBudget?: number
  verifiers?: GoalVerifier[]
  requiresUserConfirmation?: boolean
  createdBy?: GoalState['createdBy']
}

const TERMINAL_STATUSES = new Set<GoalStatus>([
  'blocked',
  'complete',
  'cancelled',
  'budget_limited',
  'usage_limited',
  'max_turns',
  'failed',
])

export function isGoalTerminal(status: GoalStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

export function assertActiveGoal(state: LoopState, goalId?: string): GoalState {
  const goal = state.goal
  if (!goal) throw new Error('No goal exists in this session')
  if (goalId && goal.id !== goalId) throw new Error(`Goal ${goalId} is not the current goal`)
  if (goal.status !== 'active') throw new Error(`Goal is ${goal.status}, not active`)
  return goal
}

export function createGoal(state: LoopState, input: CreateGoalInput): GoalState {
  const objective = input.objective.trim()
  if (!objective) throw new Error('Goal objective is required')
  if (state.goal && !isGoalTerminal(state.goal.status)) {
    throw new Error(`Cannot create a new goal while goal ${state.goal.id} is ${state.goal.status}`)
  }

  const now = new Date().toISOString()
  const goal: GoalState = {
    id: randomUUID(),
    objective,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy ?? 'slash',
    maxTurns: input.maxTurns && input.maxTurns > 0 ? Math.floor(input.maxTurns) : undefined,
    turnCount: 0,
    tokenBudget: input.tokenBudget && input.tokenBudget > 0 ? Math.floor(input.tokenBudget) : undefined,
    baselineTokens: state.tokenUsage.totalTokens,
    verifiers: input.verifiers ?? [],
    verificationResults: [],
    repeatedBlockerCount: 0,
    repeatedVerificationFailureCount: 0,
    attempts: [],
    requiresUserConfirmation: input.requiresUserConfirmation,
  }
  state.goal = goal
  state.goalInputs = []
  state.systemPromptCache = null
  state.expectCacheMiss = true
  return goal
}

export function updateGoalStatus(goal: GoalState, status: GoalStatus, summary?: string): GoalState {
  goal.status = status
  goal.updatedAt = new Date().toISOString()
  if (summary !== undefined) goal.finalSummary = summary
  return goal
}

export function pauseGoal(state: LoopState): GoalState {
  const goal = assertActiveGoal(state)
  goal.status = 'paused'
  goal.updatedAt = new Date().toISOString()
  return goal
}

export function resumeGoal(state: LoopState): GoalState {
  if (!state.goal) throw new Error('No goal exists in this session')
  if (state.goal.status !== 'paused' && state.goal.status !== 'blocked' && state.goal.status !== 'max_turns') {
    throw new Error(`Cannot resume a goal with status ${state.goal.status}`)
  }
  state.goal.status = 'active'
  state.goal.updatedAt = new Date().toISOString()
  state.systemPromptCache = null
  state.expectCacheMiss = true
  return state.goal
}

export function cancelGoal(state: LoopState): GoalState {
  if (!state.goal) throw new Error('No goal exists in this session')
  state.goal.status = 'cancelled'
  state.goal.updatedAt = new Date().toISOString()
  return state.goal
}

export function clearGoal(state: LoopState): void {
  state.goal = null
  state.goalInputs = []
  state.systemPromptCache = null
  state.expectCacheMiss = true
}

export function requestGoalComplete(
  state: LoopState,
  input: { evidence: string; summary?: string; requestedByToolCallId?: string },
): GoalPendingTransition {
  const goal = assertActiveGoal(state)
  if (!input.evidence.trim()) throw new Error('Completion evidence is required')
  const transition: GoalPendingTransition = {
    kind: 'complete_requested',
    evidence: input.evidence.trim(),
    summary: input.summary?.trim() || undefined,
    requestedAt: new Date().toISOString(),
    requestedByToolCallId: input.requestedByToolCallId,
  }
  goal.pendingTransition = transition
  goal.updatedAt = transition.requestedAt
  return transition
}

export function requestGoalBlocked(
  state: LoopState,
  input: { blocker: string; evidence?: string; summary?: string; requestedByToolCallId?: string },
): GoalPendingTransition {
  const goal = assertActiveGoal(state)
  if (!input.blocker.trim()) throw new Error('Blocker is required')
  const transition: GoalPendingTransition = {
    kind: 'blocked_requested',
    evidence: input.evidence?.trim() || input.blocker.trim(),
    summary: input.summary?.trim() || undefined,
    blocker: input.blocker.trim(),
    requestedAt: new Date().toISOString(),
    requestedByToolCallId: input.requestedByToolCallId,
  }
  goal.pendingTransition = transition
  goal.updatedAt = transition.requestedAt
  return transition
}

export function clearPendingTransition(goal: GoalState): void {
  delete goal.pendingTransition
  goal.updatedAt = new Date().toISOString()
}

export function recordGoalAttempt(goal: GoalState, attempt: GoalAttempt): void {
  goal.attempts.push(attempt)
  goal.turnCount += 1
  goal.updatedAt = attempt.endedAt ?? new Date().toISOString()
}

export function recordVerificationResult(goal: GoalState, result: GoalVerificationResult): void {
  goal.verificationResults.push(result)
  goal.updatedAt = result.ts
}

export function recordVerificationFailure(goal: GoalState, results: GoalVerificationResult[]): number {
  const fingerprint = verificationFailureFingerprint(results)
  const repeatedCount =
    fingerprint && fingerprint === goal.lastVerificationFailureFingerprint
      ? goal.repeatedVerificationFailureCount + 1
      : 1
  goal.lastVerificationFailureFingerprint = fingerprint
  goal.repeatedVerificationFailureCount = repeatedCount
  goal.updatedAt = new Date().toISOString()
  return repeatedCount
}

export function resetVerificationFailures(goal: GoalState): void {
  goal.repeatedVerificationFailureCount = 0
  delete goal.lastVerificationFailureFingerprint
  goal.updatedAt = new Date().toISOString()
}

export function verificationFailureFingerprint(results: GoalVerificationResult[]): string {
  return results
    .filter((result) => !result.ok)
    .map((result) => {
      const verifier =
        result.verifier.kind === 'shell'
          ? `shell:${result.verifier.command}`
          : result.verifier.kind === 'subagent'
            ? `subagent:${result.verifier.agent}`
            : `file:${result.verifier.path}`
      const details = result.requiredFixes?.length ? result.requiredFixes : [result.summary]
      return `${verifier}:${details.map(normalizeFailureText).join('|')}`
    })
    .join('||')
}

function normalizeFailureText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function snapshotUsage(usage: TokenUsage): TokenUsage {
  return { ...usage }
}

export function remainingTokenBudget(goal: GoalState, state: LoopState): number | undefined {
  if (!goal.tokenBudget) return undefined
  return Math.max(0, goal.tokenBudget - (state.tokenUsage.totalTokens - goal.baselineTokens))
}

export function tokenBudgetReached(goal: GoalState, state: LoopState): boolean {
  const remaining = remainingTokenBudget(goal, state)
  return remaining !== undefined && remaining <= 0
}
