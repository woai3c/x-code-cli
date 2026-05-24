// @x-code-cli/core — Plugin hot-reload orchestrator
//
// `/plugin refresh` enters here. The job is to re-scan installed plugins
// from disk and propagate the new state to every downstream registry
// without restarting xc.
//
// Why this is its own module and not a method on PluginRegistry:
// reloading the plugin registry itself is one line — the work is folding
// the new contributions into the FOUR sub-registries the rest of the
// agent loop captured at startup (skill / sub-agent / command / hook).
// Each captured reference must stay stable, so each registry exposes a
// reload-in-place method instead of returning a new instance.
//
// Not handled here: MCP servers. Plugin-contributed MCP servers spawn
// child processes at startup; restarting them mid-session needs the
// MCP-specific orchestration that already lives behind `/mcp refresh`.
// The user can run that separately if they need MCP changes to land.
import { reloadSubAgentRegistry } from '../agent/sub-agents/registry.js'
import type { SubAgentRegistry, SubAgentReloadSummary } from '../agent/sub-agents/registry.js'
import { reloadCommandRegistry } from '../commands/registry.js'
import type { CommandRegistry, CommandReloadSummary } from '../commands/registry.js'
import type { HookBus } from '../hooks/bus.js'
import type { HookRegistry } from '../hooks/registry.js'
import { reloadSkillRegistry } from '../skills/registry.js'
import type { SkillRegistry, SkillReloadSummary } from '../skills/registry.js'
import { buildPluginIntegration } from './integration.js'
import { loadAllPlugins } from './loader.js'
import type { PluginRegistry, PluginReloadSummary } from './registry.js'

export interface PluginRefreshSummary {
  /** Plugin-level diff — what plugins appeared / disappeared / changed.
   *  This is the headline the /plugin refresh message renders. */
  plugins: PluginReloadSummary
  /** Per-sub-registry diffs — useful for /plugin doctor-style detail.
   *  Each is optional because a caller may not have wired every registry
   *  (e.g. tests skip them). */
  skills?: SkillReloadSummary
  subAgents?: SubAgentReloadSummary
  commands?: CommandReloadSummary
  /** Number of hook entries registered after refresh — surfaced for
   *  user feedback. We don't compute a per-event diff because hooks
   *  don't have a stable identity (no name field); the count alone is
   *  enough to confirm "hooks reloaded". */
  hookCount: number
}

export interface PluginRefreshTargets {
  pluginRegistry: PluginRegistry
  /** Sub-registries that should fold in the new plugin contributions.
   *  Pass whichever ones the caller has wired. */
  skillRegistry?: SkillRegistry
  subAgentRegistry?: SubAgentRegistry
  commandRegistry?: CommandRegistry
  hookBus?: HookBus
  /** cwd defaults to process.cwd(); overridable for tests. */
  cwd?: string
}

/** Re-scan installed plugins and fold the new state into every wired
 *  registry. Caller is responsible for invalidating systemPromptCache
 *  afterwards (we'd need the cache reference here, which sits one layer
 *  up in the agent options). */
export async function refreshPluginContributions(targets: PluginRefreshTargets): Promise<PluginRefreshSummary> {
  const cwd = targets.cwd ?? process.cwd()

  // 1. Re-scan plugins from disk. loadAllPlugins builds its own internal
  //    registry — we pull the plugin list + load errors out of it and
  //    feed them into the caller's long-lived registry via reload().
  const load = await loadAllPlugins({ cwd })

  // 2. Swap into the caller's plugin registry, capture the headline diff.
  const pluginsSummary = targets.pluginRegistry.reload(load.registry.listAll(), [...load.registry.loadErrors()])

  // 3. Recompute downstream integration (skills dirs, agents dirs,
  //    commands dirs, mcp servers, hook registry) from the new
  //    plugin set.
  const integration = await buildPluginIntegration(load)

  // 4. Fold into each sub-registry the caller wired up.
  const out: PluginRefreshSummary = { plugins: pluginsSummary, hookCount: 0 }

  if (targets.skillRegistry) {
    out.skills = await reloadSkillRegistry(targets.skillRegistry, { extraDirs: integration.skillsDirs })
  }
  if (targets.subAgentRegistry) {
    out.subAgents = await reloadSubAgentRegistry(targets.subAgentRegistry, { extraDirs: integration.agentsDirs })
  }
  if (targets.commandRegistry) {
    out.commands = await reloadCommandRegistry(targets.commandRegistry, { extraDirs: integration.commandsDirs })
  }
  if (targets.hookBus) {
    targets.hookBus.replaceRegistry(integration.hookRegistry)
    // Count by summing entry counts across the new registry's events.
    // Used for the user message — exact diff isn't worth the complexity.
    out.hookCount = countHooks(integration.hookRegistry)
  }

  return out
}

function countHooks(registry: HookRegistry): number {
  // HookRegistry exposes get(eventName) → array; iterate the known event
  // names. Names are duplicated from types.ts but importing them here
  // would create a circular dependency, so we hardcode the small list.
  const eventNames = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PreCompact',
    'PostCompact',
    'SubagentStart',
    'SubagentStop',
    'TurnComplete',
    'SessionEnd',
  ] as const
  let n = 0
  for (const e of eventNames) n += registry.get(e).length
  return n
}
