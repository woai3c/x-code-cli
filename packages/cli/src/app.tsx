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

// ── Patch Ink's log-update to fix CJK line-count miscalculation ──────────
//
// Standard Ink's log-update uses `eraseLines(previousLineCount)` to clear
// the previous frame, where previousLineCount = output.split('\n').length.
// This counts LOGICAL newlines, not VISUAL lines. When CJK characters
// (2 terminal columns each) cause a line to wrap, the visual line count
// is higher than the logical count. eraseLines clears too few lines,
// leaving stale content → visible jitter.
//
// Claude Code fixes this in its custom Ink fork with a cell-level screen
// buffer. We take a simpler approach: replace eraseLines(N) with
// "move cursor up N-1 lines, then erase from cursor to end of screen"
// (CSI J). This clears EVERYTHING below the cursor regardless of how
// many visual lines the terminal actually used. The only requirement is
// that nothing important exists below the dynamic region — which is true
// because the dynamic region is always at the bottom of the terminal.
//
// Also wraps output in BSU/ESU (DEC 2026 Synchronized Updates) for
// atomic rendering on supported terminals.
const BSU = '\x1b[?2026h'
const ESU = '\x1b[?2026l'

function patchStdoutForCJK(): () => void {
  const origWrite = process.stdout.write

  // ansi-escapes eraseLines(N) generates:
  //   (\x1b[2K\x1b[A){N-1} \x1b[2K \x1b[G
  //   = (eraseLine + cursorUp) × (N-1) + eraseLine + cursorToCol1
  //
  // We detect this by checking if the write starts with \x1b[2K (eraseLine).
  // Then count all \x1b[2K occurrences in the leading erase block to get N.
  const ERASE_LINE = '\x1b[2K'
  const CURSOR_UP = '\x1b[A'
  const CURSOR_COL1 = '\x1b[G'

  process.stdout.write = function (
    data: string | Uint8Array,
    ...args: unknown[]
  ): boolean {
    if (typeof data === 'string' && data.startsWith(ERASE_LINE)) {
      // Count how many lines the eraseLines sequence clears by counting
      // the erase+cursorUp pairs plus the final eraseLine.
      let pos = 0
      let lineCount = 0
      while (data.startsWith(ERASE_LINE, pos)) {
        lineCount++
        pos += ERASE_LINE.length
        if (data.startsWith(CURSOR_UP, pos)) {
          pos += CURSOR_UP.length
        }
      }
      // Skip the trailing \x1b[G (cursor to column 1)
      if (data.startsWith(CURSOR_COL1, pos)) {
        pos += CURSOR_COL1.length
      }

      // Replace eraseLines with: move up N-1 lines + erase to end of screen.
      // \x1b[0J clears all visual lines below regardless of CJK wrapping.
      const moveUp = lineCount > 1 ? `\x1b[${lineCount - 1}A` : ''
      const eraseBelow = '\x1b[0J'
      const rest = data.slice(pos)
      return origWrite.call(process.stdout, BSU + moveUp + eraseBelow + rest + ESU, ...args as [])
    }
    // Non-erase writes: wrap in BSU/ESU if they contain ANSI
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

  // Patch stdout BEFORE Ink starts rendering
  const restoreStdout = patchStdoutForCJK()

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
    restoreStdout()
  }
}
