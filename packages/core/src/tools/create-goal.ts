import { tool } from 'ai'

import { z } from 'zod'

import { createGoal } from '../agent/goal/state.js'
import type { LoopState } from '../agent/loop-state.js'

export function createCreateGoalTool(state: LoopState) {
  return tool({
    description:
      'Create a durable goal only when the user explicitly asks for a goal. Ordinary tasks must not create goals implicitly.',
    inputSchema: z.object({
      objective: z.string(),
      maxTurns: z.number().optional(),
      tokenBudget: z.number().optional(),
    }),
    execute: async (input) => {
      const goal = createGoal(state, {
        objective: input.objective,
        maxTurns: input.maxTurns,
        tokenBudget: input.tokenBudget,
        createdBy: 'tool',
      })
      return { ok: true, goal }
    },
  })
}
