// @x-code-cli/core — MCP Resources surfaced as two built-in tools
//
// MCP "resources" are server-exposed data the model may want to pull
// (e.g. files exposed by filesystem-server, log entries, DB row dumps).
// Rather than auto-injecting every resource into the conversation
// (token-expensive, often irrelevant), we expose two tools:
//
//   - listMcpResources({ server? })  — enumerate URIs the model can fetch
//   - readMcpResource({ uri })       — fetch one by URI
//
// Both tools are defined without an `execute` function so the agent
// loop's processToolCalls dispatcher handles them — see
// BYPASS_LOOP_GUARD_HANDLERS in tool-execution.ts. They surface in the
// system prompt only when an MCP registry is configured (buildTools
// gates the inclusion).
import { tool } from 'ai'

import { z } from 'zod'

export const listMcpResources = tool({
  description: `List resources exposed by connected MCP servers.

Output one resource per line: "<uri>\t[<server>] <name> (<mimeType>)" with a description on the next indented line when present.

Use this BEFORE readMcpResource so you have a URI to read. If the model already knows the URI (e.g. from a previous list call), readMcpResource directly is fine.`,
  inputSchema: z.object({
    server: z
      .string()
      .optional()
      .describe('Optional server name to filter by. Omit to list resources from all servers.'),
  }),
  // No execute — handled in tool-execution.ts via BYPASS_LOOP_GUARD_HANDLERS.
})

export const readMcpResource = tool({
  description: `Read the contents of an MCP resource by its URI.

URIs come from listMcpResources. Text resources return their text directly; binary resources surface a one-line marker noting the omitted content.`,
  inputSchema: z.object({
    uri: z.string().describe('The resource URI to read, as returned by listMcpResources.'),
  }),
})
