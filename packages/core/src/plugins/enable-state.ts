// @x-code-cli/core — Plugin enable/disable state
//
// Reads the per-scope `enabledPlugins` map from settings.json files and
// resolves the effective enabled state for each plugin id.
//
// Two-scope model, mirroring mcp + skill subsystems:
//
//   user     ~/.x-code/settings.json
//   project  <cwd>/.x-code/settings.local.json   (gitignored)
//
// `'project'` reading a `.local.json` file is a slight naming quirk we
// inherit from skills — it's a per-user override for one repo, not a
// team-shared file. A separate team-shared scope (committed) can be
// added later without touching the existing two.
//
// Map shape: `{ "name@marketplace": true | false }` — true = enabled,
// false = explicitly disabled, missing = use the project-wide default
// (currently `true`, i.e. default-enable).
//
// Precedence: project > user. An explicit value in a higher-priority
// scope wins; a missing entry falls through.
import fs from 'node:fs/promises'
import path from 'node:path'

import { XCODE_DIR, userXcodeDir } from '../utils.js'
import type { PluginScope } from './types.js'

/** Highest precedence first. The first scope with an explicit entry wins. */
const SCOPE_PRECEDENCE: ReadonlyArray<PluginScope> = ['project', 'user']

/** Default enabled state when no scope mentions the plugin. We default
 *  to ENABLED so newly-installed plugins work out-of-the-box; users who
 *  want opt-in behaviour can flip individual plugins off explicitly. */
const DEFAULT_ENABLED = true

interface PluginSettingsFile {
  enabledPlugins?: Record<string, boolean>
}

export function settingsPathForScope(scope: PluginScope, cwd: string = process.cwd()): string {
  if (scope === 'user') return path.join(userXcodeDir(), 'settings.json')
  return path.join(cwd, XCODE_DIR, 'settings.local.json')
}

async function readSettings(scope: PluginScope, cwd: string): Promise<PluginSettingsFile> {
  const file = settingsPathForScope(scope, cwd)
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const obj = parsed as Record<string, unknown>
    if (obj.enabledPlugins && typeof obj.enabledPlugins === 'object' && !Array.isArray(obj.enabledPlugins)) {
      // Coerce values to boolean defensively — settings.json may have been
      // hand-edited and the wrong type here shouldn't crash the loader.
      const out: Record<string, boolean> = {}
      for (const [k, v] of Object.entries(obj.enabledPlugins)) {
        if (typeof v === 'boolean') out[k] = v
      }
      return { enabledPlugins: out }
    }
    return {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    // Malformed JSON: ignore + return empty so a broken settings file never
    // blocks startup. The user can fix the file and re-launch.
    return {}
  }
}

/** Resolved per-plugin enable state, plus which scope decided it (for
 *  `/plugin doctor`). When `decidedBy` is `undefined`, no scope mentioned
 *  the plugin and the default applied. */
export interface ResolvedEnableState {
  enabled: boolean
  decidedBy: PluginScope | undefined
}

export class EnableState {
  private constructor(private readonly perScope: Map<PluginScope, Record<string, boolean>>) {}

  /** Load both settings files and build a snapshot. The snapshot is
   *  intentionally immutable from this point — callers re-load via
   *  `EnableState.load()` after settings.json writes. `cwd` defaults to
   *  `process.cwd()` and controls where the `'project'` scope file is
   *  read from. */
  static async load(cwd: string = process.cwd()): Promise<EnableState> {
    const map = new Map<PluginScope, Record<string, boolean>>()
    for (const scope of SCOPE_PRECEDENCE) {
      const s = await readSettings(scope, cwd)
      map.set(scope, s.enabledPlugins ?? {})
    }
    return new EnableState(map)
  }

  /** Effective enabled state for one plugin id. */
  resolve(pluginId: string): ResolvedEnableState {
    for (const scope of SCOPE_PRECEDENCE) {
      const table = this.perScope.get(scope) ?? {}
      if (pluginId in table) {
        return { enabled: table[pluginId]!, decidedBy: scope }
      }
    }
    return { enabled: DEFAULT_ENABLED, decidedBy: undefined }
  }

  /** Raw map for one scope — used by `/plugin list` to show the per-scope
   *  flags alongside the effective state. */
  scopeEntries(scope: PluginScope): Record<string, boolean> {
    return { ...(this.perScope.get(scope) ?? {}) }
  }
}

// ── Mutating writes (used by /plugin enable|disable|install) ────────────

/** Write a single plugin's enable flag in the chosen scope. Read-modify-
 *  write so unrelated fields in settings.json (e.g. `disabledSkills` from
 *  the skill subsystem) aren't clobbered. Returns whether the file
 *  actually changed (so callers can render an accurate
 *  "already enabled" vs "enabled" message). */
export async function setPluginEnabled(
  pluginId: string,
  scope: PluginScope,
  enabled: boolean,
  cwd: string = process.cwd(),
): Promise<'changed' | 'noop'> {
  const file = settingsPathForScope(scope, cwd)
  await fs.mkdir(path.dirname(file), { recursive: true })

  let existing: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>
  } catch {
    // first write — file may not exist yet
  }

  const currentMap =
    existing.enabledPlugins && typeof existing.enabledPlugins === 'object' && !Array.isArray(existing.enabledPlugins)
      ? { ...(existing.enabledPlugins as Record<string, boolean>) }
      : {}

  if (currentMap[pluginId] === enabled) return 'noop'
  currentMap[pluginId] = enabled
  existing.enabledPlugins = currentMap

  await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
  return 'changed'
}

/** Remove a plugin's entry from a scope's enabledPlugins (used by
 *  `/plugin uninstall` to keep settings.json tidy). */
export async function clearPluginEntry(
  pluginId: string,
  scope: PluginScope,
  cwd: string = process.cwd(),
): Promise<'changed' | 'noop'> {
  const file = settingsPathForScope(scope, cwd)
  let existing: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>
  } catch {
    return 'noop'
  }

  if (
    !existing.enabledPlugins ||
    typeof existing.enabledPlugins !== 'object' ||
    Array.isArray(existing.enabledPlugins)
  ) {
    return 'noop'
  }

  const map = { ...(existing.enabledPlugins as Record<string, boolean>) }
  if (!(pluginId in map)) return 'noop'
  delete map[pluginId]

  if (Object.keys(map).length === 0) {
    delete existing.enabledPlugins
  } else {
    existing.enabledPlugins = map
  }

  await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
  return 'changed'
}
