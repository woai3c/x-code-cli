/** Extract the server block from either the wrapped x-code config shape or
 * the flat `.mcp.json` shape used by Claude Code plugins. When a wrapper key
 * exists its value is returned unchanged so schema validation can report a
 * precise error for malformed input. */
export function extractMcpServersBlock(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const obj = parsed as Record<string, unknown>
  if ('mcpServers' in obj) return obj.mcpServers
  return obj
}
