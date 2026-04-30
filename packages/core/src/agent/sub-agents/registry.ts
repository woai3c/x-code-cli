// @x-code-cli/core — Sub-agent registry
//
// Constructed once at startup, immutable for the session lifetime.
// Built-in agents load synchronously; custom agents from disk are async.
// Same-name custom agents override built-ins (project > global > built-in).
import { builtInAgents } from './built-in.js'
import { loadCustomAgents } from './loader.js'
import type { SubAgentDefinition } from './types.js'

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
}

/** Build the registry: built-in first, then custom (later entries override). */
export async function createSubAgentRegistry(): Promise<SubAgentRegistry> {
  const custom = await loadCustomAgents()
  // Load order: built-in → custom. Map insertion overwrites, so custom wins.
  return new SubAgentRegistry([...builtInAgents, ...custom])
}

/** Synchronous registry with only built-in agents (for testing or when
 *  disk scan should be skipped). */
export function createBuiltInRegistry(): SubAgentRegistry {
  return new SubAgentRegistry(builtInAgents)
}
