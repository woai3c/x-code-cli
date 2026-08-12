// @x-code-cli/core — Managed browser MCP bootstrap
//
// The one-shot root visual check and the interactive `browser` sub-agent share
// a real browser driven through @playwright/mcp. The server stays in a PRIVATE
// McpRegistry — never the global one the main loop holds — so the full browser
// tool set stays out of the main system prompt and every unrelated agent. The
// root can only reach it through its narrow browserVisualCheck orchestrator.
//
// The server (and its browser) is spawned lazily on first browser task and
// cached for the session, so repeat checks/interactions reuse it. It is a
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
export const PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp@0.0.79'

/** Build the stdio config that launches the browser MCP. A `command` override
 *  wins (advanced: offline / pinned version / custom server). Otherwise default
 *  to a tested, pinned @playwright/mcp release so an automatic visual check
 *  cannot silently execute a different package version between sessions.
 *  On Windows, npx must run through cmd.exe — spawning the bare `npx` shim
 *  fails (it resolves to `npx.cmd`).
 *
 *  Unless cfg.vision is false, `--caps vision` adds coordinate-mouse tools on
 *  top of the accessibility tree (browser_take_screenshot itself is core). A
 *  command override owns its complete argv and therefore ignores this setting. */
export function buildBrowserServerConfig(cfg: BrowserConfig): McpServerConfig {
  // Generous first-connect timeout: a cold npx may download @playwright/mcp and
  // then launch a browser, well past the 30 s default.
  const timeout = 120_000
  if (cfg.command) {
    return { command: cfg.command, args: cfg.args ?? [], timeout }
  }
  const args = ['-y', PLAYWRIGHT_MCP_PACKAGE, '--browser', cfg.browser ?? 'chrome']
  if (cfg.headless) args.push('--headless')
  // Keep the server capability stable across active-model changes. Coordinate
  // tools stay private and are filtered out of a browser agent that has no way
  // to interpret screenshots; launching the superset avoids restarting Chrome
  // (and losing tabs) after a later switch to a vision-capable model.
  if (cfg.vision !== false) args.push('--caps', 'vision')
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
  /** True when the connected server actually exposed coordinate vision tools. */
  vision: boolean
  error?: string
}

let cached: BrowserMcp | null = null
let generation = 0

interface BrowserConnectAttempt {
  controller: AbortController
  promise: Promise<BrowserMcp>
  waiters: number
}

let connecting: BrowserConnectAttempt | null = null

function browserFailure(error: string): BrowserMcp {
  return {
    ok: false,
    registry: new McpRegistry({ servers: [], tools: [], resources: [] }),
    permissions: new McpPermissionStore(),
    toolCount: 0,
    vision: false,
    error,
  }
}

function abortReason(signal: AbortSignal, fallback = 'Browser startup aborted'): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException(fallback, 'AbortError')
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(abortReason(signal))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (err) => {
        cleanup()
        reject(err)
      },
    )
  })
}

/** Connect to the browser MCP and return its private registry + permission
 *  store for the visual check or browser sub-agent. Caches a live connection
 *  for the session, but de-dups concurrent first-acquires and
 *  self-heals: if the browser/server connection drops (user closes Chrome,
 *  crash) the cache is invalidated so the next acquire reconnects. A failed
 *  connect is NOT cached, so a retry works after the user fixes setup. */
export async function getBrowserMcp(abortSignal?: AbortSignal): Promise<BrowserMcp> {
  if (abortSignal?.aborted) throw abortReason(abortSignal)
  if (cached) return cached

  // A previous caller may have cancelled the only in-flight cold start. Wait
  // for that subprocess to finish closing before launching its replacement;
  // attaching a fresh caller to an already-aborted attempt would return a
  // misleading failure and racing two Chrome profiles can hit a lock.
  if (connecting?.controller.signal.aborted) {
    const stale = connecting
    await stale.promise
    if (connecting === stale) connecting = null
    if (abortSignal?.aborted) throw abortReason(abortSignal)
    if (cached) return cached
  }

  let attempt = connecting
  if (!attempt) {
    const controller = new AbortController()
    const attemptGeneration = generation
    const created = {} as BrowserConnectAttempt
    created.controller = controller
    created.waiters = 0
    created.promise = connectBrowser(controller.signal)
      .then(async (value) => {
        if (attemptGeneration !== generation || controller.signal.aborted) {
          if (value.ok) await value.registry.shutdown().catch(() => undefined)
          return browserFailure('Browser startup was cancelled')
        }
        if (value.ok) cached = value
        return value
      })
      .catch((err) => browserFailure(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        if (connecting === created) connecting = null
      })
    connecting = created
    attempt = created
  }

  attempt.waiters++
  let callerAborted = false
  try {
    return await waitWithSignal(attempt.promise, abortSignal)
  } catch (err) {
    callerAborted = abortSignal?.aborted === true
    throw err
  } finally {
    attempt.waiters--
    if (
      callerAborted &&
      abortSignal &&
      attempt.waiters === 0 &&
      connecting === attempt &&
      !attempt.controller.signal.aborted
    ) {
      attempt.controller.abort(abortReason(abortSignal))
    }
  }
}

async function connectBrowser(abortSignal: AbortSignal): Promise<BrowserMcp> {
  const config = buildBrowserServerConfig(loadUserConfig().browser ?? {})
  const result = await connectOneServer('browser', config, undefined, undefined, abortSignal)

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
    return browserFailure(`${reason}${tail}`)
  }

  const registry = new McpRegistry({
    servers: [result.server],
    tools,
    resources: [...result.resources],
    configs: new Map([['browser', config]]),
  })
  // Enabling the interactive browser agent is consent for routine navigation.
  // These permissions are used only by that sub-agent; the root visual check
  // calls a fixed, narrow sequence directly and cannot select arbitrary tools.
  const permissions = new McpPermissionStore()
  for (const t of tools) {
    if (SENSITIVE_BROWSER_TOOLS.has(t.rawName)) continue
    permissions.approveForSession(t.callableName)
  }

  const value: BrowserMcp = {
    ok: true,
    registry,
    permissions,
    toolCount: tools.length,
    vision: tools.some((tool) => tool.rawName.startsWith('browser_mouse_')),
  }
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
  generation++
  const attempt = connecting
  const current = cached
  cached = null
  if (attempt && !attempt.controller.signal.aborted) {
    attempt.controller.abort(new DOMException('Browser shutdown requested', 'AbortError'))
  }
  await Promise.all([
    current?.ok ? current.registry.shutdown().catch(() => undefined) : Promise.resolve(),
    attempt?.promise.then(
      () => undefined,
      () => undefined,
    ) ?? Promise.resolve(),
  ])
}
