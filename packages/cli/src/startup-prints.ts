// @x-code-cli/cli — Startup-time stderr messages (no API key, no web search,
// resume hint, update check). Kept out of index.ts so the main flow reads as
// orchestration rather than fifty lines of chalk-formatted prose.
import { Chalk } from 'chalk'

import fs from 'node:fs'
import path from 'node:path'

import { PROVIDER_DETECTION_ORDER, PROVIDER_KEY_URLS, userXcodeDir } from '@x-code-cli/core'

import { detectShell, formatPersistCommand } from './shell.js'
import type { ShellType } from './shell.js'
import { getSessionExitInfo } from './ui/app/session-exit.js'
import { VERSION } from './version.js'

const chalk = new Chalk({ level: process.stderr.isTTY && !process.env.NO_COLOR ? 3 : 0 })

export function printNoApiKeyMessage(): void {
  const code = (s: string) => chalk.cyan(s)
  const comment = (s: string) => chalk.gray(s)
  const envName = (s: string) => chalk.yellow(s)

  console.error(chalk.red.bold('Error: No model provider configured.') + '\n')
  console.error(`Use your ChatGPT subscription:\n\n  ${code('xc login')}\n`)
  console.error('Or set at least one provider API key via environment variable:\n')
  for (const { envKey } of PROVIDER_DETECTION_ORDER) {
    const provider = envKey
      .replace(/_API_KEY$/, '')
      .replace('GOOGLE_GENERATIVE_AI', 'google')
      .replace('MOONSHOT', 'moonshotai')
      .toLowerCase()
    const url = PROVIDER_KEY_URLS[provider] ?? ''
    console.error(`  ${envName(envKey.padEnd(32))} ${chalk.dim(url)}`)
  }
  console.error(
    `\n  ${envName('OPENAI_COMPATIBLE_API_KEY'.padEnd(32))} ${chalk.dim('(custom OpenAI-compatible endpoint)')}`,
  )

  const shell = detectShell()
  const restartHint: Record<ShellType, string> = {
    powershell: '# restart PowerShell, then run:',
    cmd: ':: restart CMD, then run:',
    zsh: '',
    bash: '',
    fish: '',
    sh: '',
  }
  console.error(`\nDetected shell: ${chalk.bold(shell)}`)
  console.error('Persist it so you do not need to set it every session:\n')
  console.error(`  ${code(formatPersistCommand('ANTHROPIC_API_KEY', 'sk-ant-...', shell))}`)
  const hint = restartHint[shell]
  if (hint) console.error(`  ${comment(hint)}  ${code('xc')}`)
  console.error(`\nAlternatively, put keys in a project-local ${chalk.bold('.env')} file (loaded from cwd upward).`)
}

export function printNoWebSearchKeyHint(): void {
  const shell = detectShell()
  const yellow = chalk.yellow
  const bold = chalk.bold
  const dim = chalk.gray
  const code = chalk.cyan

  console.error(yellow('Note:') + ' WebSearch is disabled — no search API key configured.')
  console.error(dim('  (WebFetch still works key-less; the hint is only for web search.)'))
  console.error('  Pick any (Tavily recommended — free, signup only):')
  console.error(`    ${bold('TAVILY_API_KEY')}      ${dim('1000/month free — https://tavily.com')}`)
  console.error(`    ${bold('BRAVE_API_KEY')}       ${dim('paid — https://api.search.brave.com')}`)
  console.error(`    ${bold('EXA_API_KEY')}         ${dim('1000/month free — https://exa.ai')}`)
  console.error(`    ${bold('PERPLEXITY_API_KEY')}  ${dim('paid — https://www.perplexity.ai/settings/api')}`)
  console.error(`    ${bold('FIRECRAWL_API_KEY')}   ${dim('free credits — https://firecrawl.dev')}`)
  console.error(dim("  DeepSeek models need no extra key — DeepSeek's built-in search is used automatically."))

  const cmd = formatPersistCommand('TAVILY_API_KEY', 'tvly-...', shell)
  console.error(`  ${dim(`(${shell})`)}  ${code(cmd)}\n`)
}

/** Print a copy-pasteable resume hint after Ink has unmounted and the
 *  terminal has been reset. Mirrors Claude Code's exit behavior so a
 *  user closing the chat sees exactly how to come back to the same
 *  thread. Session ids are timestamp-shaped and match new jsonl filenames.
 *
 *  Suppressed when the session has no messages yet (user launched but
 *  never submitted) — we'd be pointing at an empty jsonl. */
export function printResumeHint(): void {
  const info = getSessionExitInfo()
  if (!info) return
  const cmd = chalk.cyan(`xc --resume ${info.sessionId}`)
  const dim = chalk.gray
  process.stdout.write(`${dim('Resume this session:')} ${cmd}\n`)
}

// ── Startup update check ────────────────────────────────────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@x-code-cli/cli/latest'

function updateCheckCachePath(): string {
  return path.join(userXcodeDir(), 'cache', 'update-check.json')
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Fire-and-forget update check. Queries npm registry (with 24h disk
 *  cache) and prints a one-line hint to stderr if a newer version exists.
 *  Never throws — all failures are silently swallowed. */
export async function checkForUpdate(): Promise<void> {
  if (!process.stderr.isTTY) return
  const current = VERSION
  if (!current || current === '0.0.0-dev') return
  const cachePath = updateCheckCachePath()

  // Check disk cache first
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8')
    const cache = JSON.parse(raw) as { checkedAt: number; latest: string }
    if (Date.now() - cache.checkedAt < ONE_DAY_MS) {
      if (compareVersions(cache.latest, current) > 0) {
        printUpdateHint(current, cache.latest)
      }
      return
    }
  } catch {
    // Cache missing or corrupt — fall through to network check.
  }

  // Fetch latest version from npm
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return
    const data = (await res.json()) as { version?: string }
    const latest = data.version
    if (!latest) return

    // Write cache
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    fs.writeFileSync(cachePath, JSON.stringify({ checkedAt: Date.now(), latest }), 'utf-8')

    if (compareVersions(latest!, current) > 0) {
      printUpdateHint(current, latest!)
    }
  } finally {
    clearTimeout(timeout)
  }
}

let pendingUpdateHint: string | null = null

/** Callback registered by the TUI to receive update hints after mount.
 *  checkForUpdate fires before Ink mounts most of the time, but the
 *  async network-fetch path may complete after mount — this lets the
 *  hint reach the UI without fighting ChatInput's cell-grid rendering. */
let onUpdateHint: ((msg: string) => void) | null = null

/** Register a handler for update hints. Called by App on mount so both
 *  the pre-mount cache-hit path and the post-mount network-fetch path
 *  render through ChatInput's message system instead of stderr. */
export function registerUpdateHintHandler(handler: ((msg: string) => void) | null): void {
  onUpdateHint = handler
}

/** Retrieve and clear any hint that arrived before the handler was
 *  registered. Used by App on mount to catch the cache-hit case. */
export function drainPendingUpdateHint(): string | null {
  const hint = pendingUpdateHint
  pendingUpdateHint = null
  return hint
}

function printUpdateHint(current: string, latest: string): void {
  const msg =
    chalk.yellow('Update available:') +
    ` ${chalk.gray(current)}` +
    ` ${chalk.gray('\u2192')}` +
    ` ${chalk.green(latest)}` +
    chalk.gray('  Run ') +
    chalk.cyan('npm install -g @x-code-cli/cli') +
    chalk.gray(' to update.')
  if (onUpdateHint) {
    onUpdateHint(msg)
    return
  }
  // Fallback: store so the TUI can pick it up once it mounts.
  pendingUpdateHint = msg
}
