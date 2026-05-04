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
  description: `Use this tool to track multi-step tasks. The user sees a live checklist (☐ ◼ ✔) above the spinner — it makes long tasks feel structured and gives them visibility into your plan.

## When to Use

- Multi-step tasks that involve 3+ logical steps
- Right after exitPlanMode is approved and you have an approved plan with several files / phases — translate the plan into todos before starting work
- The user gives multiple requests in one message ("do A, then B, then C")
- When you start a step (mark it \`in_progress\` BEFORE doing the work)
- When you finish a step (mark it \`completed\` IMMEDIATELY, not at the end)

## When NOT to Use

- Single-file edits, typos, trivial fixes — todos add ceremony with no benefit
- Pure Q&A or research questions
- Tasks doable in 1-2 obvious steps
- Conversational replies that don't involve concrete work

## Hard Rules

1. **Status values**: \`pending\` | \`in_progress\` | \`completed\` (exactly these three).
2. **Exactly ONE task in_progress at any time** — not zero, not two. The user reads the in_progress one as "what the agent is doing right now".
3. **Mark complete IMMEDIATELY after finishing** — don't batch completions at the end of the run. The user wants live feedback.
4. **Only mark complete when truly done** — if tests are failing, the implementation is partial, you hit an error, or you're going to follow up later: leave it as \`in_progress\` and add a NEW pending todo describing the unresolved part.
5. **Provide both \`content\` and \`activeForm\`**:
   - \`content\` is imperative: "Run tests", "Update auth handler"
   - \`activeForm\` is present-continuous: "Running tests", "Updating auth handler"
   - The activeForm is what shows in the live UI for the in_progress item.
6. **Pass the FULL list every call** — todoWrite REPLACES the list, not merges. Include unchanged items.
7. When you submit a list where every item is \`completed\`, the system auto-clears the checklist for you. No need to clear it manually.

## Example

User: "Refactor the auth system to use JWT and update the login flow"

After exploration / planning, on the first implementation turn:
\`\`\`
todoWrite({
  todos: [
    { content: "Read existing auth implementation",  activeForm: "Reading auth code",        status: "in_progress" },
    { content: "Add JWT signing/verification utility", activeForm: "Adding JWT utility",     status: "pending" },
    { content: "Update login handler",               activeForm: "Updating login",          status: "pending" },
    { content: "Update protected routes middleware", activeForm: "Updating middleware",     status: "pending" },
    { content: "Add tests for new auth flow",        activeForm: "Writing auth tests",      status: "pending" }
  ]
})
\`\`\`

After reading the code:
\`\`\`
todoWrite({
  todos: [
    { content: "Read existing auth implementation",  activeForm: "Reading auth code",        status: "completed" },
    { content: "Add JWT signing/verification utility", activeForm: "Adding JWT utility",     status: "in_progress" },
    ...rest stay pending
  ]
})
\`\`\`

After finishing all five (auto-cleared next call):
\`\`\`
todoWrite({ todos: [/* all five with status: "completed" */] })
\`\`\`

## Bad usage

User: "fix this typo in README"
You: <do not call todoWrite — single edit, no value in a checklist>

User: "what does X do?"
You: <do not call todoWrite — pure Q&A, no work to track>`,
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
              'Lifecycle state. Exactly one item should be in_progress at any time. Defaults to "pending" if omitted.',
            ),
        }),
      )
      .describe(
        'The complete updated todo list. Every call REPLACES the existing list — include all items even if unchanged.',
      ),
  }),
})
