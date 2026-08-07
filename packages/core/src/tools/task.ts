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
function buildTaskToolDescription(registry: SubAgentRegistry): string {
  const agents = registry.list()
  const agentList = agents.map((a) => `  - ${a.name}: ${a.description}`).join('\n')

  return `Launch an isolated sub-agent for extensive multi-step work. It receives a fresh context and returns only its final conclusion, so delegation has meaningful prompt and latency overhead.

Available sub-agents:
${agentList}

Use it for broad exploration requiring more than 3-4 searches across many directories, structured code review, planning that requires 5+ files, or an investigation where only the conclusion belongs in the parent context. Do not use it for a known-symbol search, 1-3 specific files, single-file edits, direct questions, or work that fits in roughly three direct tool calls.

Prompt contract:
- Select a valid subagent_type and give a 3-5 word description.
- The prompt must stand alone: explain the goal and why it matters, exact paths or symbols, known findings, constraints, whether writes are allowed, and the desired output.
- Ask for concrete snippets, types, file:line references, or a concise length when those details matter. Do not delegate synthesis with vague instructions such as "use your findings to fix it."
- Trust a complete result and summarize it for the user; request a targeted follow-up only when specific facts are missing.

Independent read-only agents may run concurrently in one assistant message. Never run concurrent agents that can write the same files or resources.`
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
