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
import os from 'node:os'
import path from 'node:path'

import { type BrowserConfig, loadUserConfig } from '../../config/index.js'
import { buildCallableName } from '../../mcp/name-mangling.js'
import { McpPermissionStore } from '../../mcp/permissions.js'
import { McpRegistry, connectOneServer } from '../../mcp/registry.js'
import type { McpServerConfig, McpToolEntry } from '../../mcp/types.js'
import { debugLog } from '../../utils.js'

/** Browser tools we NEVER expose to the agent. `browser_run_code_unsafe` runs
 *  arbitrary Node code (fs access and all) inside the MCP server process — it
 *  bypasses the browser agent's sandbox (which deliberately denies shell /
 *  writeFile / edit) and, in testing, the model kept falling into it to brute-
 *  force tasks instead of using the snapshot/screenshot tools. Drop it entirely.
 *  (Comparable CLIs gate page-script execution behind confirmation rather than
 *  exposing a raw code-runner — see SENSITIVE_BROWSER_TOOLS.) */
const EXCLUDED_BROWSER_TOOLS = new Set(['browser_run_code_unsafe'])

/** Browser tools that stay available but are NOT pre-approved, so each call
 *  prompts the user. `browser_evaluate` runs arbitrary JavaScript in the
 *  (untrusted) page: it can read cookies / localStorage and issue requests as
 *  the logged-in page, so a page-injected instruction could turn it into a data
 *  exfiltration step. That's worth a per-call confirmation even though the
 *  browser agent is opt-in — routine navigate/click/snapshot/screenshot stay
 *  pre-approved, so only this one prompts. (The flailing-stall we saw came from
 *  the agent over-using evaluate on a vague task; the "match effort to the task"
 *  prompt guidance curbs that, so the prompt fires rarely.) The truly dangerous
 *  `browser_run_code_unsafe` — raw Node/fs — is EXCLUDED entirely, not gated. */
const SENSITIVE_BROWSER_TOOLS = new Set(['browser_evaluate'])

/** Build the stdio config that launches the browser MCP. A `command` override
 *  wins (advanced: offline / pinned version / custom server). Otherwise default
 *  to `npx -y @playwright/mcp@latest --browser <channel> [--headless] [--caps vision]`.
 *  On Windows, npx must run through cmd.exe — spawning the bare `npx` shim
 *  fails (it resolves to `npx.cmd`).
 *
 *  `vision` adds `--caps vision`, which is ADDITIVE: it layers the screenshot +
 *  coordinate-mouse tools (browser_take_screenshot is already core;
 *  browser_mouse_*_xy come from the cap) on top of the accessibility-tree
 *  tools — the tree stays the default, visual is the fallback for canvas/WebGL.
 *  A `command` override ignores `vision` (the caller owns the full argv). */
export function buildBrowserServerConfig(cfg: BrowserConfig, vision = false): McpServerConfig {
  // Generous first-connect timeout: a cold npx may download @playwright/mcp and
  // then launch a browser, well past the 30 s default.
  const timeout = 120_000
  if (cfg.command) {
    return { command: cfg.command, args: cfg.args ?? [], timeout }
  }
  const args = ['-y', '@playwright/mcp@latest', '--browser', cfg.browser ?? 'chrome']
  if (cfg.headless) args.push('--headless')
  if (vision) args.push('--caps', 'vision')
  // Bound the viewport so a (non-fullPage) screenshot has a capped resolution.
  // Vision-model token cost scales with image DIMENSIONS, not bytes, so a small
  // viewport is the cheapest lever against runaway screenshot tokens. 1280x800
  // fits the typical above-the-fold layout; the agent scrolls for more rather
  // than taking a giant fullPage shot.
  args.push('--viewport-size', cfg.viewport ?? '1280,800')
  // Saved screenshots / traces go to a temp dir, not the default `.playwright-mcp/`
  // under the CLI's cwd (which litters the user's repo). The agent is told to
  // screenshot WITHOUT a filename (inline image) anyway, so this only catches
  // the occasional explicit save.
  args.push('--output-dir', path.join(os.tmpdir(), 'x-code-browser'))
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
export async function getBrowserMcp(vision = false): Promise<BrowserMcp> {
  if (cached) return cached
  if (connecting) return connecting
  // The first connect fixes the server's capabilities for the session. That's
  // fine: vision reachability is static (it depends on which provider keys are
  // set, not on the per-call model), so every browser task this session agrees
  // on the same `vision` value. Switching the active model later doesn't change
  // whether `--caps vision` should have been passed.
  connecting = connectBrowser(vision)
  try {
    return await connecting
  } finally {
    connecting = null
  }
}

async function connectBrowser(vision: boolean): Promise<BrowserMcp> {
  const config = buildBrowserServerConfig(loadUserConfig().browser ?? {}, vision)
  const result = await connectOneServer('browser', config, undefined)

  // Name-mangle the server's tools the same way the loader does on boot.
  // Dangerous tools are dropped here, by raw name, so they never enter the
  // registry regardless of how the callable name is mangled.
  const tools: McpToolEntry[] = []
  const taken = new Set<string>()
  for (const t of result.tools) {
    if (EXCLUDED_BROWSER_TOOLS.has(t.name)) continue
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
  // consent for routine navigation — pre-approve every browser tool so
  // navigate/click/snapshot/screenshot calls don't each hit a per-tool prompt.
  // Genuinely sensitive tools (SENSITIVE_BROWSER_TOOLS — page-script evaluation)
  // are left unapproved so they still prompt per call.
  const permissions = new McpPermissionStore()
  for (const t of tools) {
    if (SENSITIVE_BROWSER_TOOLS.has(t.rawName)) continue
    permissions.approveForSession(t.callableName)
  }

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
