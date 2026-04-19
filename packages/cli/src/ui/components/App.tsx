// @x-code-cli/cli — Root App component
import React, { useEffect } from 'react'

import { Box, useApp, useStdout } from 'ink'

import { MODEL_ALIASES, createModelRegistry, initProject, resolveModelId } from '@x-code-cli/core'
import type { AgentOptions, LanguageModel } from '@x-code-cli/core'

import { VERSION } from '../../version.js'
import { useAgent } from '../hooks/use-agent.js'
import { ChatInput } from './ChatInput.js'
import { SelectOptions } from './SelectOptions.js'

interface AppProps {
  model: LanguageModel
  options: AgentOptions
  initialPrompt?: string
  onCleanupReady?: (fn: () => Promise<void>) => void
  onUsageUpdate?: (usage: import('@x-code-cli/core').TokenUsage, modelId: string) => void
}

/** Slash commands — used for both help text and tab completion */
export const SLASH_COMMANDS = [
  { name: '/help', description: 'Show this help message' },
  { name: '/model', description: 'Switch model or list available models' },
  { name: '/usage', description: 'Show token usage' },
  { name: '/clear', description: 'Clear conversation history' },
  { name: '/compact', description: 'Manually compress context' },
  { name: '/init', description: 'Initialize project knowledge' },
  { name: '/session save', description: 'Save current session' },
  { name: '/plan', description: 'Enter plan mode' },
  { name: '/exit', description: 'Exit (saves session)' },
] as const

const HELP_TEXT =
  `X-Code CLI v${VERSION}\n\n` +
  SLASH_COMMANDS.map((c) => `  ${c.name.padEnd(16)} ${c.description}`).join('\n') +
  `\n\nModel aliases: ${Object.keys(MODEL_ALIASES).join(', ')}` +
  `\nKeyboard: ${process.platform === 'darwin' ? '⌃C' : 'Ctrl+C'} to abort current operation`

export function App({ model, options, initialPrompt, onCleanupReady, onUsageUpdate }: AppProps) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const termWidth = stdout?.columns ?? 80
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
  } = useAgent(model, options)

  // Register cleanup function for graceful exit (SIGINT)
  useEffect(() => {
    onCleanupReady?.(cleanup)
  }, [cleanup]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync usage to the global ref so exit handler can print it
  useEffect(() => {
    onUsageUpdate?.(state.usage, options.modelId)
  }, [state.usage, options.modelId]) // eslint-disable-line react-hooks/exhaustive-deps

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
          echoCommand(text)
          handleModelSwitch(arg)
          return

        case 'usage':
          echoCommand(text)
          handleUsage()
          return

        case 'clear':
          clear()
          addInfoMessage('Conversation cleared.')
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
          echoCommand(text)
          if (arg.toLowerCase() === 'save') {
            await handleSessionSave()
          } else {
            addInfoMessage('Unknown session command. Use `/session save`.')
          }
          return

        case 'plan':
          await submit(
            'Please enter plan mode to explore the codebase and design an implementation plan before making changes.',
          )
          return

        case 'exit':
          await cleanup()
          exit()
          return

        default:
          echoCommand(text)
          addInfoMessage(`Unknown command: /${command}. Type /help for available commands.`)
          return
      }
    }

    await submit(text)
  }

  function handleModelSwitch(arg: string) {
    if (!arg) {
      // List available models
      const aliases = Object.entries(MODEL_ALIASES)
        .map(([alias, id]) => `  ${alias} → ${id}`)
        .join('\n')
      addInfoMessage(`Current model: ${options.modelId}\n\nAvailable aliases:\n${aliases}`)
      return
    }

    try {
      const newModelId = resolveModelId(arg)
      if (!newModelId) {
        addInfoMessage(`Could not resolve model: ${arg}`)
        return
      }
      const registry = createModelRegistry()
      const newModel = registry.languageModel(newModelId as `${string}:${string}`)
      switchModel(newModelId, newModel)
      addInfoMessage(`Model switched to: ${newModelId}`)
    } catch (err) {
      addInfoMessage(`Failed to switch model: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function handleUsage() {
    const { usage } = state
    addInfoMessage(
      `Token Usage\n` +
        `  Input:    ${usage.inputTokens.toLocaleString()} tokens\n` +
        `  Output:   ${usage.outputTokens.toLocaleString()} tokens\n` +
        `  Total:    ${usage.totalTokens.toLocaleString()} tokens\n` +
        `  Model:    ${options.modelId}`,
    )
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

  async function handleSessionSave() {
    const saved = await saveCurrentSession()
    if (saved) {
      addInfoMessage('Session saved.')
    } else {
      addInfoMessage('No active session to save.')
    }
  }

  // RENDERING ARCHITECTURE
  //
  // `ChatInput` owns the ENTIRE terminal region below the initial header:
  //   - scrollback messages are committed via direct stdout writes
  //   - spinner / input / separators / completions / errors / Permission
  //     dialog all render into a single cell-level diff buffer
  //
  // Ink's dynamic region is kept EMPTY except for `SelectOptions`
  // (askUser dialogs with a free-form "Other" text mode — too involved
  // to reimplement in the cell buffer right now). If Ink ever writes
  // there, its internal use of `\x1b7`/`\x1b8` clobbers our cursor
  // anchor and leaves zombie frames on every cycle.
  const permissionRequest = state.permissionQueue[0]
  const blockingDialog = !!state.pendingQuestion

  return (
    <>
      <Box flexDirection="column" width={termWidth}>
        {state.pendingQuestion && (
          <SelectOptions
            question={state.pendingQuestion.question}
            options={state.pendingQuestion.options}
            onSelect={resolveQuestion}
          />
        )}
      </Box>

      <ChatInput
        messages={state.messages}
        onSubmit={handleSubmit}
        onInterrupt={exit}
        // Lock the keyboard only while SelectOptions owns Ink's bottom
        // region. During loading OR a Permission dialog we keep typing
        // enabled — Permission keys (Up/Down/Enter/y/n) are handled by
        // ChatInput itself; `spinner` tells handleSubmit to gate Enter.
        disabled={blockingDialog}
        hidden={blockingDialog}
        spinner={
          state.isLoading && !blockingDialog && !permissionRequest
            ? {
                label: 'Thinking',
                mode: state.currentToolCall ? 'tool-use' : 'requesting',
                totalTokens: state.usage.totalTokens,
              }
            : null
        }
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
        commands={SLASH_COMMANDS}
      />
    </>
  )
}
