// @x-code-cli/core — Sub-agent registry
//
// Constructed once at startup; can be hot-reloaded via reloadSubAgentRegistry
// when /plugin refresh fires. Built-in agents load synchronously; custom
// agents from disk are async. Same-name custom agents override built-ins
// (project > user > built-in).
import { builtInAgents } from './built-in.js'
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

/** Build the registry: built-in first, then custom (later entries override). */
export async function createSubAgentRegistry(opts: LoadCustomAgentsOptions = {}): Promise<SubAgentRegistry> {
  const custom = await loadCustomAgents(opts)
  // Load order: built-in → custom. Map insertion overwrites, so custom wins.
  return new SubAgentRegistry([...builtInAgents, ...custom])
}

/** Re-scan + rebuild the in-memory agent list in place. Same disk scan as
 *  startup; opts (notably extraDirs from plugins) carry over from the
 *  caller. Returns a diff summary for the /plugin refresh message. */
export async function reloadSubAgentRegistry(
  registry: SubAgentRegistry,
  opts: LoadCustomAgentsOptions = {},
): Promise<SubAgentReloadSummary> {
  const custom = await loadCustomAgents(opts)
  return registry.reload([...builtInAgents, ...custom])
}

/** Synchronous registry with only built-in agents (for testing or when
 *  disk scan should be skipped). */
export function createBuiltInRegistry(): SubAgentRegistry {
  return new SubAgentRegistry(builtInAgents)
}
