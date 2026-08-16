// @x-code-cli/core — todoWrite tool (model-managed checklist, no execute — handled in agent loop)
import { tool } from 'ai'

import { z } from 'zod'

/** The model maintains a working checklist via this tool. Each call
 *  REPLACES the entire list (no merge / no delta) — the model is told
 *  to pass the full updated array every time, including unchanged items.
 *  When all items are completed, the agent loop auto-clears the list to
 *  free the live UI panel.
 *
 *  Storage: in-memory on `LoopState.todos`, mirrored to React state via
 *  `callbacks.onTodosUpdate`. Never persisted to disk (matches Claude
 *  Code) — checklists are session-scoped working memory, not records.
 *
 *  No `execute` field — the side-effect (mutating LoopState.todos and
 *  notifying the UI) is handled manually in `processToolCalls`. Same
 *  pattern as askUser / enterPlanMode. */
export const todoWrite = tool({
  description: `Replace the complete live checklist for work with at least three milestones. Include unchanged items and keep exactly one item in_progress until every item is completed. Update IMMEDIATELY after each milestone — mark items completed as soon as their work finishes, never batch completions at the end of the turn; a stale checklist is a mistake. Completed lists are automatically cleared. Skip for trivial work and pure research.`,
  inputSchema: z.object({
    explanation: z.string().optional().describe('Optional reason for the update.'),
    todos: z
      .array(
        z.object({
          content: z.string().optional().describe('Task label, such as "Run tests".'),
          activeForm: z.string().optional().describe('Active UI label, such as "Running tests".'),
          status: z.enum(['pending', 'in_progress', 'completed']).optional().describe('Lifecycle state.'),
        }),
      )
      .describe('Complete replacement list, including unchanged items.'),
  }),
})
