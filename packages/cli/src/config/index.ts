// @x-code-cli/cli — CLI-level config helpers
import { getAvailableProviders, resolveModelId } from '@x-code-cli/core'

export interface CliOptions {
  model?: string
  trust: boolean
  print: boolean
  maxTurns: number
  prompt?: string
}

/** Resolve all configuration from CLI args + env */
export function resolveCliConfig(args: CliOptions) {
  const modelId = resolveModelId(args.model)
  const availableProviders = getAvailableProviders()

  return {
    modelId,
    availableProviders,
    needsSetup: availableProviders.length === 0,
    trustMode: args.trust,
    printMode: args.print,
    maxTurns: args.maxTurns,
  }
}
