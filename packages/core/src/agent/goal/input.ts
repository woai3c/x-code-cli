import { randomUUID } from 'node:crypto'

import type { LoopState } from '../loop-state.js'
import type { GoalInput, GoalInputKind } from './types.js'

export function admitGoalInput(
  state: LoopState,
  input: { goalId: string; kind: GoalInputKind; content: string },
): GoalInput {
  const goalInput: GoalInput = {
    id: randomUUID(),
    goalId: input.goalId,
    kind: input.kind,
    content: input.content,
    admittedAt: new Date().toISOString(),
  }
  state.goalInputs.push(goalInput)
  return goalInput
}

export function hasPendingGoalInput(state: LoopState, goalId: string): boolean {
  return state.goalInputs.some((input) => input.goalId === goalId && !input.promotedAt)
}

export function promoteNextGoalInput(state: LoopState, goalId: string): GoalInput | null {
  const input = state.goalInputs.find((candidate) => candidate.goalId === goalId && !candidate.promotedAt)
  if (!input) return null
  input.promotedAt = new Date().toISOString()
  return input
}

export function pendingGoalInputs(state: LoopState, goalId: string): GoalInput[] {
  return state.goalInputs.filter((input) => input.goalId === goalId && !input.promotedAt)
}
