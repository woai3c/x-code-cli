// @x-code-cli/cli — Ink render entry.
//
// We depend on `@jrichman/ink` (aliased as `ink` in package.json) rather than
// upstream Ink. The fork ships a cell-level terminal buffer, a string-width
// / StyledLine based measurer, DEC 2026 Synchronized Updates, and IME-aware
// cursor positioning — which together eliminate the CJK/IME jitter the
// original Ink exhibits on long-running chat UIs. Nothing in our codebase
// changes: the fork is API-compatible with `ink`.
import React from 'react'

import { render } from 'ink'

import type { AgentOptions, LanguageModel } from '@x-code-cli/core'

import { App } from './ui/components/App.js'
import { printHeader } from './ui/components/AppHeader.js'

/** Global cleanup ref — set by App component via onCleanupReady prop */
let registeredCleanup: (() => Promise<void>) | null = null

export function getCleanupFn(): (() => Promise<void>) | null {
  return registeredCleanup
}

export function startApp(model: LanguageModel, options: AgentOptions, initialPrompt?: string) {
  // Print header ONCE before Ink starts — avoids Static re-render duplication
  printHeader(options.modelId)

  const { waitUntilExit } = render(
    <App
      model={model}
      options={options}
      initialPrompt={initialPrompt}
      onCleanupReady={(fn) => {
        registeredCleanup = fn
      }}
    />,
    { exitOnCtrlC: false },
  )
  return waitUntilExit
}
