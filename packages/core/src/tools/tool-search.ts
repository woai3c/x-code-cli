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

const DESCRIPTION = `Loads ("activates") deferred tools so you can call them.

Deferred tools are listed by NAME ONLY under "## Deferred Tools" in the system prompt — their schemas are not loaded until you load them here. Until then they cannot be called.

Pass \`query\` as either:
- keywords describing the capability you need (e.g. "search the web", "github create issue", "read mcp resource") — returns the best-matching deferred tools, or
- "select:<name>,<name>" to load specific tools by their EXACT name from the Deferred Tools list (prefer this when you already know the name).

The matched tools' full schemas are added to your tool set and become directly callable on your NEXT step. Core tools (readFile, writeFile, edit, shell, grep, glob, listDir, task) are always loaded — never search for those.`

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
