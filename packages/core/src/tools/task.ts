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

  return `Launch an isolated sub-agent with a fresh context window and return only its final conclusion.

Available sub-agents:
${agentList}

Use direct tools for quick lookups or small edits. Delegate when broad exploration, upfront planning, or bounded implementation work benefits from an isolated context or parallel execution.

Prompt contract:
- Give a valid subagent_type, a 3-5 word description, and a self-contained prompt with the goal, target paths or symbols, known facts, scope boundaries, write permission, verification checks to run, and required output.
- Ask for concrete snippets or file:line references when needed, and trust a complete result instead of repeating its work.

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
