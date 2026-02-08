// @x-code/cli — Ink render entry

import React from 'react'

import { render } from 'ink'
import type { LanguageModel } from 'ai'

import type { AgentOptions } from '@x-code/core'

import { App } from './ui/components/App.js'

/** Global cleanup ref — set by App component via onCleanupReady prop */
let registeredCleanup: (() => Promise<void>) | null = null

export function getCleanupFn(): (() => Promise<void>) | null {
  return registeredCleanup
}

export function startApp(model: LanguageModel, options: AgentOptions, initialPrompt?: string) {
  const { waitUntilExit } = render(
    <App
      model={model}
      options={options}
      initialPrompt={initialPrompt}
      onCleanupReady={(fn) => { registeredCleanup = fn }}
    />,
  )
  return waitUntilExit
}
