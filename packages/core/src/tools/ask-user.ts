// @x-code-cli/core — askUser tool (interactive question, no execute — handled via callback)
import { tool } from 'ai'

import { z } from 'zod'

export const askUser = tool({
  description:
    'Ask the user a clarifying question with multiple-choice options. Use when you need user input to decide between approaches. In **plan mode** this is also the primary "interview" tool — call it after every meaningful analysis or exploration to hand decision points back to the user with concrete next-step choices.',
  inputSchema: z.object({
    question: z.string().describe('The question to ask. Markdown is rendered.'),
    options: z
      .array(
        z.object({
          label: z.string().describe('Option label (1-8 words). Shown as the choice itself.'),
          description: z
            .string()
            .describe('One-line tradeoff or scope hint shown beneath the label.'),
        }),
      )
      .min(2)
      .max(6)
      .describe(
        'Choices. DO NOT include an "Other"/freeform/custom-input option — the UI auto-appends one as the last row, so adding your own creates a duplicate. 2-6 entries — for plan-mode interview menus 4-6 entries with both action options ("plan high-priority items") and meta options ("just discuss further") work best.',
      ),
  }),
  // No execute — through callback to trigger UI rendering
})
