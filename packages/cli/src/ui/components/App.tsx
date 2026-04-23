// @x-code-cli/cli — Root App component
import { useEffect } from 'react'

import { useApp } from 'ink'

import {
  MODEL_ALIASES,
  PROVIDER_MODELS,
  createModelRegistry,
  getAvailableProviders,
  initProject,
  resolveModelId,
  saveUserConfig,
} from '@x-code-cli/core'
import type { AgentOptions, LanguageModel } from '@x-code-cli/core'

import { VERSION } from '../../version.js'
import { useAgent } from '../hooks/use-agent.js'
import { getHeaderRowCount } from './AppHeader.js'
import { ChatInput } from './ChatInput.js'

interface AppProps {
  model: LanguageModel
  options: AgentOptions
  initialPrompt?: string
  onCleanupReady?: (fn: () => Promise<void>) => void
}

/** Slash commands — used for both help text and tab completion */
export const SLASH_COMMANDS = [
  { name: '/help', description: 'Show this help message' },
  { name: '/model', description: 'Pick a model (no-arg = interactive) — choice is saved' },
  { name: '/clear', description: 'Clear conversation history' },
  { name: '/compact', description: 'Manually compress context' },
  { name: '/init', description: 'Initialize project knowledge' },
  { name: '/session save', description: 'Save current session' },
  { name: '/exit', description: 'Exit (saves session)' },
] as const

const HELP_TEXT =
  `X-Code CLI v${VERSION}\n\n` +
  SLASH_COMMANDS.map((c) => `  ${c.name.padEnd(16)} ${c.description}`).join('\n') +
  `\n\nModel aliases: ${Object.keys(MODEL_ALIASES).join(', ')}` +
  `\nKeyboard: ${process.platform === 'darwin' ? '⌃C' : 'Ctrl+C'} to abort current operation`

export function App({ model, options, initialPrompt, onCleanupReady }: AppProps) {
  const { exit } = useApp()
  const {
    state,
    submit,
    resolvePermission,
    resolveQuestion,
    cleanup,
    clear,
    compact,
    switchModel,
    saveCurrentSession,
    addInfoMessage,
    addUserMessage,
    addCommandMessage,
    askQuestion,
  } = useAgent(model, options)

  // Register cleanup function for graceful exit (SIGINT)
  useEffect(() => {
    onCleanupReady?.(cleanup)
  }, [cleanup]) // eslint-disable-line react-hooks/exhaustive-deps

  // Handle initial prompt
  useEffect(() => {
    if (initialPrompt) {
      submit(initialPrompt)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Handle print mode — exit after first response
  useEffect(() => {
    if (options.printMode && !state.isLoading && state.messages.length > 1) {
      cleanup().then(() => exit())
    }
  }, [state.isLoading, state.messages.length, options.printMode]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Echo a slash command to the message history (so the user can see what they typed) */
  function echoCommand(text: string) {
    addUserMessage(text)
  }

  /** Handle user input (including slash commands) */
  async function handleSubmit(text: string) {
    // Slash commands
    if (text.startsWith('/')) {
      const parts = text.slice(1).trim().split(/\s+/)
      const command = parts[0].toLowerCase()
      const arg = parts.slice(1).join(' ')

      switch (command) {
        case 'help':
          echoCommand(text)
          addInfoMessage(HELP_TEXT)
          return

        case 'model':
          handleModelSwitch(text, arg)
          return

        case 'clear':
          clear()
          addCommandMessage('/clear', 'Conversation cleared.')
          return

        case 'compact':
          echoCommand(text)
          await handleCompact()
          return

        case 'init':
          echoCommand(text)
          await handleInit()
          return

        case 'session':
          if (arg.toLowerCase() === 'save') {
            await handleSessionSave(text)
          } else {
            addCommandMessage(text, 'Unknown session command. Use `/session save`.')
          }
          return

        case 'exit':
          await cleanup()
          exit()
          return

        default:
          addCommandMessage(text, `Unknown command: /${command}. Type /help for available commands.`)
          return
      }
    }

    await submit(text)
  }

  /** Look up a human-friendly label for a model id; falls back to the raw id. */
  function renderModelLabel(modelId: string): string {
    for (const models of Object.values(PROVIDER_MODELS)) {
      for (const m of models) if (m.id === modelId) return m.label
    }
    return modelId
  }

  /**
   * Commit a model switch: rebuild the provider registry (so the new
   * provider's env-var API key is picked up), swap the live language-model
   * reference, persist to the user config, and echo a confirmation message.
   */
  function commitModelChange(commandText: string, newModelId: string) {
    try {
      const registry = createModelRegistry()
      const newModel = registry.languageModel(newModelId as `${string}:${string}`)
      switchModel(newModelId, newModel)
      saveUserConfig({ model: newModelId })
      addCommandMessage(commandText, `Set model to ${renderModelLabel(newModelId)}`)
    } catch (err) {
      addCommandMessage(commandText, `Failed to switch model: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleModelSwitch(commandText: string, arg: string) {
    // With an explicit arg: keep the old scriptable path (alias or full id).
    if (arg) {
      const newModelId = resolveModelId(arg)
      if (!newModelId) {
        addCommandMessage(commandText, `Could not resolve model: ${arg}`)
        return
      }
      commitModelChange(commandText, newModelId)
      return
    }

    // No arg → interactive picker. Enumerate models whose provider has a
    // configured API key so the list is actionable, not aspirational.
    const providers = new Set(getAvailableProviders())
    const choices: { id: string; label: string; description: string }[] = []
    for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
      if (!providers.has(provider)) continue
      for (const m of models) {
        const marker = m.id === state.modelId ? '● ' : '  '
        choices.push({ id: m.id, label: `${marker}${m.label}`, description: `${m.id} — ${m.description}` })
      }
    }

    if (choices.length === 0) {
      addCommandMessage(
        commandText,
        'No models available — set an API key (e.g. `ANTHROPIC_API_KEY`, `ALIBABA_API_KEY`) and restart.',
      )
      return
    }

    // askQuestion resolves to the chosen option's LABEL (not id). The
    // SelectOptions dialog is designed for human-readable choices, so we
    // look the id back up via the label we pushed.
    const answer = await askQuestion(
      `Current: ${state.modelId}\nPick a model (● = current):`,
      choices.map((c) => ({ label: c.label, description: c.description })),
    )
    const picked = choices.find((c) => c.label === answer)
    if (!picked) {
      // User chose "Other" or typed something free-form. Treat it as a
      // direct model id / alias so power users can still jump to exotic
      // models the picker doesn't list.
      const resolved = resolveModelId(answer)
      if (!resolved) {
        addCommandMessage(commandText, `Could not resolve model: ${answer}`)
        return
      }
      commitModelChange(commandText, resolved)
      return
    }
    if (picked.id === state.modelId) {
      addCommandMessage(commandText, `Already on ${renderModelLabel(picked.id)} — no change.`)
      return
    }
    commitModelChange(commandText, picked.id)
  }

  async function handleCompact() {
    addInfoMessage('Compressing context...')
    await compact()
    addInfoMessage('Context compressed.')
  }

  async function handleInit() {
    addInfoMessage('Initializing project structure...')
    try {
      const result = await initProject()
      const fileLines = result.createdFiles.map((f) => `  - ${f}`).join('\n')
      const body = result.createdFiles.length
        ? `**Project initialized**\n\nCreated:\n${fileLines}\n\nEdit \`AGENTS.md\` at the project root to describe your project — it is loaded into the agent's context every session.`
        : '**Project already initialized** — no new files created.'
      addInfoMessage(body)
    } catch (err) {
      addInfoMessage(`Init failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleSessionSave(commandText: string) {
    const saved = await saveCurrentSession()
    addCommandMessage(commandText, saved ? 'Session saved.' : 'No active session to save.')
  }

  // RENDERING ARCHITECTURE
  //
  // `ChatInput` owns the ENTIRE terminal region below the initial header:
  //   - scrollback messages are committed via direct stdout writes
  //   - spinner / input / separators / completions / errors / Permission
  //     dialog / SelectOptions dialog all render into a single cell-level
  //     diff buffer
  //
  // Ink's dynamic region is ALWAYS empty — we don't render any children
  // into Ink's own subtree. If Ink ever writes there, its internal use of
  // `\x1b7`/`\x1b8` clobbers our cursor anchor and leaves zombie frames.
  // Earlier versions kept SelectOptions as a direct Ink child, but when
  // the dialog grew taller than ChatInput, its rendering caused terminal
  // auto-scroll that left permanent blank rows in scrollback after the
  // dialog closed — so it's been moved into ChatInput's cell buffer too.
  const permissionRequest = state.permissionQueue[0]
  const selectActive = !!state.pendingQuestion

  return (
    <ChatInput
      messages={state.messages}
      initialContentRows={getHeaderRowCount(state.modelId)}
      onSubmit={handleSubmit}
      onInterrupt={exit}
      // Suppress the spinner's "Thinking" line while a select dialog is up,
      // but keep ChatInput itself visible — the dialog is rendered INSIDE
      // its cell buffer now, not in Ink's top subtree.
      spinner={
        state.isLoading && !selectActive && !permissionRequest
          ? {
              label: 'Thinking',
              mode: state.activeToolCalls.length > 0 ? 'tool-use' : 'requesting',
              totalTokens: state.usage.totalTokens,
            }
          : null
      }
      activeToolCalls={state.activeToolCalls}
      errorMessage={state.error}
      permission={
        permissionRequest
          ? {
              toolName: permissionRequest.toolName,
              input: permissionRequest.input,
              onResolve: resolvePermission,
            }
          : null
      }
      selectRequest={
        state.pendingQuestion
          ? {
              question: state.pendingQuestion.question,
              options: state.pendingQuestion.options,
              onResolve: resolveQuestion,
            }
          : null
      }
      commands={SLASH_COMMANDS}
    />
  )
}
