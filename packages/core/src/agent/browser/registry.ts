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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { type BrowserConfig, loadUserConfig } from '../../config/index.js'
import { buildCallableName } from '../../mcp/name-mangling.js'
import { McpPermissionStore } from '../../mcp/permissions.js'
import { McpRegistry, connectOneServer } from '../../mcp/registry.js'
import type { McpServerConfig, McpToolEntry } from '../../mcp/types.js'
import { debugLog, errorMessage } from '../../utils.js'
import { sanitizeBrowserDiagnostic } from './diagnostics.js'
import { acquireBrowserProfileLease } from './profile-lease.js'

/** Browser tools we NEVER expose to the agent. `browser_run_code_unsafe` runs
 *  arbitrary Node code (fs access and all) inside the MCP server process — it
 *  bypasses the browser agent's sandbox (which deliberately denies shell /
 *  writeFile / edit) and, in testing, the model kept falling into it to brute-
 *  force tasks instead of using the snapshot/screenshot tools. The visual-check
 *  orchestrator uses one hard-coded invocation privately to close its stable
 *  Playwright Page handle; no model or page content can supply that code.
 *  (Comparable CLIs gate page-script execution behind confirmation rather than
 *  exposing a raw code-runner — see SENSITIVE_BROWSER_TOOLS.) */
const EXCLUDED_BROWSER_TOOLS = new Set(['browser_run_code_unsafe'])
const PRIVATE_BROWSER_CODE_TOOL = 'browser_run_code_unsafe'
const TAB_CLEANUP_MARKER = '__X_CODE_VISUAL_TAB_CLEANUP__:'
const TAB_PREPARED_MARKER = '__X_CODE_VISUAL_TAB_PREPARED__:'
const TAB_OWNED_MARKER = '__X_CODE_VISUAL_TAB_OWNED__:'

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

let managedOutputDirectory: string | undefined

function browserOutputDirectory(): string {
  if (!managedOutputDirectory) {
    // A random per-process directory avoids cross-workspace filename collisions
    // and predictable /tmp paths. The OS temp directory owns eventual cleanup.
    managedOutputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'x-code-browser-'))
  } else {
    // A cache cleaner may remove the directory while a long-lived CLI is idle.
    fs.mkdirSync(managedOutputDirectory, { recursive: true, mode: 0o700 })
  }
  if (process.platform !== 'win32') fs.chmodSync(managedOutputDirectory, 0o700)
  return managedOutputDirectory
}

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
  args.push('--output-dir', browserOutputDirectory())
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
  /** Synchronous lifecycle probe used at the cache boundary to close the
   *  remaining event-loop gap between connection setup and promise adoption. */
  isLive(): boolean
  /** Pin the MCP's current Page as the restoration target. */
  prepareVisualCheck(ownerId: string, abortSignal?: AbortSignal): Promise<boolean>
  /** Pin the MCP's current Page as this check's temporary Page, navigate it to
   *  the already-normalized URL, and verify that the final URL stays local. */
  markVisualCheckTab(ownerId: string, url: string, abortSignal?: AbortSignal): Promise<boolean>
  /** Close the pinned temporary Page and report the original Page's current
   *  MCP tab index. The caller must select that index through browser_tabs so
   *  the server's internal current-tab state is restored too. */
  finishVisualCheck(ownerId: string, abortSignal?: AbortSignal): Promise<BrowserVisualCleanup>
  error?: string
}

export interface BrowserVisualCleanup {
  closed: boolean
  originalTabIndex?: number
}

let cached: BrowserMcp | null = null
let generation = 0
const profileReleases = new WeakMap<BrowserMcp, () => Promise<void>>()
const pendingProfileReleases = new Set<Promise<void>>()

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
    isLive: () => false,
    prepareVisualCheck: async () => false,
    markVisualCheckTab: async () => false,
    finishVisualCheck: async () => ({ closed: false }),
    error: sanitizeBrowserDiagnostic(error, 1_000, 'Browser unavailable'),
  }
}

function resultContainsExactString(text: string, expected: string): boolean {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('"') || !line.endsWith('"')) continue
    try {
      if (JSON.parse(line) === expected) return true
    } catch {
      // Ignore non-result quoted lines from an MCP response.
    }
  }
  return false
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

function releaseBrowserProfile(browser: BrowserMcp): Promise<void> {
  const release = profileReleases.get(browser)
  if (!release) return Promise.resolve()
  const pending = release().catch((err) => {
    debugLog('browser.profile-release-failed', String(err))
  })
  pendingProfileReleases.add(pending)
  pending.then(() => {
    pendingProfileReleases.delete(pending)
  })
  return pending
}

async function closeBrowser(browser: BrowserMcp): Promise<void> {
  if (browser.ok) await browser.registry.shutdown().catch(() => undefined)
  await releaseBrowserProfile(browser)
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
  // A dropped stdio connection releases its profile asynchronously from the
  // SDK's onClose callback. Do not let an immediate self-heal race that unlink.
  if (pendingProfileReleases.size > 0) {
    await waitWithSignal(
      Promise.allSettled([...pendingProfileReleases]).then(() => undefined),
      abortSignal,
    )
  }

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
          await closeBrowser(value)
          return browserFailure('Browser startup was cancelled')
        }
        if (value.ok && !value.isLive()) {
          await closeBrowser(value)
          return browserFailure('Browser connection closed during startup; retry to reconnect')
        }
        if (value.ok) cached = value
        return value
      })
      .catch((err) => browserFailure(errorMessage(err)))
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
  const browserConfig = loadUserConfig().browser ?? {}
  const profileLease = browserConfig.command ? undefined : await acquireBrowserProfileLease(browserConfig)
  let releasePromise: Promise<void> | undefined
  const releaseProfile = () => (releasePromise ??= profileLease?.release() ?? Promise.resolve())

  try {
    const config = buildBrowserServerConfig(browserConfig)
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
      const reason = sanitizeBrowserDiagnostic(
        status.kind === 'failed' ? status.error : 'the browser MCP server exposed no tools',
        600,
      )
      const tail = result.server.stderrTail
        ? ` — ${sanitizeBrowserDiagnostic(result.server.stderrTail, 300, 'no browser diagnostics reported')}`
        : ''
      debugLog('browser.connect-failed', `${reason}${tail}`)
      await result.server.client.close().catch(() => undefined)
      await releaseProfile()
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

    let connectionLive = true
    const value: BrowserMcp = {
      ok: true,
      registry,
      permissions,
      toolCount: tools.length,
      vision: tools.some((tool) => tool.rawName.startsWith('browser_mouse_')),
      isLive: () => connectionLive,
      prepareVisualCheck: async (ownerId, signal) => {
        if (!result.tools.some((tool) => tool.name === PRIVATE_BROWSER_CODE_TOOL)) return false
        const originalKey = `x-code-visual-original:${ownerId}`
        const preparedMarker = `${TAB_PREPARED_MARKER}${ownerId}`
        const code =
          `async (page) => { const context = page.context(); ` +
          `const originalKey = Symbol.for(${JSON.stringify(originalKey)}); ` +
          `context[originalKey] = page; ` +
          `return ${JSON.stringify(preparedMarker)} }`
        try {
          const prepared = await result.server.client.callTool(PRIVATE_BROWSER_CODE_TOOL, { code }, signal)
          return !prepared.isError && resultContainsExactString(prepared.text, preparedMarker)
        } catch {
          return false
        }
      },
      markVisualCheckTab: async (ownerId, url, signal) => {
        if (!result.tools.some((tool) => tool.name === PRIVATE_BROWSER_CODE_TOOL)) return false
        const originalKey = `x-code-visual-original:${ownerId}`
        const temporaryKey = `x-code-visual-temporary:${ownerId}`
        const ownedMarker = `${TAB_OWNED_MARKER}${ownerId}`
        const code =
          `async (page) => { const context = page.context(); ` +
          `const original = context[Symbol.for(${JSON.stringify(originalKey)})]; ` +
          `if (!original || page === original) return ''; ` +
          `context[Symbol.for(${JSON.stringify(temporaryKey)})] = page; ` +
          `page[Symbol.for(${JSON.stringify(temporaryKey)})] = true; ` +
          `const loopback = /^https?:\\/\\/(?:(?:[^/?#:@]+\\.)*localhost\\.?|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\])(?::\\d+)?(?:[/?#]|$)/i; ` +
          `try { await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded' }); } catch {} ` +
          `return loopback.test(page.url()) ? ${JSON.stringify(ownedMarker)} : '' }`
        try {
          const marked = await result.server.client.callTool(PRIVATE_BROWSER_CODE_TOOL, { code }, signal)
          return !marked.isError && resultContainsExactString(marked.text, ownedMarker)
        } catch {
          return false
        }
      },
      finishVisualCheck: async (ownerId, signal) => {
        if (!result.tools.some((tool) => tool.name === PRIVATE_BROWSER_CODE_TOOL)) return { closed: false }
        const originalKey = `x-code-visual-original:${ownerId}`
        const temporaryKey = `x-code-visual-temporary:${ownerId}`
        const cleanupMarker = `${TAB_CLEANUP_MARKER}${ownerId}:`
        const code =
          `async (page) => { const context = page.context(); ` +
          `const originalKey = Symbol.for(${JSON.stringify(originalKey)}); ` +
          `const temporaryKey = Symbol.for(${JSON.stringify(temporaryKey)}); ` +
          `const original = context[originalKey]; ` +
          `const temporary = context[temporaryKey] ?? context.pages().find(candidate => candidate[temporaryKey] === true); ` +
          `delete context[originalKey]; ` +
          `delete context[temporaryKey]; ` +
          `if (temporary && !temporary.isClosed()) await temporary.close(); ` +
          `const pages = context.pages(); ` +
          `const originalIndex = original && !original.isClosed() ? pages.indexOf(original) : -1; ` +
          `return ${JSON.stringify(cleanupMarker)} + JSON.stringify({ closed: Boolean(temporary?.isClosed()), originalIndex }) }`
        try {
          const cleaned = await result.server.client.callTool(PRIVATE_BROWSER_CODE_TOOL, { code }, signal)
          if (cleaned.isError) return { closed: false }
          for (const rawLine of cleaned.text.split(/\r?\n/)) {
            const line = rawLine.trim()
            if (!line.startsWith('"') || !line.endsWith('"') || !line.includes(cleanupMarker)) continue
            try {
              const value = JSON.parse(line) as unknown
              if (typeof value !== 'string' || !value.startsWith(cleanupMarker)) continue
              const payload = JSON.parse(value.slice(cleanupMarker.length)) as {
                closed?: unknown
                originalIndex?: unknown
              }
              return {
                closed: payload.closed === true,
                ...(Number.isInteger(payload.originalIndex) && Number(payload.originalIndex) >= 0
                  ? { originalTabIndex: Number(payload.originalIndex) }
                  : {}),
              }
            } catch {
              // Keep scanning for the exact structured result line.
            }
          }
          return { closed: false }
        } catch {
          return { closed: false }
        }
      },
    }
    profileReleases.set(value, releaseProfile)
    // Self-heal: when the server/browser connection drops (Chrome closed, crash),
    // drop the cache and profile lease so the next acquire can reconnect.
    const observingLiveConnection = result.server.client.onClose(async () => {
      connectionLive = false
      if (cached === value) cached = null
      await releaseBrowserProfile(value)
    })
    if (!observingLiveConnection) {
      await result.server.client.close().catch(() => undefined)
      await releaseBrowserProfile(value)
      return browserFailure('Browser connection closed during startup; retry to reconnect')
    }
    return value
  } catch (err) {
    await releaseProfile().catch(() => undefined)
    throw err
  }
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
    current ? closeBrowser(current) : Promise.resolve(),
    attempt?.promise.then(
      () => undefined,
      () => undefined,
    ) ?? Promise.resolve(),
  ])
}
