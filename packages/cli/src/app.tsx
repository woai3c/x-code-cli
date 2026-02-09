// @x-code/cli — Ink render entry
import React from 'react'

import { render } from 'ink'

import type { AgentOptions, LanguageModel, TokenUsage } from '@x-code/core'

import { App } from './ui/components/App.js'

/** Global cleanup ref — set by App component via onCleanupReady prop */
let registeredCleanup: (() => Promise<void>) | null = null

/** Global usage ref — updated by App component, read on exit */
let latestUsage: TokenUsage | null = null

/** Global model ID ref — updated by App component, read on exit */
let latestModelId: string | null = null

export function getCleanupFn(): (() => Promise<void>) | null {
  return registeredCleanup
}

/** Print session usage summary to console (called after Ink unmounts) */
export function printExitSummary(): void {
  if (!latestUsage || latestUsage.totalTokens === 0) return
  const usage = latestUsage
  const symbol = usage.costCurrency === 'CNY' ? '¥' : '$'
  const costStr = usage.estimatedCost > 0 ? `${symbol}${usage.estimatedCost.toFixed(4)}` : ''
  const costPart = costStr ? ` | cost: ${costStr}` : ''
  const modelPart = latestModelId ? `${latestModelId} | ` : ''
  console.log(
    `\n${modelPart}${usage.totalTokens.toLocaleString()} tokens (in: ${usage.inputTokens.toLocaleString()}, out: ${usage.outputTokens.toLocaleString()})${costPart}`,
  )
}

export function startApp(model: LanguageModel, options: AgentOptions, initialPrompt?: string) {
  const { waitUntilExit } = render(
    <App
      model={model}
      options={options}
      initialPrompt={initialPrompt}
      onCleanupReady={(fn) => {
        registeredCleanup = fn
      }}
      onUsageUpdate={(usage, modelId) => {
        latestUsage = usage
        latestModelId = modelId
      }}
    />,
  )
  return waitUntilExit
}
