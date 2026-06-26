// @x-code-cli/core — Browser sub-agent MCP bootstrap
//
// The `browser` sub-agent drives a real browser through the @playwright/mcp
// server. We connect that server into a PRIVATE McpRegistry — never the global
// one the main loop holds — so its browser tools stay out of the main system
// prompt (which must remain byte-stable for prefix caching, see CLAUDE.md) and
// out of every other agent. Only runSubAgent, when running the `browser` agent,
// hands this registry in via subOptions.mcpRegistry.
//
// The server (and its browser) is spawned lazily on first browser-agent use and
// cached for the session, so repeat invocations reuse the same browser. It is a
// stdio subprocess; the CLI's gracefulShutdown calls shutdownBrowserMcp so the
// browser exits with the CLI.
import { type BrowserConfig, loadUserConfig } from '../../config/index.js'
import { buildCallableName } from '../../mcp/name-mangling.js'
import { McpPermissionStore } from '../../mcp/permissions.js'
import { McpRegistry, connectOneServer } from '../../mcp/registry.js'
import type { McpServerConfig, McpToolEntry } from '../../mcp/types.js'
import { debugLog } from '../../utils.js'

/** Build the stdio config that launches the browser MCP. A `command` override
 *  wins (advanced: offline / pinned version / custom server). Otherwise default
 *  to `npx -y @playwright/mcp@latest --browser <channel> [--headless]`. On
 *  Windows, npx must run through cmd.exe — spawning the bare `npx` shim fails
 *  (it resolves to `npx.cmd`). */
export function buildBrowserServerConfig(cfg: BrowserConfig): McpServerConfig {
  // Generous first-connect timeout: a cold npx may download @playwright/mcp and
  // then launch a browser, well past the 30 s default.
  const timeout = 120_000
  if (cfg.command) {
    return { command: cfg.command, args: cfg.args ?? [], timeout }
  }
  const args = ['-y', '@playwright/mcp@latest', '--browser', cfg.browser ?? 'chrome']
  if (cfg.headless) args.push('--headless')
  if (process.platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'npx', ...args], timeout }
  }
  return { command: 'npx', args, timeout }
}

export interface BrowserMcp {
  ok: boolean
  registry: McpRegistry
  permissions: McpPermissionStore
  toolCount: number
  error?: string
}

let cached: BrowserMcp | null = null
let connecting: Promise<BrowserMcp> | null = null

/** Connect to the browser MCP and return a private registry + permission store
 *  for the browser sub-agent. Caches a live connection for the session (so
 *  repeat tasks reuse one browser), but de-dups concurrent first-acquires and
 *  self-heals: if the browser/server connection drops (user closes Chrome,
 *  crash) the cache is invalidated so the next acquire reconnects. A failed
 *  connect is NOT cached, so a retry works after the user fixes setup. */
export async function getBrowserMcp(): Promise<BrowserMcp> {
  if (cached) return cached
  if (connecting) return connecting
  connecting = connectBrowser()
  try {
    return await connecting
  } finally {
    connecting = null
  }
}

async function connectBrowser(): Promise<BrowserMcp> {
  const config = buildBrowserServerConfig(loadUserConfig().browser ?? {})
  const result = await connectOneServer('browser', config, undefined)

  // Name-mangle the server's tools the same way the loader does on boot.
  const tools: McpToolEntry[] = []
  const taken = new Set<string>()
  for (const t of result.tools) {
    const callable = buildCallableName('browser', t.name, taken)
    taken.add(callable)
    tools.push({
      callableName: callable,
      rawName: t.name,
      serverName: 'browser',
      description: t.description ?? '',
      inputSchema: t.inputSchema,
    })
  }

  const status = result.server.status
  if (status.kind === 'failed' || tools.length === 0) {
    const reason = status.kind === 'failed' ? status.error : 'the browser MCP server exposed no tools'
    const tail = result.server.stderrTail ? ` — ${result.server.stderrTail.trim().slice(-300)}` : ''
    debugLog('browser.connect-failed', `${reason}${tail}`)
    await result.server.client.close().catch(() => undefined)
    // Don't cache the failure: a retry after the user installs Chrome / fixes
    // npx should work without a CLI restart.
    return {
      ok: false,
      registry: new McpRegistry({ servers: [], tools: [], resources: [] }),
      permissions: new McpPermissionStore(),
      toolCount: 0,
      error: `${reason}${tail}`,
    }
  }

  const registry = new McpRegistry({
    servers: [result.server],
    tools,
    resources: [...result.resources],
    configs: new Map([['browser', config]]),
  })
  // Enabling the browser agent (/browser on, or config.browser.enabled) IS the
  // consent — pre-approve every browser tool so routine navigate/click/snapshot
  // calls don't each hit a per-tool permission prompt. Comparable CLIs do the
  // same; a carve-out for genuinely sensitive actions can be layered on later.
  const permissions = new McpPermissionStore()
  for (const t of tools) permissions.approveForSession(t.callableName)

  const value: BrowserMcp = { ok: true, registry, permissions, toolCount: tools.length }
  cached = value
  // Self-heal: when the server/browser connection drops (Chrome closed, crash),
  // drop the cache so the next acquire reconnects instead of reusing a dead client.
  result.server.client.onClose(() => {
    if (cached === value) cached = null
  })
  return value
}

/** Close the browser MCP subprocess (and its browser). Wired into the CLI's
 *  gracefulShutdown; idempotent. */
export async function shutdownBrowserMcp(): Promise<void> {
  const current = cached
  cached = null
  if (current?.ok) await current.registry.shutdown().catch(() => undefined)
}
