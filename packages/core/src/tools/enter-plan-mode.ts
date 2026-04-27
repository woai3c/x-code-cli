// @x-code-cli/core — enterPlanMode tool (mode switch, no execute — handled in agent loop)
import { tool } from 'ai'

import { z } from 'zod'

/** The tool description below is the heart of plan-mode auto-trigger
 *  behavior — it's what the model reads in the tool list and uses to
 *  decide whether to recommend plan mode. Ported (with naming
 *  adjustments for our tool surface) from Claude Code's
 *  `EnterPlanModeTool/prompt.ts` external-user prompt
 *  (`/d/res/claude-code/src/tools/EnterPlanModeTool/prompt.ts:16-99`).
 *
 *  WHY THIS IS LONG: a one-line description ("use for complex tasks")
 *  produces a model that almost never calls the tool — it has no
 *  concrete trigger pattern to match against the user's request. CC's
 *  prompt deliberately includes 7 numbered criteria, multiple worked
 *  examples per criterion, and an explicit "PREFER plan mode unless
 *  simple" anchor — that's what gets the model to actually recommend
 *  plan mode for refactors, new features, architectural decisions,
 *  etc. The token cost (~600 tokens in tool list each turn) is what
 *  buys the auto-trigger behavior; without it plan mode is dead UX.
 *
 *  No `execute` field — the side-effect (asking the user to confirm,
 *  mutating LoopState.permissionMode, invalidating the system-prompt
 *  cache) is handled manually in `processToolCalls`. Same pattern as
 *  `askUser`. */
export const enterPlanMode = tool({
  description: `Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

## When to Use This Tool

**Prefer using enterPlanMode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:

1. **New Feature Implementation**: Adding meaningful new functionality
   - Example: "Add a logout button" - where should it go? What should happen on click?
   - Example: "Add form validation" - what rules? What error messages?

2. **Multiple Valid Approaches**: The task can be solved in several different ways
   - Example: "Add caching to the API" - could use Redis, in-memory, file-based, etc.
   - Example: "Improve performance" - many optimization strategies possible

3. **Code Modifications**: Changes that affect existing behavior or structure
   - Example: "Update the login flow" - what exactly should change?
   - Example: "Refactor this component" - what's the target architecture?

4. **Architectural Decisions**: The task requires choosing between patterns or technologies
   - Example: "Add real-time updates" - WebSockets vs SSE vs polling
   - Example: "Implement state management" - Redux vs Context vs custom solution

5. **Multi-File Changes**: The task will likely touch more than 2-3 files
   - Example: "Refactor the authentication system"
   - Example: "Add a new API endpoint with tests"

6. **Unclear Requirements**: You need to explore before understanding the full scope
   - Example: "Make the app faster" - need to profile and identify bottlenecks
   - Example: "Fix the bug in checkout" - need to investigate root cause

7. **User Preferences Matter**: The implementation could reasonably go multiple ways
   - If you would use askUser to clarify the approach, use enterPlanMode instead
   - Plan mode lets you explore first, then present options with context

## When NOT to Use This Tool

Only skip enterPlanMode for simple tasks:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- Adding a single function with clear requirements
- Tasks where the user has given very specific, detailed instructions
- Pure research / "what does X do" questions — just answer them directly

## What Happens in Plan Mode

In plan mode, you'll:
1. Thoroughly explore the codebase using readFile, glob, grep, and listDir
2. Understand existing patterns and architecture
3. Design an implementation approach
4. Use askUser to clarify approaches with the user when needed
5. Write the plan incrementally to a session-scoped plan file
6. Exit plan mode with exitPlanMode when ready to implement

## Examples

### GOOD - Use enterPlanMode:
User: "Add user authentication to the app"
- Requires architectural decisions (session vs JWT, where to store tokens, middleware structure)

User: "Optimize the database queries"
- Multiple approaches possible, need to profile first, significant impact

User: "Implement dark mode"
- Architectural decision on theme system, affects many components

User: "Add a delete button to the user profile"
- Seems simple but involves: where to place it, confirmation dialog, API call, error handling, state updates

User: "Update the error handling in the API"
- Affects multiple files, user should approve the approach

### BAD - Don't use enterPlanMode:
User: "Fix the typo in the README"
- Straightforward, no planning needed

User: "Add a console.log to debug this function"
- Simple, obvious implementation

User: "What files handle routing?"
- Research / Q&A task, not implementation — just answer

## Important Notes

- This tool REQUIRES user approval — they must consent to entering plan mode (an approval dialog appears).
- If unsure whether to use it, err on the side of planning — it's better to get alignment upfront than to redo work.
- Do not call enterPlanMode if you are already in plan mode (check the system prompt; if you see plan-mode instructions you are already in it).`,
  inputSchema: z.object({
    topic: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .describe(
        'STRONGLY RECOMMENDED. A 3-5 word English filename slug summarizing the user\'s task. Lowercase, hyphen-separated, no spaces or special chars. The plan file is named `<topic>-<YYYYMMDD-HHMMSS>.md` so this makes the file identifiable in `ls .x-code/plans/`. Translate non-English requests into English keywords (e.g. user asks "重构这个项目" → topic: "refactor-x-code-cli"; user asks "加 OAuth 登录" → topic: "add-oauth-login"). Omit only when you genuinely cannot summarize — the file then falls back to timestamp-only naming.',
      ),
  }),
})
