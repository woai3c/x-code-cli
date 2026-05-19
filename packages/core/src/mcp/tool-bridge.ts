// @x-code-cli/core — MCP tool ↔ AI SDK adapter
//
// Two responsibilities:
//   1. Convert each McpToolEntry into an AI-SDK `tool({...})` definition
//      so streamText() advertises it to the model alongside built-ins.
//   2. Trim overlong server-supplied descriptions so they don't bloat
//      the system prompt / tool list.
//
// The tools are deliberately defined WITHOUT an `execute` function. The
// AI SDK then routes the model's tool_call into `result.toolCalls` and
// our `processToolCalls` dispatcher handles it manually — same path as
// shell / writeFile / edit. This is what lets us gate every MCP call
// through the permission + loop-guard machinery.
import { jsonSchema, tool } from 'ai'

import type { McpToolEntry } from './types.js'

/** Hard cap on the model-facing description length per tool.
 *  - 200 chars is plenty for "what does this tool do?" guidance.
 *  - Some MCP servers in the wild paste multi-paragraph docs into the
 *    description field; left unbounded these blow up the system prompt
 *    and chew through the prompt cache window.
 *  - Truncation is character-based, with an ellipsis marker so the model
 *    knows the string was clipped (the marker also doubles as a hint
 *    to server authors when they see their own description in /mcp tools). */
const DESCRIPTION_MAX_CHARS = 200

export function truncateDescription(input: string): string {
  if (input.length <= DESCRIPTION_MAX_CHARS) return input
  // Keep room for the ellipsis marker so the result is still <= cap.
  return input.slice(0, DESCRIPTION_MAX_CHARS - 1) + '…'
}

/** Adapt one MCP tool into an AI SDK Tool. No execute — we hand-dispatch
 *  in tool-execution. The schema is passed through as raw JSON Schema
 *  (the SDK has first-class support via `jsonSchema(...)` so we don't
 *  need a zod conversion step). */
export function bridgeMcpTool(entry: McpToolEntry) {
  return tool({
    description: truncateDescription(entry.description || `MCP tool from ${entry.serverName}`),
    // The SDK's jsonSchema() helper takes a JSON Schema object and
    // produces a Schema instance compatible with `tool()`. MCP servers
    // hand us back well-formed JSON Schema by spec, so no preprocessing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputSchema: jsonSchema(entry.inputSchema as any),
    // No execute — manual dispatch in tool-execution.ts gates the call
    // through permissions + loop-guard.
  })
}

/** Build the system-prompt-friendly view of every MCP tool — short
 *  description + the model-facing name. Used by `system-prompt.ts` to
 *  render the `## MCP Tools` section. */
export function toSystemPromptEntries(entries: readonly McpToolEntry[]) {
  return entries.map((e) => ({
    callableName: e.callableName,
    serverName: e.serverName,
    description: truncateDescription(e.description),
  }))
}
