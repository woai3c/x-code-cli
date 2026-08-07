// @x-code-cli/core — The `toolSearch` built-in: deferred-tool discovery
//
// A conditionally-registered tool (like task / activateSkill — NOT in the
// static toolRegistry). buildTools adds it for the top-level agent only, and
// only when there's a deferred catalog to search. It's always DIRECTLY loaded
// when present: it's the entry point that loads everything else, so deferring
// it would trap the model with no way out of the deferred set.
//
// Defined WITHOUT an `execute` so processToolCalls hand-dispatches it via
// BYPASS_LOOP_GUARD_HANDLERS (the model legitimately searches several times per
// task; the loop guard would only get in the way). The dispatch + catalog
// matching live in agent/tool-search/ — this file is just the leaf definition
// (zero agent-loop deps), keeping the same layering as the other tools/ files.
import { jsonSchema, tool } from 'ai'

export const TOOL_SEARCH_TOOL_NAME = 'toolSearch'

const DESCRIPTION = `Load deferred tools listed by name in the system prompt. Use capability keywords to find matches, or \`select:<exact_name>,<exact_name>\` when you know the names. Their schemas become callable on the next step. Do not search for tools already present in the current tool list.`

export const toolSearch = tool({
  description: DESCRIPTION,
  inputSchema: jsonSchema({
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Keywords to find deferred tools, or "select:<name>,<name>" to load exact tools by name.',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of tools to return (default 5).',
      },
    },
    required: ['query'],
    additionalProperties: false,
  }),
  // No execute — hand-dispatched in tool-execution.ts (BYPASS_LOOP_GUARD_HANDLERS).
})
