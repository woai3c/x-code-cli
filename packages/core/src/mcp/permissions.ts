// @x-code-cli/core — MCP tool permission gate
//
// Sits parallel to packages/core/src/permissions/index.ts (which gates
// built-in writeFile / edit / shell). MCP tools live in their own pool
// because:
//   - their names are runtime-discovered, can't be enumerated in a
//     static rules table;
//   - the user's "this MCP tool is fine, don't ask again" decision is
//     persisted per-tool to ~/.x-code/mcp-permissions.json, separate
//     from any per-shell-prefix allow rules.
//
// Default policy: every MCP tool starts at "ask" and stays there until
// the user picks "always allow". No name-based heuristics — MCP tools
// are too varied for `list_/read_/search_` style classification to be
// safe (some "list_*" tools mutate, some "create_*" tools are no-ops).
import fs from 'node:fs/promises'
import path from 'node:path'

import { debugLog, userXcodeDir } from '../utils.js'

function permissionsFile(): string {
  return path.join(userXcodeDir(), 'mcp-permissions.json')
}

interface StoreShape {
  alwaysAllow: string[]
}

/** In-memory mirror of the persisted file + a session-scoped set for
 *  "this session only" allows. The persisted set is loaded lazily on
 *  first check; the session set is cleared on construction and never
 *  written to disk. */
export class McpPermissionStore {
  private persisted: Set<string> | null = null
  private session = new Set<string>()

  /** Pre-load the persisted file. Optional — checks lazy-load anyway. */
  async preload(): Promise<void> {
    await this.ensurePersistedLoaded()
  }

  /** Returns true iff the user has already approved this tool (either
   *  by "always allow" persisted, or by "this session" in-memory). */
  async isApproved(callableName: string): Promise<boolean> {
    if (this.session.has(callableName)) return true
    await this.ensurePersistedLoaded()
    return this.persisted!.has(callableName)
  }

  /** Mark this tool approved for the rest of the session only.
   *  Not persisted. */
  approveForSession(callableName: string): void {
    this.session.add(callableName)
  }

  /** Mark this tool approved permanently — writes to disk. Failure to
   *  write is logged but never thrown; the worst case is the user has
   *  to click "always allow" again next session. */
  async approvePermanently(callableName: string): Promise<void> {
    await this.ensurePersistedLoaded()
    if (this.persisted!.has(callableName)) return
    this.persisted!.add(callableName)
    // Also reflect in the session set so the very next call doesn't
    // race the disk write.
    this.session.add(callableName)
    try {
      await this.writePersisted()
    } catch (err) {
      debugLog('mcp.perm-write-failed', String(err))
      // Best-effort: do NOT remove from in-memory set on failure —
      // the user explicitly said yes, honour that for the session.
    }
  }

  private async ensurePersistedLoaded(): Promise<void> {
    if (this.persisted !== null) return
    this.persisted = await readPersisted()
  }

  private async writePersisted(): Promise<void> {
    if (!this.persisted) return
    await fs.mkdir(userXcodeDir(), { recursive: true })
    const tmp = permissionsFile() + '.tmp'
    const payload: StoreShape = { alwaysAllow: [...this.persisted].sort() }
    // 0600 — readable only by the user. Same posture as mcp-auth.json
    // (and same caveat: Windows ignores the mode bits but file is in
    // ~/.x-code so practical leakage is limited to other apps running
    // as the same user).
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
    await fs.rename(tmp, permissionsFile())
  }
}

async function readPersisted(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(permissionsFile(), 'utf-8')
    const parsed = JSON.parse(raw) as StoreShape
    if (parsed && Array.isArray(parsed.alwaysAllow)) {
      return new Set(parsed.alwaysAllow.filter((s): s is string => typeof s === 'string'))
    }
  } catch {
    // missing / malformed — start with empty allow list, degrade to all-ask
  }
  return new Set<string>()
}

/** Pull "yes" / "always" / "no" out of the existing askPermission
 *  callback. The callback's contract returns one of those three strings;
 *  we map them to a structured choice for our own callers. */
export type McpPermissionDecision = 'allow-once' | 'allow-always' | 'deny'

export function classifyDecision(raw: 'yes' | 'always' | 'no'): McpPermissionDecision {
  if (raw === 'always') return 'allow-always'
  if (raw === 'yes') return 'allow-once'
  return 'deny'
}
