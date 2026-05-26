// @x-code-cli/core — MCP startup loader
//
// One-shot orchestration called from the CLI entry: read user + project
// configs, apply the trust gate to anything project-level, expand env
// vars, spawn / dial every enabled server in parallel, build a registry
// that can later be mutated by `/mcp refresh` and `/mcp auth`. Failures
// on individual servers are recorded but never abort the boot —
// `/mcp list` is the user's window into what went wrong.
import fs from 'node:fs/promises'
import path from 'node:path'

import { getUserConfigPath } from '../config/index.js'
import { XCODE_DIR, debugLog } from '../utils.js'
import { parseServersBlock } from './config-schema.js'
import { buildCallableName as buildCallable } from './name-mangling.js'
import {
  type ConnectResult,
  McpRegistry,
  type OAuthProviderFactory,
  type RegisteredServer,
  connectOneServer,
  emptyRegistry,
} from './registry.js'
import { type TrustChoice, buildServerPreview, isProjectTrusted, promptForTrust, trustProject } from './trust.js'
import { type McpResourceEntry, type McpServerConfig, type McpToolEntry } from './types.js'

// Re-export for legacy callers that imported the type from this module.
export type { OAuthProviderFactory }
export type { RegisteredServer, ConnectResult }
export type { McpResourceEntry, McpToolEntry }

export interface LoadOptions {
  /** mcpServers from ~/.x-code/config.json. Trusted implicitly. */
  userServers: Record<string, McpServerConfig> | undefined
  /** mcpServers from <project>/.x-code/config.json. Requires consent. */
  projectServers: Record<string, McpServerConfig> | undefined
  /** mcpServers contributed by enabled plugins. Trusted implicitly —
   *  the user already consented to the plugin at install time, so
   *  re-running the project-MCP trust dialog for plugin servers would
   *  be a duplicate prompt. Merged at the same precedence as
   *  `userServers` (project entries still override on name collision). */
  extraServers?: Record<string, McpServerConfig>
  /** Absolute project path (cwd at CLI start). Used as the trust key. */
  projectPath: string
  /** Renders the trust dialog. Same shape as `AgentCallbacks.onAskUser`. */
  askUser: (question: string, options: Array<{ label: string; description: string }>) => Promise<string>
  /** Factory for OAuth providers. Optional — pass undefined to disable
   *  OAuth (HTTP servers requiring auth will be marked `needs_auth`). */
  oauthProviderFor?: OAuthProviderFactory
  /** Called after the loader decides to terminate the process — the CLI
   *  layer wires this to a clean shutdown path. Defaults to no-op
   *  (caller is responsible). */
  onExitRequested?: () => void
}

export interface LoadResult {
  registry: McpRegistry
  /** Configuration / parse errors collected before any server was even
   *  contacted. Surfaced in `/mcp list` so users see typos in their
   *  config alongside actual connection failures. */
  configErrors: Array<{ name: string; message: string }>
  /** True iff project-level mcpServers were skipped because the user
   *  declined trust. The CLI uses this to print a heads-up message. */
  projectSkipped: boolean
}

/** Load the standard config files from disk + invoke the loader.
 *  Convenience wrapper used by the CLI entry point so it doesn't have
 *  to know about file paths. */
export async function loadMcpFromDisk(opts: {
  cwd: string
  askUser: LoadOptions['askUser']
  oauthProviderFor?: OAuthProviderFactory
  onExitRequested?: () => void
  /** Plugin-contributed mcpServers — already-trusted, merged into the
   *  effective config alongside user-level servers. Built by
   *  packages/core/src/plugins/integration.ts. */
  extraServers?: Record<string, McpServerConfig>
}): Promise<LoadResult> {
  const userServers = await readMcpServersFromFile(getUserConfigPath())
  const projectServers = await readMcpServersFromFile(path.join(opts.cwd, XCODE_DIR, 'config.json'))
  return loadMcpServers({
    userServers,
    projectServers,
    extraServers: opts.extraServers,
    projectPath: opts.cwd,
    askUser: opts.askUser,
    oauthProviderFor: opts.oauthProviderFor,
    onExitRequested: opts.onExitRequested,
  })
}

/** Re-read configs from disk + apply the trust gate, but DON'T spawn any
 *  servers. Used by `/mcp refresh` so the caller can hand the resulting
 *  merged map to `registry.restartAll(...)` — that mutates the existing
 *  registry in place rather than allocating a parallel one. */
export async function loadMergedConfigsFromDisk(opts: {
  cwd: string
  askUser: LoadOptions['askUser']
  /** Plugin-contributed mcpServers (from `buildPluginIntegration().mcpServers`).
   *  Merged between user and project, matching the precedence in
   *  [[loadMcpServers]]. Pass these on `/mcp refresh` and `/plugin refresh`
   *  so plugin-contributed servers aren't silently dropped during a reload. */
  extraServers?: Record<string, McpServerConfig>
}): Promise<{
  configs: Map<string, McpServerConfig>
  configErrors: Array<{ name: string; message: string }>
  projectSkipped: boolean
}> {
  const userServers = await readMcpServersFromFile(getUserConfigPath())
  const projectServers = await readMcpServersFromFile(path.join(opts.cwd, XCODE_DIR, 'config.json'))

  const configErrors: Array<{ name: string; message: string }> = []
  let projectSkipped = false

  const userParsed = parseServersBlock(userServers)
  configErrors.push(...userParsed.errors.map((e) => ({ name: `user:${e.name}`, message: e.message })))
  const projectParsed = parseServersBlock(projectServers)
  configErrors.push(...projectParsed.errors.map((e) => ({ name: `project:${e.name}`, message: e.message })))

  let projectServersToUse = projectParsed.servers
  if (Object.keys(projectServersToUse).length > 0) {
    const trusted = await isProjectTrusted(opts.cwd)
    if (!trusted) {
      const choice = await askForTrust(
        {
          // Synthesise just enough of a LoadOptions for askForTrust —
          // only projectPath + askUser are read.
          userServers,
          projectServers,
          projectPath: opts.cwd,
          askUser: opts.askUser,
        },
        projectServersToUse,
      )
      if (choice === 'exit') {
        // /mcp refresh deliberately ignores 'exit' — bailing the whole
        // CLI from a slash command is too violent. We treat it as
        // 'skip' so the user can pick again on a real restart.
        projectServersToUse = {}
        projectSkipped = true
      } else if (choice === 'skip') {
        projectServersToUse = {}
        projectSkipped = true
      } else if (choice === 'trust') {
        await trustProject(opts.cwd).catch((err) => {
          debugLog('mcp.trust-write-failed', String(err))
        })
      }
    }
  }

  // Merge order user → plugin → project, matching the precedence enforced by
  // loadMcpServers (initial boot). Plugin-contributed entries sit between
  // user and project so a project-level same-name entry still wins.
  const merged = new Map<string, McpServerConfig>(
    Object.entries({ ...userParsed.servers, ...(opts.extraServers ?? {}), ...projectServersToUse }),
  )
  return { configs: merged, configErrors, projectSkipped }
}

/** Pure loader (no disk I/O on configs — caller injects them).
 *  Easier to test and lets the CLI control config sourcing. */
export async function loadMcpServers(options: LoadOptions): Promise<LoadResult> {
  const configErrors: Array<{ name: string; message: string }> = []
  let projectSkipped = false

  // Validate both blocks up front. parseServersBlock tolerates `undefined`
  // and returns empty maps + zero errors in that case, so users with no
  // mcpServers configured pay nothing.
  const userParsed = parseServersBlock(options.userServers)
  configErrors.push(...userParsed.errors.map((e) => ({ name: `user:${e.name}`, message: e.message })))

  const projectParsed = parseServersBlock(options.projectServers)
  configErrors.push(...projectParsed.errors.map((e) => ({ name: `project:${e.name}`, message: e.message })))

  // Project-level trust gate. If the project has zero servers we skip the
  // prompt entirely — there's nothing to consent to.
  let projectServersToUse = projectParsed.servers
  const projectServerNames = Object.keys(projectServersToUse)
  if (projectServerNames.length > 0) {
    const trusted = await isProjectTrusted(options.projectPath)
    if (!trusted) {
      const choice = await askForTrust(options, projectServersToUse)
      if (choice === 'exit') {
        options.onExitRequested?.()
        // Even if the CLI doesn't shut down, returning an empty registry
        // keeps the rest of the loader well-defined.
        return { registry: emptyRegistry(), configErrors, projectSkipped: true }
      }
      if (choice === 'skip') {
        projectServersToUse = {}
        projectSkipped = true
      }
      if (choice === 'trust') {
        await trustProject(options.projectPath).catch((err) => {
          debugLog('mcp.trust-write-failed', String(err))
        })
      }
    }
  }

  // Merge order: user → plugin → project. Plugin-contributed servers
  // (`extraServers`) sit between user and project on purpose:
  //   - They're already-trusted (consent happened at plugin install) so
  //     they don't need to pass the trust dialog above, but
  //   - A name collision with a project-level entry still gives the
  //     project entry the win (project config is authored by the same
  //     person whose CLI is running and they may want to override a
  //     plugin's server choice).
  const merged: Record<string, McpServerConfig> = {
    ...userParsed.servers,
    ...(options.extraServers ?? {}),
    ...projectServersToUse,
  }

  // No servers configured anywhere → fast-path with an empty registry.
  // We still pass the oauthFactory so a later /mcp refresh (after the
  // user adds servers to config + restarts the CLI) would have it —
  // although in practice the empty-registry path is only hit when both
  // configs are empty at boot, and a later refresh rebuilds from disk
  // via the CLI's own loadMcpFromDisk call.
  if (Object.keys(merged).length === 0) {
    return {
      registry: new McpRegistry({ servers: [], tools: [], resources: [], oauthFactory: options.oauthProviderFor }),
      configErrors,
      projectSkipped,
    }
  }

  // Spawn / dial in parallel. Each per-server promise is wrapped in
  // .then/.catch so one timeout doesn't trip the whole boot.
  const tasks = Object.entries(merged).map(async ([name, rawConfig]) => {
    return connectOneServer(name, rawConfig, options.oauthProviderFor)
  })
  const results = await Promise.all(tasks)

  // Assemble the registry. Tool name collisions are resolved in
  // insertion order (first wins; subsequent get hash suffixes), so we
  // sort by server name for stability — otherwise the order would
  // depend on which connect() resolved first.
  results.sort((a, b) => a.server.name.localeCompare(b.server.name))

  const tools: McpToolEntry[] = []
  const resources: McpResourceEntry[] = []
  const taken = new Set<string>()

  for (const r of results) {
    for (const t of r.tools) {
      const callable = buildCallable(r.server.name, t.name, taken)
      taken.add(callable)
      tools.push({
        callableName: callable,
        rawName: t.name,
        serverName: r.server.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
      })
    }
    for (const res of r.resources) resources.push(res)
  }

  const configs = new Map<string, McpServerConfig>(Object.entries(merged))

  const registry = new McpRegistry({
    servers: results.map((r) => r.server),
    tools,
    resources,
    configs,
    oauthFactory: options.oauthProviderFor,
  })

  return { registry, configErrors, projectSkipped }
}

async function askForTrust(
  options: LoadOptions,
  projectServers: Record<string, McpServerConfig>,
): Promise<TrustChoice> {
  const summaries = Object.entries(projectServers).map(([name, cfg]) => ({
    name,
    preview: buildServerPreview(cfg as { command?: string; args?: string[]; url?: string }),
  }))
  try {
    return await promptForTrust(options.projectPath, summaries, options.askUser)
  } catch (err) {
    // If the prompt machinery itself fails (no TTY etc.), err on the
    // safe side: skip project config. Logged for debugging.
    debugLog('mcp.trust-prompt-failed', String(err))
    return 'skip'
  }
}

/** Read just the `mcpServers` field out of a JSON config file. Returns
 *  undefined for missing file / parse error / missing field — all of
 *  which mean "no MCP servers configured here", never an error to
 *  surface upward. */
async function readMcpServersFromFile(filePath: string): Promise<Record<string, McpServerConfig> | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> }
    if (parsed && typeof parsed === 'object' && parsed.mcpServers) {
      return parsed.mcpServers
    }
    return undefined
  } catch (err) {
    debugLog('mcp.config-parse-failed', `${filePath}: ${String(err)}`)
    return undefined
  }
}
