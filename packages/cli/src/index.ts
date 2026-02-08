// @x-code/cli — CLI entry point

import React from 'react'

import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { render } from 'ink'

import {
  VERSION,
  loadConfig,
  resolveModelId,
  getAvailableProviders,
  createModelRegistry,
  initProject,
} from '@x-code/core'
import type { AgentOptions, AppConfig } from '@x-code/core'

import { startApp, getCleanupFn } from './app.js'
import { SetupWizard } from './ui/components/SetupWizard.js'

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

  // Load config
  const config = await loadConfig()
  const availableProviders = getAvailableProviders(config)

  // If no providers configured, show setup wizard
  if (availableProviders.length === 0) {
    await runSetupWizard(config, argv as Record<string, unknown>, prompt, stdinContent)
    return
  }

  // Resolve model
  const modelId = resolveModelId(argv.model as string | undefined, config)
  if (!modelId) {
    console.error('Error: Could not determine model. Use --model flag or configure an API key.')
    process.exit(1)
  }

  // Create registry and get model
  const registry = createModelRegistry(config)
  const model = registry.languageModel(modelId)

  const options: AgentOptions = {
    modelId,
    trustMode: argv.trust as boolean,
    printMode: argv.print as boolean,
    maxTurns: argv['max-turns'] as number ?? 100,
  }

  // Combine prompt with stdin
  const fullPrompt = [stdinContent, prompt].filter(Boolean).join('\n\n')

  // Start the app
  const waitUntilExit = startApp(model, options, fullPrompt || undefined)
  await waitUntilExit()
}

async function runSetupWizard(
  _config: AppConfig,
  argv: Record<string, unknown>,
  prompt: string | undefined,
  stdinContent: string,
) {
  return new Promise<void>((resolve) => {
    const { waitUntilExit } = render(
      React.createElement(SetupWizard, {
        onComplete: async (newConfig: AppConfig, modelId: string) => {
          const registry = createModelRegistry(newConfig)
          const model = registry.languageModel(modelId)

          const options: AgentOptions = {
            modelId,
            trustMode: (argv.trust as boolean) ?? false,
            printMode: (argv.print as boolean) ?? false,
            maxTurns: (argv['max-turns'] as number) ?? 100,
          }

          const fullPrompt = [stdinContent, prompt].filter(Boolean).join('\n\n')
          const waitForApp = startApp(model, options, fullPrompt || undefined)
          await waitForApp()
          resolve()
        },
      }),
    )

    waitUntilExit().then(resolve)
  })
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => {
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
process.on('SIGINT', async () => {
  sigintCount++
  if (sigintCount >= 2) {
    // Force exit on second Ctrl+C
    process.exit(1)
  }
  try {
    const cleanup = getCleanupFn()
    if (cleanup) {
      await cleanup()
    }
  } catch {
    // Don't crash on cleanup failure
  }
  process.exit(0)
})

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
