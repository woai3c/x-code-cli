// @x-code-cli/core — task tool (sub-agent dispatch)
//
// The tool definition has no `execute` — dispatch is handled manually
// in tool-execution.ts's handleToolCall, which calls runSubAgent.
// This is intentional: the task tool needs access to LoopState,
// AgentOptions, and callbacks that aren't available in the tool's
// execute context.
import { tool } from 'ai'
import { z } from 'zod'

import type { SubAgentRegistry } from '../agent/sub-agents/registry.js'

/** Build the task tool description dynamically from the registry.
 *  Called once per session when constructing the system prompt cache.
 *  The listing of available agents is embedded in the description so
 *  the model knows what subagent_type values are valid. */
export function buildTaskToolDescription(registry: SubAgentRegistry): string {
  const agents = registry.list()
  const agentList = agents
    .map((a) => `  - ${a.name}: ${a.description}`)
    .join('\n')

  return `Launch a sub-agent to handle a task in an isolated context. The sub-agent runs with its own message history and returns only its final conclusion — its intermediate tool calls never enter your context window, keeping the main conversation lean.

Available sub-agents:
${agentList}

## When to use

Use the task tool when intermediate tool output isn't worth keeping in your context:
- **Research / exploration**: open-ended questions about the codebase ("where is X defined", "find all callers of Y", "what test patterns does this project use")
- **Code review**: reviewing pending changes or specific files for bugs, security issues, style violations
- **Implementation planning**: designing an approach that requires reading many files before writing any
- **Multi-step investigation**: tasks that need 3+ tool calls whose raw output you don't need to see — only the conclusion matters

## When NOT to use

Do NOT delegate when a direct tool call is faster or when you need the result in-context:
- If you want to read a specific file, use readFile directly
- If you are searching for a specific symbol like "class Foo", use grep directly
- If you are searching code within 1-3 known files, use readFile directly
- Simple single-step tasks (typo fix, add a comment, run one command)
- Tasks where your immediate next step depends on the raw output — do them locally to keep the critical path moving
- The user asked a simple question you can answer directly

## Writing the prompt

Brief the sub-agent like a smart colleague who just walked into the room — it has zero prior context: hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- Include concrete details: file paths, function names, line numbers, error messages.
- If you need a short response, say so ("report in under 200 words").
- For lookups: hand over the exact command. For investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.

## Concurrency safety

NEVER launch multiple sub-agents in one turn if they could modify the same files or resources. Only run multiple sub-agents in parallel when their tasks are genuinely independent (e.g., two read-only research questions about different parts of the codebase).

## Example

<example>
user: "Can you check if there are any security issues in the auth module?"
assistant: I'll have the code reviewer check the auth module.
task({
  description: "Review auth module security",
  subagent_type: "code-reviewer",
  prompt: "Review the authentication module for security issues. The main auth code lives in src/auth/. Focus on: JWT token handling in src/auth/jwt.ts, session management in src/auth/session.ts, and the login endpoint in src/routes/login.ts. Check for: token expiration handling, secret storage, injection vulnerabilities, and missing input validation. Report a numbered punch list with severity and file:line references."
})
</example>

<example>
user: "Fix the typo in README"
<commentary>Do NOT use task — this is a single-step edit. Just use the edit tool directly.</commentary>
</example>

<example>
user: "What does the glob tool do?"
<commentary>Do NOT use task — this is a direct Q&A question you can answer from your own knowledge.</commentary>
</example>`
}

/** Create the task tool definition. Must be called with the registry
 *  so the description includes the available agent list. */
export function createTaskTool(registry: SubAgentRegistry) {
  return tool({
    description: buildTaskToolDescription(registry),
    inputSchema: z.object({
      description: z.string().describe('A short (3-5 words) description of the task'),
      subagent_type: z.string().describe(
        `Which sub-agent to use. Available: ${registry.names().join(', ')}`,
      ),
      prompt: z.string().describe(
        'The complete task instruction sent to the sub-agent. Be specific — the sub-agent has no prior context.',
      ),
    }),
    // No execute — handled manually in tool-execution.ts
  })
}
