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

  return `Launch a new agent to handle complex, multi-step tasks autonomously.

The task tool launches specialized sub-agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it. The sub-agent runs with its own message history and returns only its final conclusion — its intermediate tool calls never enter your context window, keeping the main conversation lean.

Available sub-agents:
${agentList}

When using the task tool, specify a subagent_type parameter to select which agent type to use.

When NOT to use the task tool:
- If you want to read a specific file path, use the readFile or glob tool instead of the task tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the grep tool instead of the task tool, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the readFile tool instead of the task tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- Each task invocation starts fresh — provide a complete task description.
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple task tool use content blocks. For example, if you need to launch both a code-reviewer agent and an explore agent in parallel, send a single message with both tool calls.
- NEVER launch multiple sub-agents in one turn if they could modify the same files or resources. Only run multiple sub-agents in parallel when their tasks are genuinely independent.

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
