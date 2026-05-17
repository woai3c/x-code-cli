// @x-code-cli/core — MCP startup loader
//
// One-shot orchestration called from the CLI entry: read user + project
// configs, apply the trust gate to anything project-level, expand env
// vars, spawn / dial every enabled server in parallel, build a frozen
// registry. Failures on individual servers are recorded but never abort
// the boot — `/mcp list` is the user's window into what went wrong.
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'

import fs from 'node:fs/promises'
import path from 'node:path'

import { getUserConfigPath } from '../config/index.js'
import { XCODE_DIR, debugLog } from '../utils.js'
import { McpClient } from './client.js'
import { parseServersBlock } from './config-schema.js'
import { EnvExpansionError, expandEnvDeep } from './expand-env.js'
import { buildCallableName } from './name-mangling.js'
import { McpRegistry, type RegisteredServer, emptyRegistry } from './registry.js'
import { type TrustChoice, buildServerPreview, isProjectTrusted, promptForTrust, trustProject } from './trust.js'
import { type McpResourceEntry, type McpServerConfig, type McpToolEntry, isHttpConfig } from './types.js'

/** Resolve the OAuth provider for a single HTTP server. Returns
 *  undefined for stdio (auth is the server's problem) or when no auth
 *  has been set up yet — the first connect will then 401 and the user
 *  is told to run `/mcp auth <name>`. */
export type OAuthProviderFactory = (serverName: string, serverUrl: string) => OAuthClientProvider | undefined

export interface LoadOptions {
  /** mcpServers from ~/.x-code/config.json. Trusted implicitly. */
  userServers: Record<string, McpServerConfig> | undefined
  /** mcpServers from <project>/.x-code/config.json. Requires consent. */
  projectServers: Record<string, McpServerConfig> | undefined
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
}): Promise<LoadResult> {
  const userServers = await readMcpServersFromFile(getUserConfigPath())
  const projectServers = await readMcpServersFromFile(path.join(opts.cwd, XCODE_DIR, 'config.json'))
  return loadMcpServers({
    userServers,
    projectServers,
    projectPath: opts.cwd,
    askUser: opts.askUser,
    oauthProviderFor: opts.oauthProviderFor,
    onExitRequested: opts.onExitRequested,
  })
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

  // Merge user + project. Project-level entries shadow user-level entries
  // on name conflict (project wins by design — user explicitly trusted it).
  const merged: Record<string, McpServerConfig> = { ...userParsed.servers, ...projectServersToUse }

  // No servers configured anywhere → fast-path with an empty registry.
  if (Object.keys(merged).length === 0) {
    return { registry: emptyRegistry(), configErrors, projectSkipped }
  }

  // Spawn / dial in parallel. Each per-server promise is wrapped in
  // .then/.catch so one timeout doesn't trip the whole boot.
  const tasks = Object.entries(merged).map(async ([name, rawConfig]) => {
    const result = await connectOneServer(name, rawConfig, options.oauthProviderFor)
    return result
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
      const callable = buildCallableName(r.server.name, t.name, taken)
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

  const registry = new McpRegistry({
    servers: results.map((r) => r.server),
    tools,
    resources,
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

interface ConnectResult {
  server: RegisteredServer
  tools: ReadonlyArray<{ name: string; description?: string; inputSchema: Record<string, unknown> }>
  resources: ReadonlyArray<McpResourceEntry>
}

async function connectOneServer(
  name: string,
  rawConfig: McpServerConfig,
  oauthFactory: OAuthProviderFactory | undefined,
): Promise<ConnectResult> {
  // Honour the `enabled: false` switch — register the server but skip
  // the connection. Shows up in /mcp list as `disabled`.
  if (rawConfig.enabled === false) {
    const client = new McpClient(name, rawConfig)
    return {
      server: { name, client, status: { kind: 'disabled' } },
      tools: [],
      resources: [],
    }
  }

  // Expand ${VAR} references. Done AFTER schema validation but BEFORE
  // constructing the client — the client should never see literal
  // unexpanded references.
  let expanded: McpServerConfig
  try {
    expanded = expandEnvDeep(rawConfig)
  } catch (err) {
    const msg = err instanceof EnvExpansionError ? err.message : err instanceof Error ? err.message : String(err)
    const client = new McpClient(name, rawConfig)
    return {
      server: { name, client, status: { kind: 'failed', error: msg } },
      tools: [],
      resources: [],
    }
  }

  const authProvider = oauthFactory && isHttpConfig(expanded) ? oauthFactory(name, expanded.url) : undefined

  const client = new McpClient(name, expanded, authProvider)
  try {
    const info = await client.connect()
    return {
      server: {
        name,
        client,
        status: { kind: 'connected', toolCount: info.toolCount, resourceCount: info.resourceCount },
      },
      tools: client.tools(),
      resources: client.resources(),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Heuristic: SDK throws `UnauthorizedError` (or similar) on 401.
    // Surface that as needs_auth instead of generic failure so the UI
    // can route the user to /mcp auth.
    const needsAuth = /unauth|401|UnauthorizedError/i.test(msg) && isHttpConfig(expanded)
    const status: RegisteredServer['status'] = needsAuth ? { kind: 'needs_auth' } : { kind: 'failed', error: msg }
    return {
      server: { name, client, status, stderrTail: client.stderr() || undefined },
      tools: [],
      resources: [],
    }
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
