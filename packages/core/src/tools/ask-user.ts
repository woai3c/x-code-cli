// @x-code-cli/core — askUser tool (interactive question, no execute — handled via callback)
import { tool } from 'ai'

import { z } from 'zod'

export const askUser = tool({
  description: `Ask the user multiple-choice questions to gather information, clarify ambiguity, understand preferences, make decisions, or offer choices.

Usage notes:
- Users will always be able to select "Other" to provide custom text input.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Plan mode note: In plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?" or "Should I proceed?" — use exitPlanMode for plan approval. IMPORTANT: Do not reference "the plan" in your questions (e.g., "Do you have feedback about the plan?", "Does the plan look good?") because the user cannot see the plan in the UI until you call exitPlanMode. If you need plan approval, use exitPlanMode instead.`,
  inputSchema: z.object({
    question: z
      .string()
      .describe(
        'The complete question to ask the user. Should be clear, specific, and end with a question mark. Keep it to ONE short sentence — do NOT embed long markdown, lists, headings, or detailed explanations here; put tradeoff details in option descriptions instead. Example: "Which library should we use for date formatting?"',
      ),
    options: z
      .array(
        z.object({
          label: z
            .string()
            .describe(
              'The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.',
            ),
          description: z
            .string()
            .describe(
              'Explanation of what this option means or what will happen if chosen. Useful for providing context about tradeoffs or implications.',
            ),
        }),
      )
      .min(2)
      .max(4)
      .describe(
        'The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice. There should be no "Other" option — the UI auto-appends one as the last row, so adding your own creates a duplicate.',
      ),
  }),
  // No execute — handled through callback to trigger UI rendering
})
