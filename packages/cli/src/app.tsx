// @x-code-cli/cli — Ink render entry
import React from 'react'

import { render } from 'ink'

import type { AgentOptions, LanguageModel, TokenUsage } from '@x-code-cli/core'

import { App } from './ui/components/App.js'
import { printHeader } from './ui/components/AppHeader.js'

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
  const modelPart = latestModelId ? `${latestModelId} | ` : ''
  console.log(
    `\n${modelPart}${usage.totalTokens.toLocaleString()} tokens (in: ${usage.inputTokens.toLocaleString()}, out: ${usage.outputTokens.toLocaleString()})`,
  )
}

// ── Synchronized Updates (DEC 2026) ─────────────────────────────────────
// Wrap all stdout writes in BSU/ESU so the terminal renders each frame
// atomically — no intermediate "cleared but not yet repainted" state is
// visible. This is the same technique Claude Code uses in its custom Ink
// fork (terminal.ts writeDiffToTerminal).
//
// Supported: Windows Terminal, iTerm2, kitty, WezTerm, VS Code terminal,
// foot, and most modern terminals. Unsupported terminals silently ignore
// the escape sequences.
const BSU = '\x1b[?2026h' // Begin Synchronized Update
const ESU = '\x1b[?2026l' // End Synchronized Update

function enableSynchronizedOutput(): () => void {
  const origWrite = process.stdout.write
  process.stdout.write = function (
    data: string | Uint8Array,
    ...args: unknown[]
  ): boolean {
    // Only wrap string writes that contain ANSI escapes (Ink render frames).
    // Raw text (user messages via write()) passes through unwrapped.
    if (typeof data === 'string' && data.includes('\x1b[')) {
      return origWrite.call(process.stdout, BSU + data + ESU, ...args as [])
    }
    return origWrite.call(process.stdout, data, ...args as [])
  } as typeof process.stdout.write
  return () => {
    process.stdout.write = origWrite
  }
}

export function startApp(model: LanguageModel, options: AgentOptions, initialPrompt?: string) {
  // Print header ONCE before Ink starts — avoids Static re-render duplication
  printHeader(options.modelId)

  // Enable synchronized output BEFORE Ink starts rendering
  const disableSyncOutput = enableSynchronizedOutput()

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
    { exitOnCtrlC: false },
  )
  return async () => {
    await waitUntilExit()
    disableSyncOutput()
  }
}
