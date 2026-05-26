// @x-code-cli/core — Plugin contributions → existing loaders integration
//
// Takes the output of [[loader]].loadAllPlugins and converts it into the
// shapes that the pre-existing skill / sub-agent / MCP loaders consume,
// so a CLI startup call sequence looks like:
//
//   const pluginLoad = await loadAllPlugins({ cwd })
//   const integration = await buildPluginIntegration(pluginLoad)
//   const skillRegistry  = await createSkillRegistry({  extraDirs: integration.skillsDirs })
//   const agentRegistry  = await createSubAgentRegistry({ extraDirs: integration.agentsDirs })
//   const mcpRegistry    = await loadMcpFromDisk({ ..., extraServers: integration.mcpServers })
//
// Three concerns this module owns and the others don't:
//
//   1. Resolving plugin `mcpServers` from the manifest (a path or an
//      inline object) into a typed `Record<string, McpServerConfig>`.
//      The path form is a JSON file shaped `{ mcpServers: {...} }`
//      (same as ~/.x-code/config.json). The inline form is the raw
//      record itself.
//
//   2. Detecting name collisions across plugins. We deduplicate by
//      server name — first plugin in iteration order wins, the second's
//      entry is dropped with a warning. A future improvement: namespace
//      server names with the plugin id.
//
//   3. Logging plugin contributions we don't (yet) support: `commands`
//      (we lack a file-based slash command loader) and `hooks` (Task 9
//      will add the hook subsystem; until then, declared hooks are
//      noted but not executed).
//
// Plugin order is deterministic — driven by the iteration order of
// `loadAllPlugins`'s `contributions` Map, which itself reflects the
// order of installed_plugins.json + project-local discovery. Stable
// across boots when the same plugins are installed.
import fs from 'node:fs/promises'

import { HookBus } from '../hooks/bus.js'
import { HookConfigParseError, parseHookConfig } from '../hooks/config-schema.js'
import { HookRegistry, buildHookRegistry } from '../hooks/registry.js'
import type { HookConfig } from '../hooks/types.js'
import { parseServersBlock } from '../mcp/config-schema.js'
import { isStdioConfig } from '../mcp/types.js'
import type { McpServerConfig } from '../mcp/types.js'
import { debugLog } from '../utils.js'
import { loadAllPlugins } from './loader.js'
import type { LoadResult, ResolvedContributions } from './loader.js'
import type { InlineMcpServers, LoadedPlugin } from './types.js'
import { getPluginUserConfigEnv } from './user-config.js'

export interface PluginIntegrationOutput {
  /** Extra skill directories the skill loader should scan, with the
   *  owning plugin id stamped on each. Only enabled plugins included. */
  skillsDirs: Array<{ dir: string; pluginId: string }>
  /** Same as above for sub-agent .md files. */
  agentsDirs: Array<{ dir: string; pluginId: string }>
  /** Same as above for slash command `*.md` files. Each entry carries
   *  the owning plugin's rootDir so the command body can substitute
   *  `${CLAUDE_PLUGIN_ROOT}` at activation time. */
  commandsDirs: Array<{ dir: string; pluginId: string; pluginRoot: string }>
  /** Merged `mcpServers` block from every enabled plugin. Name
   *  collisions resolved first-wins; the losers are recorded in
   *  `mcpCollisions`. */
  mcpServers: Record<string, McpServerConfig>
  /** Hook registry built from every enabled plugin's `hooks` config.
   *  Empty when no plugin declared any hooks. Hand this to
   *  `new HookBus(...)` to wire the agent loop's emit-sites. */
  hookRegistry: HookRegistry
  /** Ready-to-use bus over `hookRegistry`. Convenience for the CLI
   *  startup wiring — `AgentOptions.hookBus = integration.hookBus`. */
  hookBus: HookBus
  /** Per-plugin summary of which event names had hooks — used by
   *  `/plugin doctor` and `/plugin info` UI. */
  pluginHooks: Array<{ pluginId: string; events: string[] }>
  /** mcpServers entries dropped due to name collision with an earlier
   *  plugin. `{ name, droppedFrom, keptFrom }`. */
  mcpCollisions: Array<{ name: string; droppedFrom: string; keptFrom: string }>
  /** mcpServers parse / read errors per plugin — these don't block
   *  startup, they surface in `/plugin doctor`. */
  mcpErrors: Array<{ pluginId: string; message: string }>
  /** Hooks parse / read errors per plugin. */
  hookErrors: Array<{ pluginId: string; message: string }>
}

export async function buildPluginIntegration(load: LoadResult): Promise<PluginIntegrationOutput> {
  // Hook registry is built last so we can collect the per-plugin configs
  // along the way (we don't know all plugins' rootDirs in advance — they
  // come from LoadedPlugin).
  const hookInputs: Array<{ pluginId: string; pluginDir: string; config: HookConfig }> = []

  const out: PluginIntegrationOutput = {
    skillsDirs: [],
    agentsDirs: [],
    commandsDirs: [],
    mcpServers: {},
    hookRegistry: new HookRegistry(),
    hookBus: new HookBus(new HookRegistry()),
    pluginHooks: [],
    mcpCollisions: [],
    mcpErrors: [],
    hookErrors: [],
  }
  const mcpOwners = new Map<string, string>()

  for (const plugin of load.registry.list()) {
    const contrib = load.contributions.get(plugin.id)
    if (!contrib) continue

    if (contrib.skillsDir) out.skillsDirs.push({ dir: contrib.skillsDir, pluginId: plugin.id })
    if (contrib.agentsDir) out.agentsDirs.push({ dir: contrib.agentsDir, pluginId: plugin.id })
    if (contrib.commandsDir) {
      out.commandsDirs.push({ dir: contrib.commandsDir, pluginId: plugin.id, pluginRoot: plugin.rootDir })
    }

    if (contrib.hooks) {
      const config = await resolvePluginHooks(plugin, contrib.hooks, out)
      if (config) {
        hookInputs.push({ pluginId: plugin.id, pluginDir: plugin.rootDir, config })
        out.pluginHooks.push({ pluginId: plugin.id, events: Object.keys(config) })
      }
    }

    if (contrib.mcpServers) {
      const servers = await resolvePluginMcpServers(plugin, contrib.mcpServers, out)
      for (const [name, cfg] of Object.entries(servers)) {
        const prevOwner = mcpOwners.get(name)
        if (prevOwner !== undefined) {
          out.mcpCollisions.push({ name, droppedFrom: plugin.id, keptFrom: prevOwner })
          continue
        }
        out.mcpServers[name] = cfg
        mcpOwners.set(name, plugin.id)
      }
    }
  }

  out.hookRegistry = buildHookRegistry(hookInputs)
  out.hookBus = new HookBus(out.hookRegistry)
  return out
}

async function resolvePluginHooks(
  plugin: LoadedPlugin,
  contrib: NonNullable<ResolvedContributions['hooks']>,
  out: PluginIntegrationOutput,
): Promise<HookConfig | null> {
  let raw: unknown
  if (contrib.kind === 'inline') {
    raw = contrib.data
  } else {
    try {
      const text = await fs.readFile(contrib.path, 'utf-8')
      raw = JSON.parse(text)
    } catch (err) {
      out.hookErrors.push({
        pluginId: plugin.id,
        message: `failed to read hooks file ${contrib.path}: ${err instanceof Error ? err.message : String(err)}`,
      })
      return null
    }
  }
  try {
    return parseHookConfig(raw, plugin.id)
  } catch (err) {
    out.hookErrors.push({
      pluginId: plugin.id,
      message: err instanceof HookConfigParseError ? err.message : String(err),
    })
    return null
  }
}

/** Extract the `name → cfg` block from the contents of a `.mcp.json`
 *  file. Two shapes are accepted:
 *
 *    - Wrapped:  `{ "mcpServers": { "name": cfg, ... } }`
 *    - Flat:     `{ "name": cfg, ... }`  (no wrapper key)
 *
 *  Claude Code's official plugins (e.g. linear@anthropic-marketplace)
 *  ship the flat form; the wrapped form matches our own config.json
 *  layout. The detection rule is: if the parsed object has a
 *  `mcpServers` key at all, treat it as wrapped (and pass through the
 *  value as-is so the schema parser produces a clean error on
 *  misshape). Otherwise treat the whole object as the flat block. */
export function extractMcpServersBlock(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const obj = parsed as Record<string, unknown>
  if ('mcpServers' in obj) return obj.mcpServers
  return obj
}

async function resolvePluginMcpServers(
  plugin: LoadedPlugin,
  contrib: NonNullable<ResolvedContributions['mcpServers']>,
  out: PluginIntegrationOutput,
): Promise<Record<string, McpServerConfig>> {
  let rawBlock: unknown
  if (contrib.kind === 'inline') {
    rawBlock = contrib.data as InlineMcpServers
  } else {
    try {
      const raw = await fs.readFile(contrib.path, 'utf-8')
      const parsed = JSON.parse(raw)
      rawBlock = extractMcpServersBlock(parsed)
    } catch (err) {
      out.mcpErrors.push({
        pluginId: plugin.id,
        message: `failed to read mcpServers file ${contrib.path}: ${err instanceof Error ? err.message : String(err)}`,
      })
      return {}
    }
  }

  const { servers, errors } = parseServersBlock(rawBlock)
  for (const e of errors) {
    out.mcpErrors.push({ pluginId: plugin.id, message: `mcpServers.${e.name}: ${e.message}` })
  }

  // Merge the owning plugin's userConfig values into each server's env
  // map. Authors who want an API key from a userConfig field declared
  // in the manifest just reference it as a normal env var inside the
  // mcpServers entry (or skip the explicit reference and rely on the
  // child process's inherited env). Pre-existing server env entries win
  // so an author can override a userConfig value per-server if needed.
  try {
    const pluginEnv = await getPluginUserConfigEnv(plugin.id)
    if (Object.keys(pluginEnv).length > 0) {
      for (const name of Object.keys(servers)) {
        const cfg = servers[name]!
        // Only stdio servers spawn a child process and accept env vars —
        // HTTP servers are remote endpoints, env merging is meaningless.
        if (isStdioConfig(cfg)) {
          servers[name] = { ...cfg, env: { ...pluginEnv, ...(cfg.env ?? {}) } }
        }
      }
    }
  } catch (err) {
    out.mcpErrors.push({ pluginId: plugin.id, message: `userConfig env merge: ${String(err)}` })
  }

  return servers
}

/** Convenience: log non-fatal integration diagnostics to debug.log so
 *  `/plugin doctor` and ad-hoc support can find them. CLI startup calls
 *  this after `buildPluginIntegration` returns. */
export function debugLogIntegrationDiagnostics(integration: PluginIntegrationOutput): void {
  for (const c of integration.commandsDirs) {
    debugLog('plugins.commands-loaded', `${c.pluginId} commands dir: ${c.dir}`)
  }
  for (const h of integration.pluginHooks) {
    debugLog('plugins.hooks-registered', `${h.pluginId} hooks: [${h.events.join(', ')}]`)
  }
  for (const e of integration.hookErrors) {
    debugLog('plugins.hook-error', `${e.pluginId}: ${e.message}`)
  }
  for (const c of integration.mcpCollisions) {
    debugLog('plugins.mcp-collision', `mcpServer "${c.name}" from ${c.droppedFrom} dropped (kept ${c.keptFrom})`)
  }
  for (const e of integration.mcpErrors) {
    debugLog('plugins.mcp-error', `${e.pluginId}: ${e.message}`)
  }
}

/** Re-scan plugins from disk and return just the merged plugin-contributed
 *  mcpServers block. Used by `/mcp refresh` to include plugin servers in
 *  the merged map (so they aren't silently dropped on standalone MCP
 *  refresh) and by `/plugin refresh` indirectly via buildPluginIntegration.
 *
 *  Returns `{}` (not undefined) so callers can spread it unconditionally.
 *  Scan failures degrade to `{}` + debug log — callers shouldn't have an
 *  MCP-only refresh fail because of a plugin-system hiccup. */
export async function getPluginMcpServersFromDisk(cwd: string): Promise<Record<string, McpServerConfig>> {
  try {
    const load = await loadAllPlugins({ cwd })
    const integration = await buildPluginIntegration(load)
    return integration.mcpServers
  } catch (err) {
    debugLog('plugins.mcp-scan-failed', `getPluginMcpServersFromDisk: ${String(err)}`)
    return {}
  }
}

// Re-export commonly used pieces so a single import from this module is
// enough for typical CLI startup wiring.
export type { LoadResult, ResolvedContributions } from './loader.js'
export { loadAllPlugins }
