// @x-code/cli — CLI-level config helpers
import { getAvailableProviders, loadConfig, resolveModelId } from '@x-code/core'
import type { AppConfig } from '@x-code/core'

export interface CliOptions {
  model?: string
  trust: boolean
  print: boolean
  maxTurns: number
  prompt?: string
}

/** Resolve all configuration from CLI args + env + config file */
export async function resolveCliConfig(args: CliOptions) {
  const config = await loadConfig()
  const modelId = resolveModelId(args.model, config)
  const availableProviders = getAvailableProviders()

  return {
    config,
    modelId,
    availableProviders,
    needsSetup: availableProviders.length === 0,
    trustMode: args.trust,
    printMode: args.print,
    maxTurns: args.maxTurns,
  }
}

export type { AppConfig }
