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
  const agentList = agents.map((a) => `  - ${a.name}: ${a.description}`).join('\n')

  return `Launch a sub-agent to handle tasks that genuinely require extensive, multi-step work.

Sub-agents run with their own message history and return only their final conclusion — intermediate tool calls never enter your context window, keeping the main conversation lean. However, each sub-agent invocation has significant overhead (fresh context, separate cache, extra system prompt tokens). A task completable with 2-3 direct tool calls is always faster and cheaper than delegating.

Available sub-agents:
${agentList}

When using the task tool, specify a subagent_type parameter to select which agent type to use.

## When NOT to use the task tool
- Tasks completable in 3 or fewer tool calls — just do them directly
- Reading a specific file — use readFile directly
- Searching for a known symbol like "class Foo" — use grep directly
- Searching within 1-3 known files — use readFile directly
- Questions answerable from files you've already read in this conversation
- Direct questions you can answer from your own knowledge
- Single-file edits, trivial fixes, or any task with an obvious direct path

## When to use the task tool
- Broad codebase exploration requiring 4+ searches across many directories, AFTER direct search proved insufficient
- Code review of pending changes (structured reviewer output)
- Implementation planning requiring 5+ files to read
- Multi-step investigation where only the conclusion matters

## Usage notes
- Always include a short description (3-5 words) summarizing what the agent will do
- Launch multiple agents concurrently when their tasks are genuinely independent; use a single message with multiple tool uses
- The result is not visible to the user — summarize it back in a text message
- Each task invocation starts fresh — provide a complete task description
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple task tool use content blocks
- NEVER launch multiple sub-agents in one turn if they could modify the same files or resources

## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.

Example usage:

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
user: "Where is the database connection configured?"
<commentary>Do NOT use task — a single grep for "database" or "connection" will find it. Use grep directly.</commentary>
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
      subagent_type: z.string().describe(`Which sub-agent to use. Available: ${registry.names().join(', ')}`),
      prompt: z
        .string()
        .describe(
          'The complete task instruction sent to the sub-agent. Be specific — the sub-agent has no prior context.',
        ),
    }),
    // No execute — handled manually in tool-execution.ts
  })
}
