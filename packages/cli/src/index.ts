// @x-code-cli/cli — CLI entry point
import { Chalk } from 'chalk'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import fs from 'node:fs'
import path from 'node:path'

import {
  PROVIDER_DETECTION_ORDER,
  PROVIDER_KEY_URLS,
  createModelRegistry,
  getAvailableProviders,
  getEnvVarName,
  resolveModelId,
} from '@x-code-cli/core'
import type { AgentOptions } from '@x-code-cli/core'

import { getCleanupFn, startApp } from './app.js'
import { VERSION } from './version.js'

const chalk = new Chalk({ level: process.stderr.isTTY ? 3 : 0 })

const MIN_NODE_VERSION = [20, 19, 0]

function checkNodeVersion(): void {
  const [major, minor, patch] = process.versions.node.split('.').map((v) => parseInt(v, 10))
  const [reqMajor, reqMinor, reqPatch] = MIN_NODE_VERSION
  if (
    major < reqMajor ||
    (major === reqMajor && minor < reqMinor) ||
    (major === reqMajor && minor === reqMinor && patch < reqPatch)
  ) {
    console.error(
      `Error: X-Code CLI requires Node.js >= ${MIN_NODE_VERSION.join('.')}, but you are running ${process.versions.node}.\n` +
        'Please upgrade Node.js: https://nodejs.org/',
    )
    process.exit(1)
  }
}

// ── Graceful shutdown ────────────────────────────────────────────────────
//
// Single Ctrl+C path:
//   waitUntilExit() → gracefulShutdown() → resetTerminal → process.exit(0)
//
// Session save runs as fire-and-forget (not awaited) so it doesn't block
// exit. Token-usage summary is NOT printed on exit — none of the other
// four CLIs we compared (claude-code, codex, gemini-cli, opencode) do,
// and the delayed stdout flush made it appear after the shell prompt,
// confusing users.
let shutdownInProgress = false

// Belt-and-suspenders terminal restore. Runs synchronously before exit so even
// if Ink's unmount is partially broken (e.g. a useEffect cleanup threw, or the
// raw-mode ref-count leaked over a long session), the terminal is still left
// in a usable state. Safe to call multiple times — each escape is idempotent.
function resetTerminal(): void {
  if (!process.stdout.isTTY) return
  try {
    fs.writeSync(1, '\x1b[0m') // reset SGR (colors, bold, inverse, ...) so the shell prompt isn't styled
    fs.writeSync(1, '\x1b[?2004l') // disable bracketed paste
    fs.writeSync(1, '\x1b[?25h') // show cursor
    fs.writeSync(1, '\x1b[?1049l') // exit alt screen (if ever entered)
    fs.writeSync(1, '\r\n') // land the shell prompt on a fresh line
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
  } catch {
    // Terminal may already be closed (SIGHUP, SSH disconnect) — ignore.
  }
}

async function gracefulShutdown(exitCode: number): Promise<never> {
  if (shutdownInProgress) return undefined as never
  shutdownInProgress = true

  // Kick off cleanup as best-effort in the background, but don't block the
  // exit on it. saveSession internally calls the model to generate a summary
  // which can take seconds — that was the "press Ctrl+C and wait 2-5 seconds"
  // UX problem. None of the competitors (claude-code, gemini-cli, opencode,
  // codex) make users wait for anything on exit; we align with them.
  //
  // Consequence: if the process exits before saveSession's file write lands,
  // that session isn't saved. Acceptable trade-off given users care far more
  // about exit speed than about session summaries. A future improvement is
  // incremental saves during the session (opencode's approach).
  const cleanup = getCleanupFn()
  if (cleanup) cleanup().catch(() => undefined)

  resetTerminal()
  process.exit(exitCode)
}

async function main() {
  checkNodeVersion()
  loadEnvFile()

  // Parse CLI arguments
  const argv = await yargs(hideBin(process.argv))
    .scriptName('x-code')
    .usage('$0 [options] [prompt]')
    .option('model', {
      alias: 'm',
      type: 'string',
      describe: 'Model to use (e.g. sonnet, deepseek, openai:gpt-4.1)',
    })
    .option('trust', {
      alias: 't',
      type: 'boolean',
      default: false,
      describe: 'Trust mode: skip write operation confirmations',
    })
    .option('print', {
      alias: 'p',
      type: 'boolean',
      default: false,
      describe: 'Non-interactive mode: output result and exit',
    })
    .option('max-turns', {
      type: 'number',
      default: 100,
      describe: 'Maximum agent loop turns',
    })
    .version(VERSION)
    .alias('v', 'version')
    .help()
    .alias('h', 'help')
    .parse()

  const prompt = (argv._ as string[]).join(' ') || undefined

  // Check for stdin pipe input
  let stdinContent = ''
  if (!process.stdin.isTTY) {
    stdinContent = await readStdin()
  }

  const availableProviders = getAvailableProviders()

  // If no providers configured, show helpful message and exit
  if (availableProviders.length === 0) {
    printNoApiKeyMessage()
    // Exit 0: this is a user-configuration hint, not a crash.
    // Non-zero would make `pnpm dev` pile on ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL / ELIFECYCLE noise.
    process.exit(0)
  }

  // Resolve model
  const modelId = resolveModelId(argv.model)
  if (!modelId) {
    // User specified a model whose provider has no key
    const requested = argv.model
    if (requested) {
      const provider = requested.split(':')[0]
      const envVar = getEnvVarName(provider) ?? `${provider.toUpperCase()}_API_KEY`
      console.error(`Error: ${envVar} is not set. Please set this environment variable to use ${requested}.`)
      process.exit(1)
    } else {
      printNoApiKeyMessage()
      process.exit(0)
    }
  }

  // Create registry and get model
  const registry = createModelRegistry()
  const model = registry.languageModel(modelId as `${string}:${string}`)

  const options: AgentOptions = {
    modelId,
    trustMode: argv.trust,
    printMode: argv.print,
    maxTurns: argv['max-turns'] ?? 100,
  }

  // Combine prompt with stdin
  const fullPrompt = [stdinContent, prompt].filter(Boolean).join('\n\n')

  // Print mode: bypass Ink entirely. Mounting the TUI refs raw stdin, which
  // keeps the Node event loop alive past the queued unmount — that's why -p
  // used to hang until a keypress. See packages/cli/src/print.ts.
  if (argv.print) {
    if (!fullPrompt) {
      console.error('Error: -p / --print requires a prompt (as an argument or via stdin).')
      process.exit(1)
    }
    const { runPrintMode } = await import('./print.js')
    const code = await runPrintMode(model, options, fullPrompt)
    resetTerminal()
    process.exit(code)
  }

  // Heads-up: WebSearch needs a key. Print once, before Ink takes over, so
  // the hint lands in scrollback above the TUI. Not fatal — WebFetch still
  // works key-less, and the tool itself returns a detailed error if invoked
  // without a key configured.
  if (!process.env.TAVILY_API_KEY && !process.env.BRAVE_API_KEY) {
    printNoWebSearchKeyHint()
  }

  // Start the app — waitUntilExit resolves when Ink unmounts (including on Ctrl+C)
  const waitUntilExit = startApp(model, options, fullPrompt || undefined)
  await waitUntilExit()

  // Normal exit path (including Ctrl+C which unmounts Ink first)
  await gracefulShutdown(0)
}

/** Load .env file from cwd (walk up to find it, like dotenv convention) */
function loadEnvFile(): void {
  let dir = process.cwd()
  while (true) {
    const envPath = path.join(dir, '.env')
    if (fs.existsSync(envPath)) {
      try {
        process.loadEnvFile(envPath)
      } catch {
        // Ignore parse errors
      }
      return
    }
    const parent = path.dirname(dir)
    if (parent === dir) break // reached root
    dir = parent
  }
}

function printNoApiKeyMessage() {
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
  console.error(`\nDetected shell: ${chalk.bold(shell)}`)
  console.error('Persist it so you do not need to set it every session:\n')
  switch (shell) {
    case 'powershell':
      console.error(`  ${code(`[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY','sk-ant-...','User')`)}`)
      console.error(`  ${comment('# restart PowerShell, then run:')}  ${code('xc')}`)
      break
    case 'cmd':
      console.error(`  ${code('setx ANTHROPIC_API_KEY "sk-ant-..."')}`)
      console.error(`  ${comment(':: restart CMD, then run:')}  ${code('xc')}`)
      break
    case 'zsh':
      console.error(`  ${code(`echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.zshrc && source ~/.zshrc`)}`)
      break
    case 'fish':
      console.error(`  ${code('set -Ux ANTHROPIC_API_KEY sk-ant-...')}`)
      break
    case 'bash':
    default:
      console.error(`  ${code(`echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.bashrc && source ~/.bashrc`)}`)
      break
  }
  console.error(`\nAlternatively, put keys in a project-local ${chalk.bold('.env')} file (loaded from cwd upward).`)
}

function printNoWebSearchKeyHint(): void {
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

  let cmd: string
  switch (shell) {
    case 'powershell':
      cmd = `[Environment]::SetEnvironmentVariable('TAVILY_API_KEY','tvly-...','User')`
      break
    case 'cmd':
      cmd = `setx TAVILY_API_KEY "tvly-..."`
      break
    case 'zsh':
      cmd = `echo 'export TAVILY_API_KEY=tvly-...' >> ~/.zshrc && source ~/.zshrc`
      break
    case 'fish':
      cmd = `set -Ux TAVILY_API_KEY tvly-...`
      break
    case 'bash':
    default:
      cmd = `echo 'export TAVILY_API_KEY=tvly-...' >> ~/.bashrc && source ~/.bashrc`
      break
  }
  console.error(`  ${dim(`(${shell})`)}  ${code(cmd)}\n`)
}

function detectShell(): 'powershell' | 'cmd' | 'bash' | 'zsh' | 'fish' | 'sh' {
  if (process.platform === 'win32') {
    // PowerShell sets PSModulePath; CMD typically doesn't (and no PSHOME).
    if (process.env.PSModulePath) return 'powershell'
    return 'cmd'
  }
  const shellPath = process.env.SHELL ?? ''
  const base = shellPath.split('/').pop() ?? ''
  if (base === 'zsh' || base === 'bash' || base === 'fish' || base === 'sh') return base
  // macOS defaults to zsh since Catalina
  if (process.platform === 'darwin') return 'zsh'
  return 'bash'
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf-8')

    const onData = (chunk: string): void => {
      data += chunk
    }
    const onEnd = (): void => {
      cleanup()
      resolve(data)
    }
    const cleanup = (): void => {
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      clearTimeout(timer)
    }

    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    // Timeout for stdin — don't hang forever
    const timer = setTimeout(() => {
      cleanup()
      resolve(data)
    }, 1000)
  })
}

// ── Rejection safety net ────────────────────────────────────────────────
// Node 15+ terminates the process on unhandled rejection by default. The
// AI SDK creates several promises (response, usage, finishReason, toolCalls,
// the stream's internal flush) that can reject independently when a request
// fails — we try to drain them in loop.ts, but timing races or a new SDK
// path can still leak one. Without this handler, a provider-side error
// (insufficient balance, bad max_tokens, upstream 5xx) would kill the
// REPL mid-session. We swallow the rejection and let the loop's onError
// path render a friendly message instead.
process.on('unhandledRejection', (reason) => {
  if (process.env.XC_DEBUG) {
    console.error('[unhandledRejection]', reason)
  }
})
process.on('uncaughtException', (err) => {
  if (process.env.XC_DEBUG) {
    console.error('[uncaughtException]', err)
  }
})

// ── SIGINT handler ──────────────────────────────────────────────────────
// Only a safety net: sets exitCode=0 so if the process exits before
// gracefulShutdown() runs, the exit code is still 0. On double Ctrl+C,
// force-exits immediately.
let sigintCount = 0
process.on('SIGINT', () => {
  sigintCount++
  process.exitCode = 0
  if (sigintCount >= 2) {
    // Double Ctrl+C → user wants out NOW. Skip async cleanup (gracefulShutdown
    // was already running from the first press) but ALWAYS restore the terminal
    // so the shell prompt is usable. Without this reset, raw mode / hidden
    // cursor / bracketed paste mode can leak into the shell.
    resetTerminal()
    process.exit(0)
  }
})

main().catch((err) => {
  // If we're shutting down (Ctrl+C unmounted Ink, waitUntilExit rejected),
  // don't treat it as a fatal error — gracefulShutdown handles it.
  if (sigintCount > 0 || shutdownInProgress) {
    return
  }
  console.error('Fatal error:', err)
  process.exit(1)
})
