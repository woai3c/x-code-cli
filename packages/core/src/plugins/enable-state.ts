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
import path from 'node:path'

import { mutateSettingsFile, readSettingsFile } from '../settings-io.js'
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

function enabledPluginsFrom(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const enabledPlugins: Record<string, boolean> = {}
  for (const [pluginId, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (typeof enabled === 'boolean') enabledPlugins[pluginId] = enabled
  }
  return enabledPlugins
}

export function settingsPathForScope(scope: PluginScope, cwd: string = process.cwd()): string {
  if (scope === 'user') return path.join(userXcodeDir(), 'settings.json')
  return path.join(cwd, XCODE_DIR, 'settings.local.json')
}

async function readSettings(scope: PluginScope, cwd: string): Promise<PluginSettingsFile> {
  const obj = await readSettingsFile(settingsPathForScope(scope, cwd))
  return { enabledPlugins: enabledPluginsFrom(obj.enabledPlugins) }
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
  const changed = await mutateSettingsFile(file, (existing) => {
    const currentMap = enabledPluginsFrom(existing.enabledPlugins)
    if (currentMap[pluginId] === enabled) return false
    currentMap[pluginId] = enabled
    existing.enabledPlugins = currentMap
    return true
  })
  return changed ? 'changed' : 'noop'
}

/** Remove a plugin's entry from a scope's enabledPlugins (used by
 *  `/plugin uninstall` to keep settings.json tidy). */
export async function clearPluginEntry(
  pluginId: string,
  scope: PluginScope,
  cwd: string = process.cwd(),
): Promise<'changed' | 'noop'> {
  const file = settingsPathForScope(scope, cwd)
  const changed = await mutateSettingsFile(file, (existing) => {
    const currentMap = enabledPluginsFrom(existing.enabledPlugins)
    if (!(pluginId in currentMap)) return false
    delete currentMap[pluginId]

    if (Object.keys(currentMap).length === 0) delete existing.enabledPlugins
    else existing.enabledPlugins = currentMap
    return true
  })
  return changed ? 'changed' : 'noop'
}
