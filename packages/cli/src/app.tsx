// @x-code-cli/cli — Ink render entry.
//
// We depend on `@jrichman/ink` (aliased as `ink` in package.json) rather than
// upstream Ink. The fork ships a cell-level terminal buffer, a string-width
// / StyledLine based measurer, DEC 2026 Synchronized Updates, and IME-aware
// cursor positioning — which together eliminate the CJK/IME jitter the
// original Ink exhibits on long-running chat UIs. Nothing in our codebase
// changes: the fork is API-compatible with `ink`.
import { render } from 'ink'

import type { AgentOptions, LanguageModel, LoadedSession } from '@x-code-cli/core'

import { App } from './ui/app/App.js'
import { printHeader } from './ui/app/AppHeader.js'
import { registerSessionInfoGetter } from './ui/app/session-exit.js'

/** Global cleanup ref — set by App component via onCleanupReady prop */
let registeredCleanup: (() => Promise<void>) | null = null

export function getCleanupFn(): (() => Promise<void>) | null {
  return registeredCleanup
}

export interface StartAppOptions {
  /** Pre-loaded session from `--continue` (loaded synchronously in
   *  index.ts before Ink mounts). Hydrates the agent on first render. */
  initialSession?: LoadedSession | null
  /** When set to 'pick', App pops the session picker dialog on mount —
   *  the `--resume` flag path. The picker reuses the same askQuestion
   *  UI as /resume so there's only one code path to maintain. */
  resumeIntent?: 'pick' | null
}

export function startApp(
  model: LanguageModel,
  options: AgentOptions,
  initialPrompt?: string,
  startOpts: StartAppOptions = {},
) {
  // Print header ONCE before Ink starts — avoids Static re-render duplication
  printHeader(options.modelId)

  const { waitUntilExit } = render(
    <App
      model={model}
      options={options}
      initialPrompt={initialPrompt}
      initialSession={startOpts.initialSession ?? null}
      resumeIntent={startOpts.resumeIntent ?? null}
      onCleanupReady={(fn) => {
        registeredCleanup = fn
      }}
      onSessionInfoReady={(getter) => {
        registerSessionInfoGetter(getter)
      }}
    />,
    { exitOnCtrlC: false },
  )
  return waitUntilExit
}
