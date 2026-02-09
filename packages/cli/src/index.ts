// @x-code/cli — CLI entry point
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import fs from 'node:fs'
import path from 'node:path'

import {
  PROVIDER_DETECTION_ORDER,
  PROVIDER_KEY_URLS,
  VERSION,
  createModelRegistry,
  getAvailableProviders,
  getEnvVarName,
  loadConfig,
  resolveModelId,
} from '@x-code/core'
import type { AgentOptions } from '@x-code/core'

import { getCleanupFn, printExitSummary, startApp } from './app.js'

const MIN_NODE_VERSION = [20, 19, 0]

function checkNodeVersion(): void {
  const [major, minor, patch] = process.versions.node.split('.').map(Number)
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

  // Load config (for model preference only; API keys come from env vars)
  const config = await loadConfig()
  const availableProviders = getAvailableProviders()

  // If no providers configured, show helpful message and exit
  if (availableProviders.length === 0) {
    printNoApiKeyMessage()
    process.exit(1)
  }

  // Resolve model
  const modelId = resolveModelId(argv.model, config)
  if (!modelId) {
    // User specified a model whose provider has no key
    const requested = argv.model
    if (requested) {
      const provider = requested.split(':')[0]
      const envVar = getEnvVarName(provider) ?? `${provider.toUpperCase()}_API_KEY`
      console.error(`Error: ${envVar} is not set. Please set this environment variable to use ${requested}.`)
    } else {
      printNoApiKeyMessage()
    }
    process.exit(1)
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

  // Start the app
  const waitUntilExit = startApp(model, options, fullPrompt || undefined)
  await waitUntilExit()

  // Print session usage summary after Ink unmounts
  printExitSummary()
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
  const isWindows = process.platform === 'win32'
  console.error('Error: No API key found.\n')
  console.error('Option 1: Create a .env file in your project root:\n')
  console.error('  cp .env.example .env')
  console.error('  # Edit .env and fill in your API key\n')
  console.error('Option 2: Set an environment variable:\n')
  for (const { envKey } of PROVIDER_DETECTION_ORDER) {
    const provider = envKey
      .replace(/_API_KEY$/, '')
      .replace('GOOGLE_GENERATIVE_AI', 'google')
      .replace('MOONSHOT', 'moonshotai')
      .toLowerCase()
    const url = PROVIDER_KEY_URLS[provider] ?? ''
    console.error(`  ${envKey.padEnd(32)} ${url}`)
  }
  console.error(`\n  OPENAI_COMPATIBLE_API_KEY        (custom OpenAI-compatible endpoint)`)
  if (isWindows) {
    console.error('\nExample (PowerShell):')
    console.error('  $env:ANTHROPIC_API_KEY="sk-ant-..."')
    console.error('  xc')
  } else {
    console.error('\nExample:')
    console.error('  export ANTHROPIC_API_KEY=sk-ant-...')
    console.error('  xc')
  }
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

// Handle Ctrl+C gracefully — save session before exit
let sigintCount = 0
process.on('SIGINT', () => {
  sigintCount++
  if (sigintCount >= 2) {
    // Force exit on second Ctrl+C
    process.exit(1)
  }
  const cleanup = getCleanupFn()
  if (cleanup) {
    cleanup()
      .catch(() => {
        // Don't crash on cleanup failure
      })
      .finally(() => {
        printExitSummary()
        process.exit(0)
      })
  } else {
    printExitSummary()
    process.exit(0)
  }
})

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
