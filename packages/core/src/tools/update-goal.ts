import { tool } from 'ai'

import { z } from 'zod'

import { requestGoalBlocked, requestGoalComplete } from '../agent/goal/state.js'
import type { LoopState } from '../agent/loop-state.js'

export function createUpdateGoalTool(state: LoopState) {
  return tool({
    description:
      'Request terminal progress for the current durable goal. This does not directly mark the goal complete; the host verifies completion first.',
    inputSchema: z.object({
      status: z.enum(['complete', 'blocked']).describe('Request completion verification or report a repeated blocker.'),
      evidence: z.string().optional().describe('Concrete completion evidence, required for status=complete.'),
      summary: z.string().optional().describe('Concise summary of the current result.'),
      blocker: z.string().optional().describe('External blocker, required for status=blocked.'),
    }),
    execute: async (input, runOptions) => {
      if (input.status === 'complete') {
        const transition = requestGoalComplete(state, {
          evidence: input.evidence ?? '',
          summary: input.summary,
          requestedByToolCallId: runOptions.toolCallId,
        })
        return {
          ok: true,
          status: 'completion_requested',
          message: 'Completion requested. Host verification will decide whether the goal becomes complete.',
          transition,
        }
      }

      const transition = requestGoalBlocked(state, {
        blocker: input.blocker ?? '',
        evidence: input.evidence,
        summary: input.summary,
        requestedByToolCallId: runOptions.toolCallId,
      })
      return {
        ok: true,
        status: 'blocked_requested',
        message: 'Blocked state requested. The host accepts blocked only after the same blocker repeats.',
        transition,
      }
    },
  })
}
