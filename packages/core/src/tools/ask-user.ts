// @x-code/core — askUser tool (interactive question, no execute — handled via callback)

import { tool } from 'ai'
import { z } from 'zod'

export const askUser = tool({
  description:
    'Ask the user a clarifying question with multiple-choice options. Use when you need user input to decide between approaches.',
  inputSchema: z.object({
    question: z.string().describe('The question to ask'),
    options: z
      .array(
        z.object({
          label: z.string().describe('Option label (1-5 words)'),
          description: z.string().describe('What this option means'),
        }),
      )
      .min(2)
      .max(4)
      .describe('Choices (an "Other" option is auto-appended)'),
  }),
  // No execute — through callback to trigger UI rendering
})
