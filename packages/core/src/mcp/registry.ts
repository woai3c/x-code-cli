// @x-code-cli/core — MCP registry
//
// Built once at CLI startup by `loadMcpServers`, then largely stable for
// the session — but no longer fully frozen. Two mutating surfaces exist:
//
//   - `restartAll(newConfigs?)` (used by /mcp refresh) — disconnect + reconnect
//     every server, optionally swapping in a freshly-read config from disk so
//     newly-added entries show up without a CLI restart.
//   - `authenticateServer(name, hooks)` (used by /mcp auth <name>) — drive a
//     fresh OAuth round-trip for one HTTP server, then reconnect it.
//
// Both methods mutate the registry's internal maps in place so that the
// `options.mcpRegistry` reference held by `AgentOptions` keeps pointing at
// a valid registry — the agent loop and tool-execution don't need to
// rewire anything. Callers are responsible for nulling out
// `state.systemPromptCache` afterwards: the tool surface has changed, and
// OpenAI-compatible providers' prefix cache (see CLAUDE.md on the byte-
// stability constraint) must be invalidated. The `/mcp` slash command
// handler in App.tsx does that via `invalidateSystemPromptCache()` on
// useAgent.
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'

import { debugLog } from '../utils.js'
import { McpClient } from './client.js'
import { UnsafeEnvError, assertSafeEnv } from './env-safety.js'
import { EnvExpansionError, expandEnvDeep } from './expand-env.js'
import { buildCallableName } from './name-mangling.js'
import {
  type McpCallResult,
  type McpResourceEntry,
  type McpServerConfig,
  type McpServerStatus,
  type McpToolEntry,
  isHttpConfig,
  isStdioConfig,
} from './types.js'

/** Build an OAuth provider for one HTTP server. Stdio servers get
 *  `undefined`. Returns `undefined` for HTTP servers too when OAuth is
 *  not wired up at the CLI level (no token storage configured). */
export type OAuthProviderFactory = (serverName: string, serverUrl: string) => OAuthClientProvider | undefined

export interface RegisteredServer {
  name: string
  client: McpClient
  status: McpServerStatus
  /** When status is `failed`, the most recent stderr tail (stdio only).
   *  Used by /mcp list to show why a server failed. */
  stderrTail?: string
}

/** Hooks the /mcp auth handler hands in so the registry can surface
 *  human-visible progress without depending on the CLI layer. */
export interface AuthHooks {
  /** Called once just before the browser is opened. Receives the
   *  authorization URL the SDK is about to redirect to. */
  onBrowserOpen?: (url: string) => void
}

/** Summary of what `restartAll` actually changed, for the /mcp refresh
 *  output line. */
export interface RestartSummary {
  /** Server names present after restart that weren't present before. */
  added: string[]
  /** Server names removed (present before, not in new config). */
  removed: string[]
  /** Server names present in both but whose config differs. */
  changed: string[]
  /** Server names that survived restart unchanged. */
  unchanged: string[]
}

export class McpRegistry {
  /** callableName → entry. callableName is the model-facing
   *  `<server>__<tool>` form; collisions resolved at insert time. */
  private readonly entries = new Map<string, McpToolEntry>()
  /** uri → entry. URIs are unique per spec; if two servers genuinely
   *  expose the same URI we keep the first and warn (handled by loader). */
  private readonly resources = new Map<string, McpResourceEntry>()
  private readonly servers = new Map<string, RegisteredServer>()
  /** Most-recently-loaded config per server. The source of truth for
   *  `restartServer` (which reconnects with the same config) and for
   *  diff'ing in `restartAll` when fresh configs are handed in. */
  private readonly configs = new Map<string, McpServerConfig>()
  /** Factory for per-server OAuth providers. Optional — undefined means
   *  HTTP servers requiring auth will surface as `needs_auth` and the
   *  /mcp auth handler can't drive them. */
  private oauthFactory: OAuthProviderFactory | undefined

  constructor(input: {
    servers: RegisteredServer[]
    tools: McpToolEntry[]
    resources: McpResourceEntry[]
    /** Per-server config used at boot. Required for `restartServer` /
     *  `authenticateServer` to know what to rebuild. */
    configs?: Map<string, McpServerConfig>
    /** OAuth provider factory threaded through from the CLI. */
    oauthFactory?: OAuthProviderFactory
  }) {
    for (const s of input.servers) this.servers.set(s.name, s)
    for (const t of input.tools) this.entries.set(t.callableName, t)
    for (const r of input.resources) this.resources.set(r.uri, r)
    if (input.configs) for (const [k, v] of input.configs) this.configs.set(k, v)
    this.oauthFactory = input.oauthFactory
  }

  // ── Tool surface ───────────────────────────────────────────────────────

  /** Snapshot of every model-facing tool name; stable iteration order.
   *  Consumed by `buildTools` (agent loop) and `buildSystemPrompt`. */
  list(): McpToolEntry[] {
    return [...this.entries.values()]
  }

  get(callableName: string): McpToolEntry | undefined {
    return this.entries.get(callableName)
  }

  // ── Resource surface ───────────────────────────────────────────────────

  listResources(): McpResourceEntry[] {
    return [...this.resources.values()]
  }

  /** Find the server that owns a given URI so the resource tool can
   *  dispatch the read. Returns undefined for unknown URIs. */
  resourceServer(uri: string): McpClient | undefined {
    const r = this.resources.get(uri)
    if (!r) return undefined
    return this.servers.get(r.serverName)?.client
  }

  // ── Server surface (for /mcp list / status) ───────────────────────────

  serverStatus(): Array<{ name: string; status: McpServerStatus; stderrTail?: string }> {
    return [...this.servers.values()].map((s) => ({
      name: s.name,
      status: s.status,
      stderrTail: s.stderrTail,
    }))
  }

  getServer(serverName: string): RegisteredServer | undefined {
    return this.servers.get(serverName)
  }

  getConfig(serverName: string): McpServerConfig | undefined {
    return this.configs.get(serverName)
  }

  // ── Dispatch ───────────────────────────────────────────────────────────

  /** Call an MCP tool by its model-facing callable name. Looks up the
   *  entry, finds its owning server, and forwards to the SDK client. */
  async callTool(callableName: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    const entry = this.entries.get(callableName)
    if (!entry) throw new Error(`MCP tool not found: ${callableName}`)
    const server = this.servers.get(entry.serverName)
    if (!server) throw new Error(`MCP server gone: ${entry.serverName}`)
    return server.client.callTool(entry.rawName, args, signal)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Disconnect every server cleanly. Best-effort: one bad shutdown
   *  doesn't prevent others from running. Called from the CLI exit hook
   *  and (internally) by `restartAll` before rebuilding. */
  async shutdown(): Promise<void> {
    const tasks: Promise<void>[] = []
    for (const s of this.servers.values()) {
      tasks.push(
        s.client.close().catch(() => {
          // already logged in client.safeClose; nothing useful to do here
        }),
      )
    }
    await Promise.allSettled(tasks)
  }

  // ── Restart / refresh ──────────────────────────────────────────────────

  /** Reconnect one server in-place using its current config. Used by
   *  `authenticateServer` (after fresh tokens are saved) and exposed for
   *  callers that want a per-server reload without a full refresh.
   *
   *  Tool / resource entries from the old connection are dropped and
   *  replaced with whatever the new connection enumerates — tool names
   *  may change if the server's `tools/list` output changes between
   *  reconnects. Callers must invalidate the agent's systemPromptCache
   *  after this returns. */
  async restartServer(name: string, opts: { driveOAuth?: AuthHooks } = {}): Promise<RegisteredServer> {
    const config = this.configs.get(name)
    if (!config) {
      throw new Error(`No MCP server registered as "${name}"`)
    }
    // Close the existing client (if any) before spawning a replacement —
    // for stdio servers this kills the previous child process so we
    // don't leave a zombie behind. Errors are non-fatal: a broken
    // connection that can't be closed cleanly should still be replaced.
    const existing = this.servers.get(name)
    if (existing) {
      try {
        await existing.client.close()
      } catch (err) {
        debugLog('mcp.restart-close-failed', `${name}: ${String(err)}`)
      }
    }

    // Strip old tools / resources owned by this server. Done *before*
    // the new connect so a partial failure mid-reconnect leaves us in a
    // consistent "nothing from this server" state rather than a mix of
    // old + nothing.
    this.removeServerEntries(name)

    const result = await connectOneServer(name, config, this.oauthFactory, opts.driveOAuth)
    this.installServer(result)
    return result.server
  }

  /** Disconnect everything and rebuild against `newConfigs` (or the
   *  existing configs if omitted). Returns a diff summary so the UI
   *  can tell the user what actually changed.
   *
   *  Used by `/mcp refresh`: re-read the user + project config files,
   *  hand the merged map in here, and we'll add / remove / restart the
   *  appropriate set. Servers whose config bytes didn't change are
   *  still reconnected — fresher to the user, simpler than diffing
   *  every nested field. */
  async restartAll(newConfigs?: Map<string, McpServerConfig>): Promise<RestartSummary> {
    const oldNames = new Set(this.configs.keys())
    const newNames = new Set((newConfigs ?? this.configs).keys())

    const summary: RestartSummary = {
      added: [...newNames].filter((n) => !oldNames.has(n)),
      removed: [...oldNames].filter((n) => !newNames.has(n)),
      changed: [],
      unchanged: [],
    }

    if (newConfigs) {
      for (const name of newNames) {
        if (!oldNames.has(name)) continue
        const before = JSON.stringify(this.configs.get(name))
        const after = JSON.stringify(newConfigs.get(name))
        if (before !== after) summary.changed.push(name)
        else summary.unchanged.push(name)
      }
    } else {
      summary.unchanged = [...newNames]
    }

    // Tear down everything first. Doing close-all then connect-all
    // (rather than per-server close+connect) is more predictable: we
    // never have two clients for the same server alive at once, and
    // stdio child processes definitely exit before their replacements
    // spawn.
    await this.shutdown()

    // Reset internal state. We keep the OAuth factory because that
    // came from the CLI process and isn't tied to any one config.
    this.servers.clear()
    this.entries.clear()
    this.resources.clear()
    this.configs.clear()
    const effective = newConfigs ?? new Map<string, McpServerConfig>()
    for (const [k, v] of effective) this.configs.set(k, v)

    // Reconnect in parallel — same approach as initial boot. Each
    // failure is recorded as `status: failed` rather than aborting the
    // restart.
    const tasks = [...effective.entries()].map(async ([name, config]) => {
      try {
        return await connectOneServer(name, config, this.oauthFactory)
      } catch (err) {
        debugLog('mcp.restartAll-connect-failed', `${name}: ${String(err)}`)
        return null
      }
    })
    const results = await Promise.all(tasks)

    // Sort by name so tool insertion order is stable (matches initial-
    // boot behaviour in loader.ts).
    const installable = results
      .filter((r): r is ConnectResult => r !== null)
      .sort((a, b) => a.server.name.localeCompare(b.server.name))
    for (const r of installable) this.installServer(r)

    return summary
  }

  /** Drive a fresh OAuth round-trip for one HTTP server, then reconnect
   *  it. Used by `/mcp auth <name>`.
   *
   *  Pre-condition: the caller should have just cleared any stale
   *  tokens for this server via the token storage's `clear()` —
   *  otherwise an existing-but-expired token could short-circuit the
   *  re-auth path and reuse the bad state.
   *
   *  Returns the post-auth server state. Throws if the server is stdio
   *  (no OAuth needed), if no OAuth factory is wired up, or if the
   *  user closes the browser tab / the callback times out. */
  async authenticateServer(name: string, hooks: AuthHooks = {}): Promise<RegisteredServer> {
    const config = this.configs.get(name)
    if (!config) throw new Error(`No MCP server registered as "${name}"`)
    if (!isHttpConfig(config)) {
      throw new Error(`MCP server "${name}" is stdio — OAuth applies to HTTP servers only`)
    }
    if (!this.oauthFactory) {
      throw new Error(`OAuth not configured — set a token storage in the loader to use /mcp auth`)
    }

    return this.restartServer(name, { driveOAuth: hooks })
  }

  /** Replace the OAuth factory wholesale. Used by the CLI when the
   *  token storage / onBrowserOpen wiring is built lazily after the
   *  registry has been constructed (rare, but the test harness needs
   *  to swap it). */
  setOAuthFactory(factory: OAuthProviderFactory | undefined): void {
    this.oauthFactory = factory
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Drop every tool + resource owned by this server. Idempotent. */
  private removeServerEntries(name: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.serverName === name) this.entries.delete(key)
    }
    for (const [key, res] of this.resources) {
      if (res.serverName === name) this.resources.delete(key)
    }
  }

  /** Install a fresh ConnectResult into the maps. Caller is responsible
   *  for having removed any previous entries for the same server first. */
  private installServer(r: ConnectResult): void {
    this.servers.set(r.server.name, r.server)
    const taken = new Set(this.entries.keys())
    for (const t of r.tools) {
      const callable = buildCallableName(r.server.name, t.name, taken)
      taken.add(callable)
      this.entries.set(callable, {
        callableName: callable,
        rawName: t.name,
        serverName: r.server.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
      })
    }
    for (const res of r.resources) this.resources.set(res.uri, res)
  }
}

/** Empty registry — used when MCP is disabled entirely (no mcpServers
 *  in config, or trust dialog rejected). Cheaper than null-checking the
 *  registry everywhere downstream. */
export function emptyRegistry(): McpRegistry {
  return new McpRegistry({ servers: [], tools: [], resources: [] })
}

// ── Connect helper (shared with loader.ts on initial boot) ──────────────

/** One server's worth of "connect + enumerate" output. Shared between
 *  initial boot (`loadMcpServers`) and the registry's restart paths so
 *  the connect-shape stays consistent. */
export interface ConnectResult {
  server: RegisteredServer
  tools: ReadonlyArray<{ name: string; description?: string; inputSchema: Record<string, unknown> }>
  resources: ReadonlyArray<McpResourceEntry>
}

/** Build a client for one server, run the connect handshake, and report
 *  the enumerated capabilities. `driveOAuth` (when set) opts into the
 *  full browser-based OAuth flow on UnauthorizedError; without it,
 *  UnauthorizedError surfaces as `status: needs_auth` and the user is
 *  expected to invoke /mcp auth explicitly. */
export async function connectOneServer(
  name: string,
  rawConfig: McpServerConfig,
  oauthFactory: OAuthProviderFactory | undefined,
  driveOAuth?: AuthHooks,
): Promise<ConnectResult> {
  // Honour `enabled: false` — register but skip the connection.
  if (rawConfig.enabled === false) {
    const client = new McpClient(name, rawConfig)
    return {
      server: { name, client, status: { kind: 'disabled' } },
      tools: [],
      resources: [],
    }
  }

  // Expand ${VAR} references before constructing the client. Then enforce
  // the env safety check on stdio configs — this is the single chokepoint
  // every env source (CLI flag, mcp.json, plugin manifest) flows through,
  // so rejecting a bad key here covers them all. See env-safety.ts for the
  // threat model.
  let expanded: McpServerConfig
  try {
    expanded = expandEnvDeep(rawConfig)
    if (isStdioConfig(expanded)) assertSafeEnv(expanded.env)
  } catch (err) {
    const msg =
      err instanceof EnvExpansionError || err instanceof UnsafeEnvError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err)
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
    const info = driveOAuth ? await client.connectWithOAuth(driveOAuth) : await client.connect()
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
    const needsAuth = /unauth|401|UnauthorizedError/i.test(msg) && isHttpConfig(expanded)
    const status: RegisteredServer['status'] = needsAuth ? { kind: 'needs_auth' } : { kind: 'failed', error: msg }
    return {
      server: { name, client, status, stderrTail: client.stderr() || undefined },
      tools: [],
      resources: [],
    }
  }
}
