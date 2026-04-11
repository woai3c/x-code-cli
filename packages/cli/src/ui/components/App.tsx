// @x-code-cli/cli — Root App component
import React, { useEffect } from 'react'

import { Box, Text, useApp } from 'ink'

import { MODEL_ALIASES, createModelRegistry, initProject, loadConfig, resolveModelId } from '@x-code-cli/core'
import type { AgentOptions, LanguageModel } from '@x-code-cli/core'

import { VERSION } from '../../version.js'
import { useAgent } from '../hooks/use-agent.js'
import { ERROR } from '../theme.js'
import { ChatInput } from './ChatInput.js'
import { MessageList } from './MessageList.js'
import { Permission } from './Permission.js'
import { SelectOptions } from './SelectOptions.js'
import { ShellOutput } from './ShellOutput.js'
import { Spinner } from './Spinner.js'
import { ToolCall } from './ToolCall.js'

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
  `\nKeyboard: Ctrl+C to abort current operation`

export function App({ model, options, initialPrompt, onCleanupReady, onUsageUpdate }: AppProps) {
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
          await handleModelSwitch(arg)
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

  async function handleModelSwitch(arg: string) {
    if (!arg) {
      // List available models
      const _config = await loadConfig()
      const aliases = Object.entries(MODEL_ALIASES)
        .map(([alias, id]) => `  ${alias} → ${id}`)
        .join('\n')
      addInfoMessage(`Current model: ${options.modelId}\n\nAvailable aliases:\n${aliases}`)
      return
    }

    try {
      const config = await loadConfig()
      const newModelId = resolveModelId(arg, config)
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
    addInfoMessage('Analyzing project structure...')
    try {
      const result = await initProject()
      const factLines = result.detectedFacts.map((f) => `  - ${f}`).join('\n')
      const fileLines = result.createdFiles.map((f) => `  - ${f}`).join('\n')
      addInfoMessage(
        `**Project initialized**\n\nDetected:\n${factLines}\n\nCreated:\n${fileLines || '  (no new files)'}`,
      )
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

  return (
    // IMPORTANT: <MessageList> uses Ink <Static>, which writes items to stdout
    // out-of-band. Wrapping it in ANY container (even a plain Box) can cause
    // scrollback corruption when Ink's dynamic region needs to repaint over
    // wide-character content. The safest structure is a Fragment at the top
    // so Static items have no parent at all, with all styling isolated to the
    // dynamic sibling below.
    <>
      {/* Message history — Static, permanent scrollback, no parent */}
      <MessageList messages={state.messages} />

      {/* Dynamic region — repainted each render; kept deliberately small.
          Streaming text does NOT live here — it accumulates in
          useAgent's streamBufferRef and flushes into messages (which
          MessageList's useEffect echoes to stdout via writeMessageToStdout). */}
      <Box flexDirection="column" paddingX={1}>
        {/* Current tool call (in-progress) */}
        {state.currentToolCall && !state.pendingPermission && (
          <ToolCall toolName={state.currentToolCall.toolName} input={state.currentToolCall.input} />
        )}

        {/* Shell output */}
        {state.shellOutput && <ShellOutput output={state.shellOutput} />}

        {/* Permission dialog */}
        {state.pendingPermission && (
          <Permission
            toolName={state.pendingPermission.toolName}
            input={state.pendingPermission.input}
            onResolve={resolvePermission}
          />
        )}

        {/* askUser dialog */}
        {state.pendingQuestion && (
          <SelectOptions
            question={state.pendingQuestion.question}
            options={state.pendingQuestion.options}
            onSelect={resolveQuestion}
          />
        )}

        {/* Loading spinner — always visible during isLoading, arrow changes by phase.
            We can't know from React state whether streaming text is in flight
            (the buffer lives in a ref), so we only distinguish "tool-use" from
            the default "requesting" state here. */}
        {state.isLoading && (
          <Spinner
            totalTokens={state.usage.totalTokens}
            mode={state.currentToolCall ? 'tool-use' : 'requesting'}
          />
        )}

        {/* Error */}
        {state.error && <Text color={ERROR}>Error: {state.error}</Text>}

        {/* Input */}
        <ChatInput
          onSubmit={handleSubmit}
          disabled={state.isLoading || !!state.pendingPermission || !!state.pendingQuestion}
          commands={SLASH_COMMANDS}
        />
      </Box>
    </>
  )
}
