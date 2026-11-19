// @x-code-cli/core — exitPlanMode tool (user-approval gate, no execute — handled in agent loop)
import { tool } from 'ai'

import { z } from 'zod'

/** Present the plan to the user for approval. The user sees a Yes/No
 *  dialog with the plan body inline; on Yes, the session leaves plan mode
 *  and the next turn can write code; on No, the session stays in plan
 *  mode and the model is told to revise.
 *
 *  No `execute` field — the dispatch path in `processToolCalls` reads the
 *  plan file, calls `callbacks.onPlanApprovalRequest(planText)`, and
 *  feeds the verdict back as a synthetic tool result so the model knows
 *  whether to proceed or iterate. */
export const exitPlanMode = tool({
  description:
    'Submit the completed plan file for user Yes/No approval to leave plan mode and enter acceptEdits implementation mode. If rejected, revise the plan file and call exitPlanMode again.',
  inputSchema: z.object({
    plan: z
      .string()
      .optional()
      .describe(
        'Optional override for the plan body. By default the plan body comes from the plan file you wrote during planning — only pass this argument if you want to use different content (rare).',
      ),
  }),
})
