// @x-code/core — exitPlanMode tool (no execute — handled in agent loop)

import { tool } from 'ai'
import { z } from 'zod'

export const exitPlanMode = tool({
  description:
    'Signal that the plan is complete and ready for user review. The system will read the plan file and present it to the user.',
  inputSchema: z.object({}),
  // No execute — handled in agent loop (read plan file + present to user)
})
