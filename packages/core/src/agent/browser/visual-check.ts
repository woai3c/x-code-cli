// @x-code-cli/core — Lightweight local visual-check orchestration
import type { McpCallResult, McpToolEntry } from '../../mcp/types.js'
import type { ToolImage } from '../messages.js'
import { type BrowserMcp, getBrowserMcp } from './registry.js'

const DEFAULT_WAIT_MS = 500
const MAX_DIAGNOSTIC_CHARS = 3_000
const CURRENT_URL_MARKER = '__X_CODE_VISUAL_URL__:'
const CLEANUP_TIMEOUT_MS = 2_000

export interface BrowserVisualCheckInput {
  url?: unknown
  waitMs?: unknown
  viewport?: unknown
}

export interface BrowserVisualCheckOptions {
  abortSignal?: AbortSignal
}

export interface BrowserVisualCheckResult {
  text: string
  images: ToolImage[]
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '127.0.0.1' ||
    normalized === '0.0.0.0' ||
    normalized === '::1'
  )
}

/** Normalize a local dev-server URL and reject the external-web use case.
 *  Multi-step/external browsing belongs to the browser sub-agent, whose
 *  navigation and permission boundaries are explicit. */
export function normalizeLocalBrowserUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A local app URL is required')
  const raw = value.trim()
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error(`Invalid local app URL: ${raw}`)
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      'browserVisualCheck only accepts localhost or loopback HTTP(S) URLs. Use the browser sub-agent for external sites.',
    )
  }
  if (parsed.username || parsed.password) throw new Error('Credentials are not allowed in a browserVisualCheck URL')
  return parsed.href
}

function normalizeWaitMs(value: unknown): number {
  if (value === undefined) return DEFAULT_WAIT_MS
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 5_000) {
    throw new Error('waitMs must be an integer between 0 and 5000')
  }
  return value
}

function normalizeViewport(value: unknown): { width: number; height: number } | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('viewport must be an object')
  const { width, height } = value as Record<string, unknown>
  if (
    typeof width !== 'number' ||
    !Number.isInteger(width) ||
    width < 320 ||
    width > 1_920 ||
    typeof height !== 'number' ||
    !Number.isInteger(height) ||
    height < 320 ||
    height > 1_200
  ) {
    throw new Error('viewport must use integer width 320-1920 and height 320-1200')
  }
  return { width, height }
}

function compactDiagnostic(text: string, maxChars = MAX_DIAGNOSTIC_CHARS): string {
  const trimmed = text.trim()
  if (!trimmed) return '(none reported)'
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}\n[console output truncated]`
}

function findRawTool(entries: readonly McpToolEntry[], rawName: string): McpToolEntry | undefined {
  return entries.find((entry) => entry.rawName === rawName)
}

function failedCallMessage(rawName: string, result: McpCallResult): string {
  return `${rawName} failed: ${compactDiagnostic(result.text, 1_000)}`
}

function displayLocalUrl(value: string): string {
  const parsed = new URL(value)
  parsed.search = ''
  parsed.hash = ''
  return parsed.href
}

function tabIndices(text: string): number[] {
  return [...text.matchAll(/^- (\d+):/gm)].map((match) => Number(match[1]))
}

function currentTabIndex(text: string): number | undefined {
  const match = /^- (\d+): \(current\)/m.exec(text)
  return match ? Number(match[1]) : undefined
}

function evaluatedCurrentUrl(text: string): string | undefined {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('"') || !line.endsWith('"') || !line.includes(CURRENT_URL_MARKER)) continue
    try {
      const value = JSON.parse(line) as unknown
      if (typeof value === 'string' && value.startsWith(CURRENT_URL_MARKER))
        return value.slice(CURRENT_URL_MARKER.length)
    } catch {
      // Keep scanning: MCP responses may contain unrelated quoted lines.
    }
  }
  return undefined
}

async function verifiedCurrentLocalUrl(
  browser: BrowserMcp,
  evaluate: McpToolEntry,
  abortSignal: AbortSignal | undefined,
): Promise<string> {
  const result = await browser.registry.callTool(
    evaluate.callableName,
    { function: `() => '${CURRENT_URL_MARKER}' + globalThis.location.href` },
    abortSignal,
  )
  if (result.isError) throw new Error('Could not verify the visual-check tab URL after navigation')
  const currentUrl = evaluatedCurrentUrl(result.text)
  if (!currentUrl) throw new Error('Browser MCP did not report the visual-check tab URL')
  try {
    return normalizeLocalBrowserUrl(currentUrl)
  } catch {
    throw new Error('Visual check stopped because the local page redirected outside localhost/loopback')
  }
}

async function restoreOriginalTab(
  browser: BrowserMcp,
  tabs: McpToolEntry,
  temporaryTabIndex: number | undefined,
  originalTabIndex: number | undefined,
  originalTabCount: number,
): Promise<void> {
  if (temporaryTabIndex === undefined) return
  const createdTabIndices = new Set<number>()
  createdTabIndices.add(temporaryTabIndex)
  try {
    const listed = await browser.registry.callTool(
      tabs.callableName,
      { action: 'list' },
      AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
    )
    if (!listed.isError) {
      for (const index of tabIndices(listed.text)) {
        if (index >= originalTabCount) createdTabIndices.add(index)
      }
    }
  } catch {
    // Fall back to the known temporary tab below.
  }

  // Close in descending order so removing one tab cannot shift a later index.
  for (const index of [...createdTabIndices].sort((a, b) => b - a)) {
    await browser.registry
      .callTool(tabs.callableName, { action: 'close', index }, AbortSignal.timeout(CLEANUP_TIMEOUT_MS))
      .catch(() => undefined)
  }
  if (originalTabIndex !== undefined) {
    await browser.registry
      .callTool(
        tabs.callableName,
        { action: 'select', index: originalTabIndex },
        AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
      )
      .catch(() => undefined)
  }
}

/** Run several Playwright operations behind one model-visible tool call.
 *  Intermediate accessibility snapshots are deliberately discarded. */
export async function runBrowserVisualCheck(
  input: BrowserVisualCheckInput,
  options: BrowserVisualCheckOptions,
): Promise<BrowserVisualCheckResult> {
  const url = normalizeLocalBrowserUrl(input.url)
  const waitMs = normalizeWaitMs(input.waitMs)
  const viewport = normalizeViewport(input.viewport)
  if (options.abortSignal?.aborted) throw options.abortSignal.reason ?? new Error('Visual check aborted')

  const browser = await getBrowserMcp(options.abortSignal)
  if (options.abortSignal?.aborted) throw options.abortSignal.reason ?? new Error('Visual check aborted')
  if (!browser.ok) throw new Error(`Browser unavailable: ${browser.error ?? 'failed to start Playwright MCP'}`)

  const entries = browser.registry.list()
  const tabs = findRawTool(entries, 'browser_tabs')
  const screenshot = findRawTool(entries, 'browser_take_screenshot')
  const evaluate = findRawTool(entries, 'browser_evaluate')
  if (!tabs || !screenshot || !evaluate) {
    throw new Error(
      'Browser MCP does not expose the tab, URL-verification, and screenshot tools required for visual checks',
    )
  }

  let originalTabIndex: number | undefined
  let temporaryTabIndex: number | undefined
  let originalTabCount = 0
  try {
    const listed = await browser.registry.callTool(tabs.callableName, { action: 'list' }, options.abortSignal)
    // The tab list may contain titles/URLs from earlier signed-in Browser Use.
    // Never echo it through a root-visible error.
    if (listed.isError) throw new Error('Browser could not inspect tabs for an isolated visual check')
    originalTabIndex = currentTabIndex(listed.text)
    const existingIndices = tabIndices(listed.text)
    if (originalTabIndex === undefined || existingIndices.length === 0) {
      throw new Error('Browser MCP could not identify the original active tab')
    }
    originalTabCount = existingIndices.length

    temporaryTabIndex = Math.max(...existingIndices) + 1
    const opened = await browser.registry.callTool(tabs.callableName, { action: 'new', url }, options.abortSignal)
    temporaryTabIndex = currentTabIndex(opened.text) ?? temporaryTabIndex
    // Navigation failures can include an accessibility snapshot. Keep that
    // untrusted page content out of the root model's error result.
    if (opened.isError) throw new Error('Browser could not open the local app in a temporary tab')

    if (viewport) {
      const resize = findRawTool(entries, 'browser_resize')
      if (!resize) throw new Error('Browser MCP does not expose browser_resize for the requested viewport override')
      const resized = await browser.registry.callTool(resize.callableName, viewport, options.abortSignal)
      if (resized.isError) throw new Error(failedCallMessage(resize.rawName, resized))
    }

    if (waitMs > 0) {
      const wait = findRawTool(entries, 'browser_wait_for')
      if (wait) {
        const waited = await browser.registry.callTool(wait.callableName, { time: waitMs / 1_000 }, options.abortSignal)
        if (waited.isError) throw new Error(failedCallMessage(wait.rawName, waited))
      }
    }

    await verifiedCurrentLocalUrl(browser, evaluate, options.abortSignal)

    const captured = await browser.registry.callTool(
      screenshot.callableName,
      { type: 'jpeg', scale: 'css' },
      options.abortSignal,
    )
    if (captured.isError) throw new Error(failedCallMessage(screenshot.rawName, captured))
    if (!captured.images?.length) throw new Error('Browser screenshot returned no inline image')

    const consoleTool = findRawTool(entries, 'browser_console_messages')
    let consoleSummary = '(console diagnostics unavailable)'
    if (consoleTool) {
      try {
        const consoleResult = await browser.registry.callTool(
          consoleTool.callableName,
          { level: 'error', all: false },
          options.abortSignal,
        )
        consoleSummary = consoleResult.isError
          ? `(console diagnostics failed: ${compactDiagnostic(consoleResult.text, 1_000)})`
          : compactDiagnostic(consoleResult.text)
      } catch (err) {
        if (options.abortSignal?.aborted) throw err
        consoleSummary = `(console diagnostics failed: ${compactDiagnostic(err instanceof Error ? err.message : String(err), 1_000)})`
      }
    }

    // Check again after capture/diagnostics so a delayed client-side redirect
    // cannot cause an external-page image to reach the model.
    const finalUrl = await verifiedCurrentLocalUrl(browser, evaluate, options.abortSignal)
    const viewportSummary = viewport ? `${viewport.width}x${viewport.height}` : 'configured viewport'
    return {
      text:
        `Visual check captured for ${displayLocalUrl(finalUrl)}\n` +
        `Screenshot: ${viewportSummary}, JPEG at CSS scale, isolated temporary tab\n` +
        `Console errors:\n${consoleSummary}`,
      images: captured.images,
    }
  } finally {
    await restoreOriginalTab(browser, tabs, temporaryTabIndex, originalTabIndex, originalTabCount)
  }
}
