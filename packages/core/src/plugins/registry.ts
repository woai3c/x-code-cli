// @x-code-cli/core — Plugin registry
//
// Built once at CLI startup by [[loader]].loadAllPlugins(), then frozen
// for the session. The registry holds every plugin that successfully
// loaded — enabled AND disabled — so `/plugin list` can show both, plus
// every load error so `/plugin doctor` can surface them.
//
// Hot-reload model mirrors SkillRegistry: `/plugin refresh` rebuilds the
// internal state in place (preserving the registry object identity so
// every captured `options.pluginRegistry` reference stays valid) and the
// CLI invalidates `systemPromptCache` afterwards — the byte-stability
// constraint described in CLAUDE.md still applies because plugins
// contribute skills / agents / commands into the system prompt.
import type { LoadedPlugin, PluginLoadError } from './types.js'

/** Summary of what changed between two registry snapshots — used by
 *  `/plugin refresh` to render an "added / removed / changed" message
 *  the same way `/mcp refresh` and `/skill refresh` do. */
export interface PluginReloadSummary {
  added: string[]
  removed: string[]
  changed: string[]
  unchanged: string[]
}

export class PluginRegistry {
  private byId: Map<string, LoadedPlugin>
  private errors: PluginLoadError[]

  constructor(plugins: LoadedPlugin[], errors: PluginLoadError[] = []) {
    this.byId = new Map()
    for (const p of plugins) this.byId.set(p.id, p)
    this.errors = [...errors]
  }

  /** Enabled plugin by id. Disabled plugins are hidden from this lookup —
   *  use [[getEntry]] when you need to inspect the disabled flag (e.g.
   *  `/plugin list`). */
  get(id: string): LoadedPlugin | undefined {
    const p = this.byId.get(id)
    if (!p || !p.enabled) return undefined
    return p
  }

  /** Plugin by id including disabled ones. */
  getEntry(id: string): LoadedPlugin | undefined {
    return this.byId.get(id)
  }

  /** Enabled plugins only — what the agent loop sees. */
  list(): LoadedPlugin[] {
    return [...this.byId.values()].filter((p) => p.enabled)
  }

  /** Every loaded plugin, with the disabled ones. */
  listAll(): LoadedPlugin[] {
    return [...this.byId.values()]
  }

  /** Plugin ids only (enabled). */
  ids(): string[] {
    return this.list().map((p) => p.id)
  }

  /** Non-fatal errors collected during load. Surfaced by `/plugin doctor`. */
  loadErrors(): readonly PluginLoadError[] {
    return this.errors
  }

  /** Replace the in-memory plugin list with a fresh load. Used by
   *  `/plugin refresh` — keeps the same PluginRegistry object identity
   *  so every cached reference stays valid. Returns a diff summary so
   *  the caller can render an "added / removed / changed / unchanged"
   *  message. */
  reload(plugins: LoadedPlugin[], errors: PluginLoadError[] = []): PluginReloadSummary {
    const previous = this.byId
    const next = new Map<string, LoadedPlugin>()
    for (const p of plugins) next.set(p.id, p)

    const summary: PluginReloadSummary = { added: [], removed: [], changed: [], unchanged: [] }
    for (const [id, plugin] of next) {
      const prev = previous.get(id)
      if (!prev) {
        summary.added.push(id)
      } else if (
        prev.manifest.version !== plugin.manifest.version ||
        prev.rootDir !== plugin.rootDir ||
        prev.enabled !== plugin.enabled ||
        prev.scope !== plugin.scope
      ) {
        summary.changed.push(id)
      } else {
        summary.unchanged.push(id)
      }
    }
    for (const id of previous.keys()) {
      if (!next.has(id)) summary.removed.push(id)
    }

    this.byId = next
    this.errors = [...errors]
    return summary
  }
}

/** Empty registry — used when plugin loading is disabled (e.g.
 *  `--no-plugins` startup flag) or no plugins are installed. Cheaper than
 *  null-checking the registry everywhere downstream. */
export function emptyPluginRegistry(): PluginRegistry {
  return new PluginRegistry([], [])
}
