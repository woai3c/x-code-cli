// @x-code-cli/core — MCP registry
//
// Built once at CLI startup by `loadMcpServers`, then frozen for the
// session lifetime. The freeze is deliberate — see CLAUDE.md on
// `systemPromptCache`: any change to the tool surface mid-session would
// invalidate the prompt cache OpenAI-compatible providers rely on for
// prefix matching. `/mcp refresh` works by REPLACING the whole registry
// with a freshly-built one and explicitly setting the session's
// systemPromptCache to null, rather than mutating this one.
import type { McpClient } from './client.js'
import type { McpCallResult, McpResourceEntry, McpServerStatus, McpToolEntry } from './types.js'

export interface RegisteredServer {
  name: string
  client: McpClient
  status: McpServerStatus
  /** When status is `failed`, the most recent stderr tail (stdio only).
   *  Used by /mcp list to show why a server failed. */
  stderrTail?: string
}

export class McpRegistry {
  /** callableName → entry. callableName is the model-facing
   *  `mcp__<server>__<tool>` form; collisions resolved at insert time. */
  private readonly entries = new Map<string, McpToolEntry>()
  /** uri → entry. URIs are unique per spec; if two servers genuinely
   *  expose the same URI we keep the first and warn (handled by loader). */
  private readonly resources = new Map<string, McpResourceEntry>()
  private readonly servers = new Map<string, RegisteredServer>()

  constructor(input: { servers: RegisteredServer[]; tools: McpToolEntry[]; resources: McpResourceEntry[] }) {
    for (const s of input.servers) this.servers.set(s.name, s)
    for (const t of input.tools) this.entries.set(t.callableName, t)
    for (const r of input.resources) this.resources.set(r.uri, r)
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
   *  and from `/mcp refresh` before building the replacement registry. */
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
}

/** Empty registry — used when MCP is disabled entirely (no mcpServers
 *  in config, or trust dialog rejected). Cheaper than null-checking the
 *  registry everywhere downstream. */
export function emptyRegistry(): McpRegistry {
  return new McpRegistry({ servers: [], tools: [], resources: [] })
}
