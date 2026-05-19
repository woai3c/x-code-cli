// @x-code-cli/core — MCP public types
//
// Shared shapes used across the mcp/ subsystem. Kept dependency-free so the
// loader/registry/UI layers can import without circular hops back into the
// agent loop or CLI.

/** stdio-based MCP server (local subprocess). */
export interface McpStdioServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** First-connect timeout in ms. Default 30_000. */
  timeout?: number
  /** Default true. Setting to false skips the server entirely. */
  enabled?: boolean
}

/** Streamable HTTP MCP server (remote). */
export interface McpHttpServerConfig {
  url: string
  /** Static headers attached to every request (e.g. `X-Custom: foo`).
   *  OAuth `Authorization: Bearer ...` is added automatically — do NOT put
   *  the access token here, store it via the OAuth flow instead. */
  headers?: Record<string, string>
  timeout?: number
  enabled?: boolean
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig

/** Discriminator: tells stdio vs http servers apart at runtime. */
export function isStdioConfig(c: McpServerConfig): c is McpStdioServerConfig {
  return 'command' in c
}
export function isHttpConfig(c: McpServerConfig): c is McpHttpServerConfig {
  return 'url' in c
}

/** Per-server runtime status. UI reads this via /mcp list. */
export type McpServerStatus =
  | { kind: 'disabled' }
  | { kind: 'connecting' }
  | { kind: 'connected'; toolCount: number; resourceCount: number }
  | { kind: 'needs_auth'; authUrl?: string }
  | { kind: 'failed'; error: string }

/** One MCP tool, after name-mangling.
 *
 *  callableName is the model-facing name (<server>__<tool>);
 *  rawName is what we pass back to client.callTool — MCP servers don't
 *  know about our prefix scheme. */
export interface McpToolEntry {
  callableName: string
  rawName: string
  serverName: string
  description: string
  /** JSON Schema as received from the server. We pass it directly to the
   *  AI SDK via `jsonSchema(...)` — no zod conversion. */
  inputSchema: Record<string, unknown>
}

/** One MCP resource (data the server lets us pull). */
export interface McpResourceEntry {
  uri: string
  name: string
  description?: string
  mimeType?: string
  serverName: string
}

/** Result of calling an MCP tool — flattened from MCP's content-blocks
 *  into something we can shove into a tool_result message. The raw blocks
 *  are kept on the side in case a future UI wants images/audio. */
export interface McpCallResult {
  /** Text representation suitable for tool_result. */
  text: string
  /** True iff the server marked the call as an error (MCP `isError` flag). */
  isError: boolean
}
