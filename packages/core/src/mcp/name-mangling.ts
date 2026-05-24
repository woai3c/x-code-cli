// @x-code-cli/core — MCP tool name mangling
//
// We expose MCP tools to the model under namespaced names so they can't
// collide with built-in tools (readFile, shell, ...) and so the model
// can tell at a glance "this came from server X":
//
//     <server>__<tool>
//
// Both server and tool names are sanitised: any char outside
// [A-Za-z0-9_] becomes `_`. We pick `__` (double underscore) as the
// separator so a tool whose raw name contains a single underscore
// (very common — `read_file`, `list_issues`) is unambiguous.
//
// No `mcp__` umbrella prefix — Claude Code adds one (`mcp__<server>__<tool>`)
// but it burns tokens per-tool without telling the model anything the
// description doesn't already carry. Codex and Gemini CLI both omit the
// prefix; we follow them. "Is this tool MCP or built-in?" routing is a
// registry lookup in tool-execution.ts, not a name-prefix check.
//
// The model-facing tool name has a hard cap at 64 chars (OpenAI's
// historical limit; Anthropic/Google are higher but 64 keeps us
// portable). Over-length names are truncated and tagged with a 6-char
// content hash so two long, similar names still differ.
//
// Cross-server name collisions are rare in practice but possible
// (two servers both expose `read_file`). We resolve them by hashing
// the server name into a 4-char suffix on whichever entry was added
// second.
import { createHash } from 'node:crypto'

export const MCP_MAX_NAME_LEN = 64

function sanitize(part: string): string {
  // Replace any run of disallowed chars with a single `_`. Trim leading
  // / trailing underscores so we don't end up with `_server__tool_`.
  const cleaned = part.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  // Empty after sanitisation (e.g. all-CJK server name) → fall back to a
  // hash so we still produce a stable, valid identifier.
  if (cleaned === '') {
    return shortHash(part, 6)
  }
  return cleaned
}

function shortHash(input: string, len: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, len)
}

/** Build the model-facing tool name for one MCP tool.
 *
 *  `existing` is the set of names already taken in the current registry —
 *  if the new name collides, we append a 4-char hash of the server name
 *  to disambiguate. (Hashing the server, not the tool, is intentional:
 *  the tool name carries the semantic meaning the model relies on; the
 *  server name is the part the user picked, so the disambiguator is
 *  more meaningful keyed to it.) */
export function buildCallableName(serverName: string, rawToolName: string, existing: ReadonlySet<string>): string {
  const s = sanitize(serverName)
  const t = sanitize(rawToolName)

  let name = `${s}__${t}`

  // Over-length: truncate while preserving a content hash so
  // truncated-different names don't collapse to the same string.
  if (name.length > MCP_MAX_NAME_LEN) {
    const hash = shortHash(`${serverName}::${rawToolName}`, 6)
    const room = MCP_MAX_NAME_LEN - 1 /* underscore */ - hash.length
    name = `${(s + '__' + t).slice(0, room)}_${hash}`
  }

  // Collision: append a 4-char server-name hash. If THAT still collides
  // (theoretically possible across many servers), bump the hash length
  // until unique — bounded by MCP_MAX_NAME_LEN.
  if (existing.has(name)) {
    for (let extra = 4; extra <= 12; extra++) {
      const suffix = '_' + shortHash(serverName, extra)
      const candidate =
        name.length + suffix.length <= MCP_MAX_NAME_LEN
          ? name + suffix
          : name.slice(0, MCP_MAX_NAME_LEN - suffix.length) + suffix
      if (!existing.has(candidate)) {
        return candidate
      }
    }
    // Pathological: just append a random-ish suffix and hope.
    return name.slice(0, MCP_MAX_NAME_LEN - 9) + '_' + shortHash(name + Date.now(), 8)
  }

  return name
}
