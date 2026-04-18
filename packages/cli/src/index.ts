// @x-code-cli/cli — CLI entry point
import { Chalk } from 'chalk'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import fs from 'node:fs'
import path from 'node:path'

const chalk = new Chalk({ level: process.stderr.isTTY ? 3 : 0 })

import {
  PROVIDER_DETECTION_ORDER,
  PROVIDER_KEY_URLS,
  createModelRegistry,
  getAvailableProviders,
  getEnvVarName,
  resolveModelId,
} from '@x-code-cli/core'
import type { AgentOptions } from '@x-code-cli/core'

import { getCleanupFn, printExitSummary, startApp } from './app.js'
import { VERSION } from './version.js'

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

// ── Graceful shutdown (aligned with Claude Code's pattern) ──────────────
//
// Claude Code's approach: SIGINT sets process.exitCode=0 as a safety net,
// then Ink unmounts → waitUntilExit() resolves → gracefulShutdown() runs
// cleanup → process.exit(0). There's no race between competing exit paths.
//
// We follow the same pattern: the SIGINT handler only marks the exit code
// and (on double Ctrl+C) forces exit. The normal path is:
//   waitUntilExit() → cleanup → printExitSummary → process.exit(0)
let shutdownInProgress = false

async function gracefulShutdown(exitCode: number): Promise<never> {
  if (shutdownInProgress) return undefined as never
  shutdownInProgress = true

  // Safety net — guarantee exit even if cleanup hangs
  const failsafeTimer = setTimeout(() => process.exit(exitCode), 5000)
  failsafeTimer.unref()

  process.exitCode = exitCode

  try {
    const cleanup = getCleanupFn()
    if (cleanup) await cleanup()
  } catch {
    // Don't crash on cleanup failure
  }

  printExitSummary()
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
  console.error(`\n  ${envName('OPENAI_COMPATIBLE_API_KEY'.padEnd(32))} ${chalk.dim('(custom OpenAI-compatible endpoint)')}`)

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
    process.stdin.on('data', (chunk: string) => {
      data += chunk
    })
    process.stdin.on('end', () => {
      resolve(data)
    })
    // Timeout for stdin — don't hang forever
    setTimeout(() => resolve(data), 1000)
  })
}

// ── SIGINT handler ──────────────────────────────────────────────────────
// Only a safety net: sets exitCode=0 so if the process exits before
// gracefulShutdown() runs, the exit code is still 0. On double Ctrl+C,
// force-exits immediately.
let sigintCount = 0
process.on('SIGINT', () => {
  sigintCount++
  process.exitCode = 0
  if (sigintCount >= 2) {
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
