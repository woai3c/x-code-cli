// @x-code/cli — Root App component
import React, { useEffect } from 'react'

import { Box, Text, useApp, useInput } from 'ink'

import { MODEL_ALIASES, VERSION, createModelRegistry, initProject, loadConfig, resolveModelId } from '@x-code/core'
import type { AgentOptions, LanguageModel } from '@x-code/core'

import { useAgent } from '../hooks/use-agent.js'
import { ACCENT, ERROR, WARNING } from '../theme.js'
import { AppHeader } from './AppHeader.js'
import { ChatInput } from './ChatInput.js'
import { MessageList } from './MessageList.js'
import { Permission } from './Permission.js'
import { SelectOptions } from './SelectOptions.js'
import { ShellOutput } from './ShellOutput.js'
import { Spinner } from './Spinner.js'
import { StreamingText } from './StreamingText.js'
import { ToolCall } from './ToolCall.js'

interface AppProps {
  model: LanguageModel
  options: AgentOptions
  initialPrompt?: string
  onCleanupReady?: (fn: () => Promise<void>) => void
  onUsageUpdate?: (usage: import('@x-code/core').TokenUsage, modelId: string) => void
}

/** Slash commands — used for both help text and tab completion */
export const SLASH_COMMANDS = [
  { name: '/help', description: 'Show this help message' },
  { name: '/model', description: 'Switch model or list available models' },
  { name: '/usage', description: 'Show token usage and cost' },
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
    dismissSession,
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

  // Handle session continuation Y/N
  useInput(
    (input) => {
      if (!state.latestSession) return
      if (input.toLowerCase() === 'y') {
        const session = state.latestSession
        dismissSession()
        const pendingList = session.pendingWork.map((w) => `- ${w}`).join('\n')
        submit(
          `Continue from previous session "${session.title}".\nPending work:\n${pendingList}\n\nPlease continue where we left off.`,
        )
      } else if (input.toLowerCase() === 'n' || input === '\r') {
        dismissSession()
      }
    },
    {
      isActive: !!state.latestSession && !state.isLoading && !state.pendingPermission && !state.pendingQuestion,
    },
  )

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
    const symbol = usage.costCurrency === 'CNY' ? '¥' : '$'
    const costStr = usage.estimatedCost > 0 ? `${symbol}${usage.estimatedCost.toFixed(4)}` : 'N/A'
    addInfoMessage(
      `Token Usage\n` +
        `  Input:    ${usage.inputTokens.toLocaleString()} tokens\n` +
        `  Output:   ${usage.outputTokens.toLocaleString()} tokens\n` +
        `  Total:    ${usage.totalTokens.toLocaleString()} tokens\n` +
        `  Cost:     ${costStr}\n` +
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
    <Box flexDirection="column" padding={1}>
      {/* Session continuation prompt */}
      {state.latestSession && !state.isLoading && (
        <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginBottom={1}>
          <Text color={ACCENT} bold>
            Previous session: &quot;{state.latestSession.title}&quot; ({state.latestSession.status})
          </Text>
          {state.latestSession.pendingWork.length > 0 && (
            <Box flexDirection="column" marginLeft={2}>
              <Text dimColor>Pending work:</Text>
              {state.latestSession.pendingWork.map((w, i) => (
                <Text key={i} dimColor>
                  - {w}
                </Text>
              ))}
            </Box>
          )}
          <Text color={WARNING}>Continue previous session? (y/n)</Text>
        </Box>
      )}

      {/* Message history (includes startup header as first Static item) */}
      <MessageList messages={state.messages} header={<AppHeader modelId={options.modelId} />} />

      {/* Current streaming text */}
      {state.streamingText && <StreamingText text={state.streamingText} />}

      {/* Current tool call */}
      {state.currentToolCall && !state.pendingPermission && (
        <ToolCall toolName={state.currentToolCall.toolName} input={state.currentToolCall.input} status="running" />
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

      {/* Loading spinner */}
      {state.isLoading && !state.streamingText && !state.currentToolCall && <Spinner />}

      {/* Error */}
      {state.error && <Text color={ERROR}>Error: {state.error}</Text>}

      {/* Input */}
      {!state.latestSession && (
        <ChatInput
          onSubmit={handleSubmit}
          disabled={state.isLoading || !!state.pendingPermission || !!state.pendingQuestion}
          commands={SLASH_COMMANDS}
        />
      )}
    </Box>
  )
}
