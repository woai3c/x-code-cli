// @x-code-cli/cli — Startup-time stderr messages (no API key, no web search,
// resume hint, update check). Kept out of index.ts so the main flow reads as
// orchestration rather than fifty lines of chalk-formatted prose.
import { Chalk } from 'chalk'

import fs from 'node:fs'
import path from 'node:path'

import { PROVIDER_DETECTION_ORDER, PROVIDER_KEY_URLS, USER_XCODE_DIR } from '@x-code-cli/core'

import { getSessionExitInfo } from './app.js'
import { detectShell, formatPersistCommand } from './shell.js'
import type { ShellType } from './shell.js'
import { VERSION } from './version.js'

const chalk = new Chalk({ level: process.stderr.isTTY ? 3 : 0 })

export function printNoApiKeyMessage(): void {
  const code = (s: string) => chalk.cyan(s)
  const comment = (s: string) => chalk.gray(s)
  const envName = (s: string) => chalk.yellow(s)

  console.error(chalk.red.bold('Error: No API key found.') + '\n')
  console.error('Set at least one provider API key via environment variable:\n')
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
  console.error('  Pick either (both free, signup only):')
  console.error(`    ${bold('TAVILY_API_KEY')}  ${dim('1000/month — https://tavily.com')}`)
  console.error(`    ${bold('BRAVE_API_KEY')}   ${dim('2000/month — https://api.search.brave.com')}`)

  const cmd = formatPersistCommand('TAVILY_API_KEY', 'tvly-...', shell)
  console.error(`  ${dim(`(${shell})`)}  ${code(cmd)}\n`)
}

/** Print a copy-pasteable resume hint after Ink has unmounted and the
 *  terminal has been reset. Mirrors Claude Code's exit behavior so a
 *  user closing the chat sees exactly how to come back to the same
 *  thread. We prefer the slug-prefixed id when available because it's
 *  human-skimmable in `ls` output; we fall back to the bare sessionId
 *  for slug-less sessions (CJK-only first messages).
 *
 *  Suppressed when the session has no messages yet (user launched but
 *  never submitted) — we'd be pointing at an empty jsonl. */
export function printResumeHint(): void {
  const info = getSessionExitInfo()
  if (!info) return
  const key = info.taskSlug ? `${info.taskSlug}-${info.sessionId}` : info.sessionId
  const cmd = chalk.cyan(`xc --resume ${key}`)
  const dim = chalk.gray
  process.stdout.write(`${dim('Resume this session:')} ${cmd}\n`)
}

// ── Startup update check ────────────────────────────────────────────────

const UPDATE_CHECK_CACHE = path.join(USER_XCODE_DIR, 'cache', 'update-check.json')
const ONE_DAY_MS = 24 * 60 * 60 * 1000
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@x-code-cli/cli/latest'

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
  if (current === '0.0.0-dev') return

  // Check disk cache first
  try {
    const raw = fs.readFileSync(UPDATE_CHECK_CACHE, 'utf-8')
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
    fs.mkdirSync(path.dirname(UPDATE_CHECK_CACHE), { recursive: true })
    fs.writeFileSync(UPDATE_CHECK_CACHE, JSON.stringify({ checkedAt: Date.now(), latest }), 'utf-8')

    if (compareVersions(latest, current) > 0) {
      printUpdateHint(current, latest)
    }
  } finally {
    clearTimeout(timeout)
  }
}

function printUpdateHint(current: string, latest: string): void {
  console.error(
    chalk.yellow('Update available:') +
      ` ${chalk.gray(current)} → ${chalk.green(latest)}` +
      chalk.gray('  Run ') +
      chalk.cyan('pnpm add -g @x-code-cli/cli') +
      chalk.gray(' to update.'),
  )
}
