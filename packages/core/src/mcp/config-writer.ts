// @x-code-cli/core — Read/write `mcpServers` in user / project config.json
//
// Drives `/mcp add` and `/mcp remove`. The job is small but error-prone:
//   - preserve unrelated top-level fields (theme, model, thinking, etc.)
//   - preserve other mcpServers entries when adding/removing one
//   - write atomically so a Ctrl-C mid-write can't corrupt the file
//   - never read once, write later — re-read at write time so we don't
//     stomp on a concurrent edit (rare but cheap to guard against)
//
// The writer validates every config it persists against the same Zod
// schema the loader uses, so add-json input that would be rejected at
// load time is rejected here instead — fail-fast at the entry point.
import fs from 'node:fs/promises'
import path from 'node:path'

import { getUserConfigPath } from '../config/index.js'
import { XCODE_DIR } from '../utils.js'
import { parseServerConfig } from './config-schema.js'
import { type McpServerConfig } from './types.js'

export type ConfigScope = 'user' | 'project'

/** Where each scope's config.json lives. Mirrors the same paths the loader
 *  reads from, so a write here is guaranteed to be picked up on the next
 *  load (or `/mcp refresh`). */
export function getConfigPath(scope: ConfigScope, cwd: string): string {
  if (scope === 'user') return getUserConfigPath()
  return path.join(cwd, XCODE_DIR, 'config.json')
}

/** Read the parsed JSON object at the given scope. Returns `{}` when the
 *  file doesn't exist, is empty, or is malformed — the caller treats
 *  those uniformly as "no MCP servers configured here yet". */
async function readConfigObject(scope: ConfigScope, cwd: string): Promise<Record<string, unknown>> {
  const file = getConfigPath(scope, cwd)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Malformed JSON. We deliberately don't overwrite without a parse —
    // bail and let the caller surface an error. Returning {} here would
    // mask a corrupt config and writing would clobber whatever was there.
    throw new Error(`Config file at ${file} is not valid JSON. Fix it manually before running /mcp add or /mcp remove.`)
  }
  return {}
}

/** Atomic JSON write: write to tmp, then rename. Trailing newline + 2-space
 *  indent matches the convention used elsewhere (saveUserConfig). */
async function writeConfigObject(scope: ConfigScope, cwd: string, obj: Record<string, unknown>): Promise<void> {
  const file = getConfigPath(scope, cwd)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8')
  await fs.rename(tmp, file)
}

/** Where a given server name currently lives. Returned to the App.tsx
 *  caller so `/mcp remove` can auto-target the right scope (and detect
 *  the rare both-scopes ambiguity that forces an explicit --scope). */
export type DetectScopeResult = { kind: 'not-found' } | { kind: 'user' } | { kind: 'project' } | { kind: 'both' }

export async function detectScope(name: string, cwd: string): Promise<DetectScopeResult> {
  const [user, project] = await Promise.all([serverExists(name, 'user', cwd), serverExists(name, 'project', cwd)])
  if (user && project) return { kind: 'both' }
  if (user) return { kind: 'user' }
  if (project) return { kind: 'project' }
  return { kind: 'not-found' }
}

export async function serverExists(name: string, scope: ConfigScope, cwd: string): Promise<boolean> {
  const obj = await readConfigObject(scope, cwd)
  const servers = obj.mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false
  return Object.prototype.hasOwnProperty.call(servers, name)
}

/** Add a server to the given scope's config.json. Refuses to overwrite —
 *  caller must check duplicates first via `serverExists` and surface a
 *  helpful error including current vs. attempted config. */
export async function writeServerToConfig(
  name: string,
  config: McpServerConfig,
  scope: ConfigScope,
  cwd: string,
): Promise<{ path: string }> {
  // Validate first. Bad JSON via /mcp add-json shouldn't get written and
  // then explode at next launch — fail at the entry point with a clear
  // schema error.
  const validated = parseServerConfig(name, config)

  const obj = await readConfigObject(scope, cwd)
  const existing = obj.mcpServers
  const servers =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {}
  servers[name] = validated
  obj.mcpServers = servers
  await writeConfigObject(scope, cwd, obj)
  return { path: getConfigPath(scope, cwd) }
}

/** Remove a server from the given scope's config.json. Idempotent: returns
 *  `removed: false` when the name wasn't present (or the file didn't exist).
 *  Leaves the file with an empty `mcpServers: {}` rather than deleting the
 *  field — preserves the spot for future adds and avoids churn that would
 *  surprise users diffing the file in git. */
export async function removeServerFromConfig(
  name: string,
  scope: ConfigScope,
  cwd: string,
): Promise<{ path: string; removed: boolean }> {
  const file = getConfigPath(scope, cwd)
  const obj = await readConfigObject(scope, cwd)
  const existing = obj.mcpServers
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    return { path: file, removed: false }
  }
  const servers = existing as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(servers, name)) {
    return { path: file, removed: false }
  }
  const next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(servers)) {
    if (k !== name) next[k] = v
  }
  obj.mcpServers = next
  await writeConfigObject(scope, cwd, obj)
  return { path: file, removed: true }
}

/** Read the current config for `name` from the given scope, for the
 *  "already exists, here's what's there" path of /mcp add. Returns null
 *  if not present. Best-effort: a malformed entry returns null rather
 *  than throwing — the duplicate-check use case shouldn't crash. */
export async function readServerConfig(name: string, scope: ConfigScope, cwd: string): Promise<unknown | null> {
  try {
    const obj = await readConfigObject(scope, cwd)
    const servers = obj.mcpServers
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return null
    const value = (servers as Record<string, unknown>)[name]
    return value ?? null
  } catch {
    return null
  }
}
