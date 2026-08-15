// @x-code-cli/core — enterPlanMode tool (mode switch, no execute — handled in agent loop)
import { tool } from 'ai'

import { z } from 'zod'

/** No execute field: the dispatcher owns approval and the mode transition. */
export const enterPlanMode = tool({
  description: `Request plan mode before a non-trivial implementation that has unclear requirements, architectural choices, or coordinated multi-file changes. Skip it for small explicit edits and research/Q&A. In plan mode, inspect the code, clarify material choices, write the proposed implementation to the session plan file, then call exitPlanMode for approval.`,
  inputSchema: z.object({
    topic: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .describe('Optional 3-5 word lowercase English filename slug, hyphen-separated.'),
  }),
})
