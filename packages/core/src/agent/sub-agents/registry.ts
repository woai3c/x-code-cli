// @x-code-cli/core — Sub-agent registry
//
// Constructed once at startup; can be hot-reloaded via reloadSubAgentRegistry
// when /plugin refresh fires. Built-in agents load synchronously; custom
// agents from disk are async. Same-name custom agents override built-ins
// (project > user > built-in).
import { loadUserConfig } from '../../config/index.js'
import { browserAgent, builtInAgents } from './built-in.js'
import { type LoadCustomAgentsOptions, loadCustomAgents } from './loader.js'
import type { SubAgentDefinition } from './types.js'

/** Diff summary returned by reload — drives the message surface for
 *  /plugin refresh. */
export interface SubAgentReloadSummary {
  added: string[]
  removed: string[]
  changed: string[]
  unchanged: string[]
}

export class SubAgentRegistry {
  private agents: Map<string, SubAgentDefinition>

  constructor(agents: SubAgentDefinition[]) {
    this.agents = new Map()
    for (const a of agents) {
      this.agents.set(a.name, a)
    }
  }

  get(name: string): SubAgentDefinition | undefined {
    return this.agents.get(name)
  }

  list(): SubAgentDefinition[] {
    return [...this.agents.values()]
  }

  names(): string[] {
    return [...this.agents.keys()]
  }

  /** Add or remove the browser agent in place — driven by `/browser on|off`.
   *  Surgical: keeps the registry's object identity (so every captured
   *  options.subAgentRegistry reference stays valid) and skips a full
   *  custom/plugin re-scan. A custom agent literally named "browser" would be
   *  shadowed while on — an accepted edge for a name no one realistically reuses. */
  setBrowserEnabled(enabled: boolean): void {
    if (enabled) this.agents.set(browserAgent.name, browserAgent)
    else this.agents.delete(browserAgent.name)
  }

  /** Replace the in-memory agent list with a fresh load. Used by
   *  /plugin refresh — keeps the same SubAgentRegistry object identity so
   *  every captured `options.subAgentRegistry` reference stays valid. */
  reload(agents: SubAgentDefinition[]): SubAgentReloadSummary {
    const previous = this.agents
    const next = new Map<string, SubAgentDefinition>()
    for (const a of agents) next.set(a.name, a)
    const summary: SubAgentReloadSummary = { added: [], removed: [], changed: [], unchanged: [] }
    for (const [name, agent] of next) {
      const prev = previous.get(name)
      if (!prev) summary.added.push(name)
      else if (prev.prompt !== agent.prompt || prev.source !== agent.source || prev.pluginId !== agent.pluginId)
        summary.changed.push(name)
      else summary.unchanged.push(name)
    }
    for (const name of previous.keys()) {
      if (!next.has(name)) summary.removed.push(name)
    }
    this.agents = next
    return summary
  }
}

/** Built-in agents plus the optional browser agent, gated on config. The
 *  browser agent is opt-in (`config.browser.enabled`) so the default agent
 *  list — and the task-tool description baked into the byte-stable system
 *  prompt — is unchanged for everyone who hasn't enabled it. An explicit
 *  `includeBrowser` overrides the config read (used by tests). */
function baseAgents(includeBrowser: boolean | undefined): SubAgentDefinition[] {
  const enabled = includeBrowser ?? loadUserConfig().browser?.enabled === true
  return enabled ? [...builtInAgents, browserAgent] : builtInAgents
}

/** Build the registry: built-in first, then custom (later entries override). */
export async function createSubAgentRegistry(
  opts: LoadCustomAgentsOptions & { includeBrowser?: boolean } = {},
): Promise<SubAgentRegistry> {
  const { includeBrowser, ...loadOpts } = opts
  const custom = await loadCustomAgents(loadOpts)
  // Load order: built-in → custom. Map insertion overwrites, so custom wins.
  return new SubAgentRegistry([...baseAgents(includeBrowser), ...custom])
}

/** Re-scan + rebuild the in-memory agent list in place. Same disk scan as
 *  startup; opts (notably extraDirs from plugins) carry over from the
 *  caller. Returns a diff summary for the /plugin refresh message. */
export async function reloadSubAgentRegistry(
  registry: SubAgentRegistry,
  opts: LoadCustomAgentsOptions & { includeBrowser?: boolean } = {},
): Promise<SubAgentReloadSummary> {
  const { includeBrowser, ...loadOpts } = opts
  const custom = await loadCustomAgents(loadOpts)
  return registry.reload([...baseAgents(includeBrowser), ...custom])
}

/** Synchronous registry with only built-in agents (for testing or when
 *  disk scan should be skipped). */
export function createBuiltInRegistry(): SubAgentRegistry {
  return new SubAgentRegistry(builtInAgents)
}
