import { tool } from 'ai'

import { z } from 'zod'

import { remainingTokenBudget } from '../agent/goal/state.js'
import type { LoopState } from '../agent/loop-state.js'

export function createGetGoalTool(state: LoopState) {
  return tool({
    description:
      'Inspect the current durable goal state, including objective, progress, verifiers, recent attempts, and remaining budget.',
    inputSchema: z.object({}),
    execute: async () => {
      const goal = state.goal
      if (!goal) return { ok: false, error: 'No goal exists in this session.' }
      return {
        ok: true,
        goal: {
          id: goal.id,
          objective: goal.objective,
          status: goal.status,
          turnCount: goal.turnCount,
          maxTurns: goal.maxTurns,
          tokenBudget: goal.tokenBudget,
          remainingTokenBudget: remainingTokenBudget(goal, state),
          verifiers: goal.verifiers,
          latestVerification: goal.verificationResults.at(-1),
          pendingTransition: goal.pendingTransition,
          lastBlocker: goal.lastBlocker,
          repeatedBlockerCount: goal.repeatedBlockerCount,
          recentAttempts: goal.attempts.slice(-5),
        },
      }
    },
  })
}
