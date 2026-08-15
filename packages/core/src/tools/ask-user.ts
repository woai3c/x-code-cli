// @x-code-cli/core — askUser tool (interactive question, no execute — handled via callback)
import { tool } from 'ai'

import { z } from 'zod'

export const askUser = tool({
  description:
    'Ask one short multiple-choice question when a decision cannot be resolved from context. The UI adds an Other option. Put a recommended choice first and suffix its label with "(Recommended)".',
  inputSchema: z.object({
    question: z.string().describe('One clear, specific sentence ending with a question mark.'),
    options: z
      .array(
        z.object({
          label: z.string().describe('Concise display label (1-5 words).'),
          description: z.string().describe('One short sentence explaining impact or tradeoff.'),
        }),
      )
      .min(2)
      .max(4)
      .describe('Two to four mutually exclusive choices; do not add Other.'),
  }),
  // No execute — handled through callback to trigger UI rendering
})
