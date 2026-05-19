// @x-code-cli/core — Slash-command argument parser for /mcp add/add-json/remove
//
// Slash commands deliver one raw string (the text after `/mcp <sub>`) and we
// have to coerce that into a structured McpServerConfig. The parser is
// deliberately narrow:
//   - one entry point per subcommand (parseAdd / parseAddJson / parseRemove)
//   - returns a tagged ParseResult so the App.tsx caller branches once and
//     gets either a usable command or a one-line error string
//
// Quoting rules we honour, intentionally minimal:
//   - "double-quoted" and 'single-quoted' strings keep whitespace
//   - backslash escapes ONLY whitespace and quote chars (and itself) —
//     `\ ` for a literal space, `\"` for a literal quote, `\\` for a
//     literal backslash. Backslash before anything else passes through
//     verbatim. This is critical on Windows where users routinely paste
//     paths like `D:\res\x-code-cli\tmp` — full POSIX-style escape would
//     eat all those backslashes and silently corrupt the path.
//   - everything else: whitespace splits tokens
//
// Why we don't lean on a shell-words npm package: the surface here is
// small, and a 50-line tokeniser keeps the parser entirely deterministic
// for tests + free of cross-platform shell-escaping surprises.
import type { McpHttpServerConfig, McpServerConfig, McpStdioServerConfig } from './types.js'

export type ConfigScope = 'user' | 'project'

export interface AddCommand {
  kind: 'add'
  name: string
  scope: ConfigScope
  config: McpServerConfig
}

export interface AddJsonCommand {
  kind: 'add-json'
  name: string
  scope: ConfigScope
  config: McpServerConfig
}

export interface RemoveCommand {
  kind: 'remove'
  name: string
  /** Undefined when the user didn't pass --scope; caller auto-detects. */
  scope?: ConfigScope
}

export type ParsedCommand = AddCommand | AddJsonCommand | RemoveCommand

export type ParseResult<T extends ParsedCommand = ParsedCommand> =
  | { ok: true; command: T }
  | { ok: false; error: string }

/** Names allowed in `mcpServers.<name>`. Tightened relative to the runtime
 *  name-mangling sanitizer because *config entry point* is a better place
 *  to refuse weird names — surprising sanitisation post-add ("I typed
 *  `my server!` and got `my_server___xxx`") is worse than a clear
 *  rejection. Length 32 leaves headroom for the `{server}__{tool}`
 *  format to stay well under the model-side 64-char tool name limit. */
const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/

// ── Top-level entry points ─────────────────────────────────────────────────

/** Parse args for `/mcp add [...flags] <name> <command-or-url> [args...]`. */
export function parseAdd(rawArg: string): ParseResult<AddCommand> {
  const tokRes = tokenize(rawArg)
  if (!tokRes.ok) return tokRes
  const tokens = tokRes.tokens

  // First pass: pull flags off the front. Stop at the first non-flag token
  // (which becomes the server name); the `--` separator hard-stops flag
  // parsing and is then dropped — everything after is positional.
  let isHttp = false
  let scope: ConfigScope = 'user'
  let timeout: number | undefined
  const envEntries: Array<[string, string]> = []
  const headerEntries: Array<[string, string]> = []

  let i = 0
  let sawDoubleDash = false
  while (i < tokens.length) {
    const t = tokens[i]!
    if (!t.startsWith('-')) break // first positional
    if (t === '--') {
      sawDoubleDash = true
      i++
      break
    }
    if (t === '--http' || t === '--transport') {
      // --http is our shorthand; --transport <name> is Claude/Gemini syntax
      // (we accept only http here; sse is intentionally not supported per
      // the design doc — MCP spec deprecated SSE in 2025-03).
      if (t === '--transport') {
        const next = tokens[i + 1]
        if (next !== 'http') {
          return err(
            `--transport only supports "http" (got ${next ?? '(missing)'}); use --http directly or omit for stdio`,
          )
        }
        i += 2
      } else {
        i++
      }
      isHttp = true
      continue
    }
    if (t === '--scope') {
      const v = tokens[i + 1]
      if (v !== 'user' && v !== 'project') {
        return err(`--scope requires "user" or "project" (got ${v ?? '(missing)'})`)
      }
      scope = v
      i += 2
      continue
    }
    if (t === '--env') {
      const v = tokens[i + 1]
      if (typeof v !== 'string') return err('--env requires a KEY=VALUE argument')
      const eq = v.indexOf('=')
      if (eq <= 0) return err(`--env expects KEY=VALUE (got ${v})`)
      envEntries.push([v.slice(0, eq), v.slice(eq + 1)])
      i += 2
      continue
    }
    if (t === '--header') {
      const v = tokens[i + 1]
      if (typeof v !== 'string') return err('--header requires a "Key: value" argument')
      // Header format: "Key: Value" (RFC 7230 style). Be permissive with
      // whitespace around the colon to match user habit.
      const colon = v.indexOf(':')
      if (colon <= 0) return err(`--header expects "Key: Value" (got ${v})`)
      headerEntries.push([v.slice(0, colon).trim(), v.slice(colon + 1).trim()])
      i += 2
      continue
    }
    if (t === '--timeout') {
      const v = tokens[i + 1]
      if (typeof v !== 'string') return err('--timeout requires a number (ms)')
      const n = Number(v)
      if (!Number.isInteger(n) || n <= 0) return err(`--timeout requires a positive integer (got ${v})`)
      timeout = n
      i += 2
      continue
    }
    return err(`Unknown flag: ${t}`)
  }

  // Positional args. After the (optional) `--`, everything left is name +
  // command/url + the rest. Stdio: tokens[i] = name, tokens[i+1] = command,
  // tokens[i+2..] = args. HTTP: tokens[i] = name, tokens[i+1] = url, nothing
  // after.
  //
  // Users coming from Claude Code muscle-memory write `add <name> -- <cmd>`
  // with the separator AFTER the name. Our flag loop already stops at the
  // first non-flag (the name), so any `--` lands at positional[1]. Drop it
  // — it's cosmetic, the actual command follows.
  let positional = tokens.slice(i)
  if (positional[1] === '--') {
    positional = [positional[0]!, ...positional.slice(2)]
  }
  if (positional.length < 2) {
    return err(
      isHttp
        ? 'Usage: /mcp add --http [--scope user|project] [--header "K: V"]... [--timeout N] <name> <url>'
        : 'Usage: /mcp add [--scope user|project] [--env K=V]... [--timeout N] <name> <command> [args...]',
    )
  }
  const name = positional[0]!
  if (!NAME_RE.test(name)) {
    return err(`Invalid server name "${name}". Must match ${NAME_RE.source}.`)
  }

  if (isHttp) {
    if (positional.length > 2) {
      return err('HTTP servers take only <name> <url> — no extra positional args')
    }
    if (envEntries.length > 0) return err('--env is only valid for stdio servers')
    const url = positional[1]!
    if (!isValidUrl(url)) return err(`Invalid URL: ${url}`)
    const config: McpHttpServerConfig = {
      url,
      ...(headerEntries.length > 0 ? { headers: Object.fromEntries(headerEntries) } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    }
    return ok({ kind: 'add', name, scope, config })
  }

  // stdio. `--` is allowed but optional. Some users will write
  // `/mcp add fs npx -y @pkg/foo /tmp`, others `/mcp add fs -- npx -y ...`.
  // Both reach this branch identically — we already stripped `--` upstream.
  void sawDoubleDash
  if (headerEntries.length > 0) return err('--header is only valid for HTTP servers (--http)')
  const command = positional[1]!
  const args = positional.slice(2)
  const config: McpStdioServerConfig = {
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(envEntries.length > 0 ? { env: Object.fromEntries(envEntries) } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  }
  return ok({ kind: 'add', name, scope, config })
}

/** Parse args for `/mcp add-json [--scope ...] <name> '<json>'`.
 *  The JSON blob is whatever the schema accepts — same validation runs
 *  on the loader side, so passing parseServerConfig here keeps errors
 *  uniform between "wrote it via CLI" and "edited the file by hand". */
export function parseAddJson(rawArg: string): ParseResult<AddJsonCommand> {
  // add-json uniquely benefits from KEEPING the JSON literal intact rather
  // than running it through the shell tokeniser (which would mangle nested
  // quotes). Strategy: pull flags + name off the front via tokenize on the
  // *prefix* up to where the JSON begins, then take the JSON as the
  // suffix verbatim. We find the JSON start by looking for the first `{`
  // after the name token.

  const trimmed = rawArg.trim()
  if (!trimmed) {
    return err("Usage: /mcp add-json [--scope user|project] <name> '<json>'")
  }

  // Walk through tokens until we either run out of flags/name OR hit a
  // token starting with `{`. The JSON blob may have been entered single-
  // quoted to the slash command — in that case the tokeniser strips the
  // quotes and we get a clean object string. If unquoted, the user
  // shouldn't have nested whitespace anyway, so a single token suffices.
  const tokRes = tokenize(trimmed)
  if (!tokRes.ok) return tokRes
  const tokens = tokRes.tokens

  let scope: ConfigScope = 'user'
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]!
    if (t === '--scope') {
      const v = tokens[i + 1]
      if (v !== 'user' && v !== 'project') {
        return err(`--scope requires "user" or "project" (got ${v ?? '(missing)'})`)
      }
      scope = v
      i += 2
      continue
    }
    if (!t.startsWith('-')) break
    return err(`Unknown flag for add-json: ${t}`)
  }

  if (i >= tokens.length) {
    return err("Usage: /mcp add-json [--scope user|project] <name> '<json>'")
  }
  const name = tokens[i]!
  if (!NAME_RE.test(name)) {
    return err(`Invalid server name "${name}". Must match ${NAME_RE.source}.`)
  }
  i++

  // The JSON might have been split across tokens if the user didn't quote
  // it. Concatenate the remainder with single spaces; JSON parsing tolerates
  // any whitespace between tokens so this round-trips fine in practice.
  if (i >= tokens.length) {
    return err(`Missing JSON body for "${name}". Wrap it in single quotes: '{...}'`)
  }
  const jsonBlob = tokens.slice(i).join(' ').trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonBlob)
  } catch (e) {
    return err(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }

  // We validate via the same zod schema the loader uses, but we keep the
  // dependency in the writer layer to avoid a circular import here — so
  // signal "needs validation" by returning the parsed object as
  // McpServerConfig and letting the caller validate. The writer DOES
  // validate before writing (see config-writer.ts).
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return err('JSON body must be an object')
  }
  return ok({ kind: 'add-json', name, scope, config: parsed as McpServerConfig })
}

/** Parse args for `/mcp remove [--scope ...] <name>`. */
export function parseRemove(rawArg: string): ParseResult<RemoveCommand> {
  const tokRes = tokenize(rawArg)
  if (!tokRes.ok) return tokRes
  const tokens = tokRes.tokens
  if (tokens.length === 0) {
    return err('Usage: /mcp remove [--scope user|project] <name>')
  }

  let scope: ConfigScope | undefined
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]!
    if (t === '--scope') {
      const v = tokens[i + 1]
      if (v !== 'user' && v !== 'project') {
        return err(`--scope requires "user" or "project" (got ${v ?? '(missing)'})`)
      }
      scope = v
      i += 2
      continue
    }
    if (!t.startsWith('-')) break
    return err(`Unknown flag for remove: ${t}`)
  }

  if (i >= tokens.length) {
    return err('Usage: /mcp remove [--scope user|project] <name>')
  }
  if (i + 1 < tokens.length) {
    return err(`/mcp remove takes exactly one name (got extra: ${tokens.slice(i + 1).join(' ')})`)
  }
  const name = tokens[i]!
  if (!NAME_RE.test(name)) {
    return err(`Invalid server name "${name}". Must match ${NAME_RE.source}.`)
  }
  return ok({ kind: 'remove', name, scope })
}

// ── Internals ──────────────────────────────────────────────────────────────

function ok<T extends ParsedCommand>(command: T): ParseResult<T> {
  return { ok: true, command }
}
function err(message: string): { ok: false; error: string } {
  return { ok: false, error: message }
}

/** Minimal POSIX-ish tokeniser. Supports "..."/'...' quoting and
 *  backslash-escape of any single char. Quotes are stripped from the
 *  output; escapes drop the backslash. Returns a tagged result so the
 *  caller can surface "unclosed quote" without throwing. */
export function tokenize(input: string): { ok: true; tokens: string[] } | { ok: false; error: string } {
  const tokens: string[] = []
  let i = 0
  const n = input.length

  while (i < n) {
    // Skip whitespace between tokens.
    while (i < n && /\s/.test(input[i]!)) i++
    if (i >= n) break

    let token = ''
    let quote: '"' | "'" | null = null
    let inToken = true

    while (i < n && inToken) {
      const c = input[i]!
      if (quote) {
        if (c === '\\' && quote === '"' && i + 1 < n) {
          // Inside double quotes, allow backslash escape for " and \.
          const next = input[i + 1]!
          if (next === '"' || next === '\\') {
            token += next
            i += 2
            continue
          }
          // Otherwise keep the backslash literal — POSIX behaviour.
          token += c
          i++
          continue
        }
        if (c === quote) {
          quote = null
          i++
          continue
        }
        token += c
        i++
        continue
      }
      // Unquoted.
      if (c === '"' || c === "'") {
        quote = c
        i++
        continue
      }
      if (c === '\\' && i + 1 < n) {
        // Only escape whitespace, quotes, and backslash itself. Anything
        // else passes through with the backslash intact so Windows paths
        // like `D:\res\x-code-cli\tmp` survive — eating those backslashes
        // would silently corrupt the path and the user wouldn't notice
        // until the MCP server failed to access the directory.
        const next = input[i + 1]!
        if (next === ' ' || next === '\t' || next === '"' || next === "'" || next === '\\') {
          token += next
          i += 2
          continue
        }
        // Backslash followed by anything else: keep both chars literal.
        token += c
        i++
        continue
      }
      if (/\s/.test(c)) {
        inToken = false
        break
      }
      token += c
      i++
    }
    if (quote) {
      return { ok: false, error: `Unclosed ${quote} quote` }
    }
    tokens.push(token)
  }
  return { ok: true, tokens }
}

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
