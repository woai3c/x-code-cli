// @x-code/cli — Root App component
import React, { useEffect } from 'react'

import { Box, Text, useApp, useInput } from 'ink'

import { MODEL_ALIASES, VERSION, createModelRegistry, initProject, loadConfig, resolveModelId } from '@x-code/core'
import type { AgentOptions, LanguageModel } from '@x-code/core'

import { useAgent } from '../hooks/use-agent.js'
import { ChatInput } from './ChatInput.js'
import { MessageList } from './MessageList.js'
import { Permission } from './Permission.js'
import { SelectOptions } from './SelectOptions.js'
import { ShellOutput } from './ShellOutput.js'
import { Spinner } from './Spinner.js'
import { StatusBar } from './StatusBar.js'
import { StreamingText } from './StreamingText.js'
import { ToolCall } from './ToolCall.js'

interface AppProps {
  model: LanguageModel
  options: AgentOptions
  initialPrompt?: string
  onCleanupReady?: (fn: () => Promise<void>) => void
}

const HELP_TEXT = `**X-Code CLI v${VERSION}**

Available commands:
| Command | Description |
|---------|-------------|
| \`/help\` | Show this help message |
| \`/model [name]\` | Switch model or list available models |
| \`/usage\` | Show token usage and cost |
| \`/clear\` | Clear conversation history |
| \`/compact\` | Manually compress context |
| \`/init\` | Initialize project knowledge |
| \`/session save\` | Save current session |
| \`/plan\` | Enter plan mode |
| \`/exit\` | Exit (saves session) |

Model aliases: ${Object.keys(MODEL_ALIASES).join(', ')}
Keyboard: Ctrl+C to abort current operation`

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
    dismissSession,
    addInfoMessage,
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

  /** Handle user input (including slash commands) */
  async function handleSubmit(text: string) {
    // Slash commands
    if (text.startsWith('/')) {
      const parts = text.slice(1).trim().split(/\s+/)
      const command = parts[0].toLowerCase()
      const arg = parts.slice(1).join(' ')

      switch (command) {
        case 'help':
          addInfoMessage(HELP_TEXT)
          return

        case 'model':
          await handleModelSwitch(arg)
          return

        case 'usage':
          handleUsage()
          return

        case 'clear':
          clear()
          addInfoMessage('Conversation cleared.')
          return

        case 'compact':
          await handleCompact()
          return

        case 'init':
          await handleInit()
          return

        case 'session':
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
      `**Token Usage**\n` +
        `- Input: ${usage.inputTokens.toLocaleString()} tokens\n` +
        `- Output: ${usage.outputTokens.toLocaleString()} tokens\n` +
        `- Total: ${usage.totalTokens.toLocaleString()} tokens\n` +
        `- Estimated cost: ${costStr}\n` +
        `- Model: ${options.modelId}`,
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
        <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginBottom={1}>
          <Text color="blue" bold>
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
          <Text color="yellow">Continue previous session? (y/n)</Text>
        </Box>
      )}

      {/* Message history */}
      <MessageList messages={state.messages} />

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
      {state.error && <Text color="red">Error: {state.error}</Text>}

      {/* Status bar */}
      <StatusBar modelId={options.modelId} usage={state.usage} />

      {/* Input */}
      {!state.latestSession && (
        <ChatInput
          onSubmit={handleSubmit}
          disabled={state.isLoading || !!state.pendingPermission || !!state.pendingQuestion}
        />
      )}
    </Box>
  )
}
