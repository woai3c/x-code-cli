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
  description: `Maintain the complete live checklist for a task with at least three logical milestones. Use it after an approved multi-phase plan or when the user asks for several concrete changes. Skip it for trivial edits, one- or two-step work, pure research, Q&A, and conversational replies.

Rules:
1. Every call replaces the entire list; include unchanged items.
2. Status is pending, in_progress, or completed. Keep exactly one item in_progress until the final all-completed update.
3. Mark the current milestone in_progress before work starts and update completed items at the next decision point. Do not mark work complete while tests fail or follow-up remains.
4. Use logical, verifiable milestones rather than individual tool calls or files.
5. Provide imperative content ("Run tests") and present-continuous activeForm ("Running tests").
6. An all-completed list is automatically cleared.

Example: [{ content: "Inspect auth flow", activeForm: "Inspecting auth flow", status: "completed" }, { content: "Update login handler", activeForm: "Updating login handler", status: "in_progress" }, { content: "Run auth tests", activeForm: "Running auth tests", status: "pending" }]`,
  // SCHEMA LENIENCY (deliberate): all three per-todo fields are
  // marked optional even though the tool description tells the model
  // they are required. Reason: weaker provider models (DeepSeek-flash,
  // GLM, Qwen, etc.) routinely drop one field per item — most often
  // `status` on the last "current" entry, sometimes `content` when
  // they think `activeForm` is enough. With strict requireds, Zod
  // rejects the whole call → SDK emits tool-error → assistant
  // tool_call with no result → next API turn fails with "tool must
  // be a response to tool_calls". Validating loosely and synthesising
  // sane defaults in the dispatch handler is dramatically more robust
  // than playing whack-a-mole with model output. Strong models
  // (Sonnet, Opus) still get the same rich description telling them
  // to provide all three fields.
  inputSchema: z.object({
    todos: z
      .array(
        z.object({
          content: z.string().optional().describe('Imperative phrasing of the task ("Run tests").'),
          activeForm: z
            .string()
            .optional()
            .describe(
              'Present-continuous phrasing ("Running tests"); shown in the live UI when this item is in_progress.',
            ),
          status: z
            .enum(['pending', 'in_progress', 'completed'])
            .optional()
            .describe(
              'Lifecycle state. Except for the final all-completed update, exactly one item should be in_progress in each active checklist. Defaults to "pending" if omitted.',
            ),
        }),
      )
      .describe(
        'The complete updated todo list. Every call REPLACES the existing list — include all items even if unchanged.',
      ),
  }),
})
