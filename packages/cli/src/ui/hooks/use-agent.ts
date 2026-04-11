// @x-code-cli/cli — Agent state management hook
import { useCallback, useRef, useState } from 'react'

import { agentLoop, compressMessages, initMemories, saveSession, scanProject } from '@x-code-cli/core'
import type {
  AgentCallbacks,
  AgentOptions,
  DisplayMessage,
  DisplayToolCall,
  LanguageModel,
  LoopState,
  ModelMessage,
  TokenUsage,
} from '@x-code-cli/core'

/**
 * Safety net: extract the text from the most recent assistant message in
 * the loop state. Used to display a reply when the stream produced no
 * text-delta events but the final response message still carries text
 * (e.g. some reasoning-model providers put everything in one final part).
 */
function extractLastAssistantText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    const content = msg.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    const parts: string[] = []
    for (const part of content as Array<{ type: string; text?: string }>) {
      if (part.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text)
      }
    }
    return parts.join('')
  }
  return ''
}

interface PendingPermission {
  toolName: string
  input: Record<string, unknown>
  resolve: (approved: boolean) => void
}

interface PendingQuestion {
  question: string
  options: { label: string; description: string }[]
  resolve: (answer: string) => void
}

export interface AgentState {
  messages: DisplayMessage[]
  streamingText: string
  isLoading: boolean
  currentToolCall: { toolName: string; input: Record<string, unknown> } | null
  shellOutput: string
  pendingPermission: PendingPermission | null
  pendingQuestion: PendingQuestion | null
  usage: TokenUsage
  error: string | null
}

export function useAgent(initialModel: LanguageModel, options: AgentOptions) {
  const [state, setState] = useState<AgentState>({
    messages: [],
    streamingText: '',
    isLoading: false,
    currentToolCall: null,
    shellOutput: '',
    pendingPermission: null,
    pendingQuestion: null,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0, costCurrency: 'USD' },
    error: null,
  })

  const modelRef = useRef<LanguageModel>(initialModel)
  const modelIdRef = useRef<string>(options.modelId)
  const loopStateRef = useRef<LoopState | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const initializedRef = useRef(false)

  // ── Tool call timing ──
  const toolCallStartRef = useRef<number>(0)

  /**
   * How many lines to keep in the non-Static streaming area.
   * When exceeded, all accumulated text is promoted to Static (messages)
   * and the streaming area starts fresh. This prevents Ink from trying
   * to redraw a non-Static area taller than the terminal.
   */
  const FLUSH_THRESHOLD = 16

  /**
   * Append a text delta directly to state. React 18 auto-batches bursts of
   * setState within a microtask/macrotask, so we don't need an extra buffer
   * + timer layer — which previously introduced subtle ordering bugs where
   * a fast turn could complete before the first flush tick.
   */
  const appendTextDelta = useCallback((delta: string) => {
    if (!delta) return
    setState((prev) => {
      const fullText = prev.streamingText + delta
      if (fullText.split('\n').length > FLUSH_THRESHOLD) {
        return {
          ...prev,
          streamingText: '',
          messages: [
            ...prev.messages,
            {
              id: `stream-${Date.now()}`,
              role: 'assistant' as const,
              content: fullText,
              timestamp: Date.now(),
            },
          ],
        }
      }
      return { ...prev, streamingText: fullText }
    })
  }, [])

  /**
   * Promote any accumulated streaming text into messages (Static) so it
   * appears permanently in the scrollback before a tool call is shown.
   */
  const flushStreamingToMessages = useCallback(() => {
    setState((prev) => {
      if (!prev.streamingText) return prev
      return {
        ...prev,
        streamingText: '',
        messages: [
          ...prev.messages,
          {
            id: `text-${Date.now()}`,
            role: 'assistant' as const,
            content: prev.streamingText,
            timestamp: Date.now(),
          },
        ],
      }
    })
  }, [])

  /** Initialize memories and scan project (once) */
  const initialize = useCallback(async () => {
    if (initializedRef.current) return
    initializedRef.current = true
    await initMemories()
    await scanProject(process.cwd())
  }, [])

  /** Submit a user message */
  const submit = useCallback(
    async (text: string) => {
      await initialize()

      setState((prev) => ({
        ...prev,
        isLoading: true,
        streamingText: '',
        shellOutput: '',
        error: null,
        messages: [
          ...prev.messages,
          {
            id: Date.now().toString(),
            role: 'user',
            content: text,
            timestamp: Date.now(),
          },
        ],
      }))

      const controller = new AbortController()
      abortControllerRef.current = controller

      // Track whether the stream produced any text for this submit, so the
      // safety-net extraction below doesn't duplicate already-flushed text.
      let sawTextDelta = false

      const callbacks: AgentCallbacks = {
        onTextDelta: (delta) => {
          if (delta) sawTextDelta = true
          appendTextDelta(delta)
        },
        onToolCall: (toolName, input) => {
          // Flush any accumulated text to messages first, so it appears
          // in the scrollback BEFORE the tool call indicator.
          flushStreamingToMessages()
          toolCallStartRef.current = Date.now()
          setState((prev) => ({ ...prev, currentToolCall: { toolName, input } }))
        },
        onToolResult: (_toolCallId, result) => {
          const durationMs = Date.now() - toolCallStartRef.current
          // Push the completed tool call directly into messages (Static)
          setState((prev) => {
            const tc: DisplayToolCall = {
              id: `tc-${Date.now()}`,
              toolName: prev.currentToolCall?.toolName ?? 'unknown',
              input: prev.currentToolCall?.input ?? {},
              output: result,
              status: 'completed',
              durationMs,
            }
            return {
              ...prev,
              currentToolCall: null,
              shellOutput: '',
              messages: [
                ...prev.messages,
                {
                  id: `tool-${Date.now()}`,
                  role: 'assistant' as const,
                  content: '',
                  toolCalls: [tc],
                  timestamp: Date.now(),
                },
              ],
            }
          })
        },
        onAskPermission: (toolCall) => {
          return new Promise<boolean>((resolve) => {
            setState((prev) => ({
              ...prev,
              pendingPermission: { ...toolCall, resolve },
            }))
          })
        },
        onAskUser: (question, opts) => {
          return new Promise<string>((resolve) => {
            setState((prev) => ({
              ...prev,
              pendingQuestion: { question, options: opts, resolve },
            }))
          })
        },
        onShellOutput: (chunk) => {
          setState((prev) => ({ ...prev, shellOutput: prev.shellOutput + chunk }))
        },
        onUsageUpdate: (usage) => {
          setState((prev) => ({ ...prev, usage }))
        },
        onContextCompressed: () => {
          // Could show a notification
        },
        onError: (error) => {
          setState((prev) => ({ ...prev, error: error.message }))
        },
      }

      try {
        loopStateRef.current = await agentLoop(
          text,
          modelRef.current,
          { ...options, modelId: modelIdRef.current, abortSignal: controller.signal },
          callbacks,
          loopStateRef.current ?? undefined,
        )

        // Finalize: promote any residual streaming text to messages and
        // clear the loading flag. As a safety net, if streaming produced
        // no text (e.g. the provider only emitted reasoning chunks before
        // the final text landed on `response.messages`), extract the last
        // assistant text directly from loopState so the user always sees
        // a reply.
        setState((prev) => {
          let residual = prev.streamingText
          if (!residual && !sawTextDelta && loopStateRef.current) {
            residual = extractLastAssistantText(loopStateRef.current.messages)
          }

          if (!residual) {
            return { ...prev, isLoading: false, currentToolCall: null }
          }

          return {
            ...prev,
            messages: [
              ...prev.messages,
              {
                id: `text-${Date.now()}`,
                role: 'assistant' as const,
                content: residual,
                timestamp: Date.now(),
              },
            ],
            streamingText: '',
            isLoading: false,
            currentToolCall: null,
          }
        })
      } catch (err) {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
        }))
      }
    },
    [options, initialize, appendTextDelta, flushStreamingToMessages],
  )

  /** Resolve a pending permission request */
  const resolvePermission = useCallback((approved: boolean) => {
    setState((prev) => {
      if (prev.pendingPermission) {
        // Defer the side-effect outside the setState updater to avoid
        // double-invocation under React 18 Strict Mode.
        queueMicrotask(() => prev.pendingPermission!.resolve(approved))
      }
      return { ...prev, pendingPermission: null }
    })
  }, [])

  /** Resolve a pending question */
  const resolveQuestion = useCallback((answer: string) => {
    setState((prev) => {
      if (prev.pendingQuestion) {
        queueMicrotask(() => prev.pendingQuestion!.resolve(answer))
      }
      return { ...prev, pendingQuestion: null }
    })
  }, [])

  /** Abort current operation */
  const abort = useCallback(() => {
    abortControllerRef.current?.abort()
    setState((prev) => ({ ...prev, isLoading: false }))
  }, [])

  /** Save session and cleanup */
  const cleanup = useCallback(async () => {
    if (loopStateRef.current) {
      await saveSession(loopStateRef.current, modelRef.current)
    }
  }, [])

  /** Save session without exiting */
  const saveCurrentSession = useCallback(async () => {
    if (loopStateRef.current) {
      await saveSession(loopStateRef.current, modelRef.current)
      return true
    }
    return false
  }, [])

  /** Clear conversation */
  const clear = useCallback(() => {
    loopStateRef.current = null
    setState({
      messages: [],
      streamingText: '',
      isLoading: false,
      currentToolCall: null,
      shellOutput: '',
      pendingPermission: null,
      pendingQuestion: null,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0, costCurrency: 'USD' },
      error: null,
    })
  }, [])

  /** Manual context compression */
  const compact = useCallback(async () => {
    if (!loopStateRef.current) return
    loopStateRef.current.messages = await compressMessages(loopStateRef.current.messages, modelRef.current)
  }, [])

  /** Switch model at runtime */
  const switchModel = useCallback((newModelId: string, newModel: LanguageModel) => {
    modelRef.current = newModel
    modelIdRef.current = newModelId
  }, [])

  /** Add a system/info message (for slash command output) */
  const addInfoMessage = useCallback((content: string) => {
    setState((prev) => ({
      ...prev,
      messages: [
        ...prev.messages,
        {
          id: Date.now().toString(),
          role: 'assistant',
          content,
          timestamp: Date.now(),
        },
      ],
    }))
  }, [])

  /** Add a user message to the history (for echoing slash commands) */
  const addUserMessage = useCallback((content: string) => {
    setState((prev) => ({
      ...prev,
      messages: [
        ...prev.messages,
        {
          id: Date.now().toString(),
          role: 'user',
          content,
          timestamp: Date.now(),
        },
      ],
    }))
  }, [])

  return {
    state,
    submit,
    resolvePermission,
    resolveQuestion,
    abort,
    cleanup,
    clear,
    compact,
    switchModel,
    saveCurrentSession,
    addInfoMessage,
    addUserMessage,
  }
}
