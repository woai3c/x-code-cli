// @x-code-cli/core — enterPlanMode tool (no execute — handled in agent loop)
import { tool } from 'ai'

import { z } from 'zod'

export const enterPlanMode = tool({
  description: `Enter plan mode for exploring the codebase and designing an implementation plan.
Use proactively for non-trivial tasks: new features, multi-file changes, architectural decisions, unclear requirements.
Skip for: single-line fixes, obvious bugs, specific user instructions.`,
  inputSchema: z.object({
    topic: z
      .string()
      .describe(
        'Short 3-6 word description of what this plan addresses, used to name the plan file (e.g. "refactor auth middleware", "add dark mode toggle"). Use plain words; no punctuation needed.',
      ),
  }),
  // No execute — handled in agent loop (inject plan mode prompt + wait for user consent)
})
