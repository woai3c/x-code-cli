// @x-code-cli/cli — Agent state management hook
import { useCallback, useEffect, useRef, useState } from 'react'

import { agentLoop, compressMessages, initMemories, loadLatestSession, saveSession, scanProject } from '@x-code-cli/core'
import type {
  AgentCallbacks,
  AgentOptions,
  DisplayMessage,
  DisplayToolCall,
  LanguageModel,
  LoopState,
  SessionSummary,
  TokenUsage,
} from '@x-code-cli/core'

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
  latestSession: SessionSummary | null
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
    latestSession: null,
  })

  const modelRef = useRef<LanguageModel>(initialModel)
  const modelIdRef = useRef<string>(options.modelId)
  const loopStateRef = useRef<LoopState | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const initializedRef = useRef(false)

  // ── Throttled streaming text buffer ──
  // Accumulate text deltas in a ref and flush to state at a fixed interval
  // to avoid triggering a React re-render on every single token delta.
  const streamingBufferRef = useRef('')
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Tool call timing ──
  const toolCallStartRef = useRef<number>(0)

  /**
   * How many lines to keep in the non-Static streaming area.
   * When exceeded, ALL accumulated text is flushed to Static and
   * the streaming area starts fresh. This prevents Ink from trying
   * to redraw a non-Static area taller than the terminal, which
   * causes flickering, jumping, and blank space artifacts.
   *
   * The text content in messages (Static) has no `●` prefix, so
   * flushing is visually seamless.
   */
  const FLUSH_THRESHOLD = 16

  const startStreamingFlush = useCallback(() => {
    if (flushTimerRef.current) return
    flushTimerRef.current = setInterval(() => {
      if (streamingBufferRef.current) {
        const buffered = streamingBufferRef.current
        streamingBufferRef.current = ''
        setState((prev) => {
          const fullText = prev.streamingText + buffered
          const lineCount = fullText.split('\n').length

          // If text exceeds threshold, push ALL to Static and start fresh.
          // This keeps the non-Static area small and prevents Ink flicker.
          if (lineCount > FLUSH_THRESHOLD) {
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
      }
    }, 50)
  }, [])

  const stopStreamingFlush = useCallback(() => {
    if (flushTimerRef.current) {
      clearInterval(flushTimerRef.current)
      flushTimerRef.current = null
    }
    // Flush any remaining buffered text
    if (streamingBufferRef.current) {
      const buffered = streamingBufferRef.current
      streamingBufferRef.current = ''
      setState((prev) => ({ ...prev, streamingText: prev.streamingText + buffered }))
    }
  }, [])

  /**
   * Flush accumulated streaming text into messages (Static) so it appears
   * permanently in the scrollback before a tool call is shown.
   */
  const flushStreamingToMessages = useCallback(() => {
    // First, drain anything remaining in the buffer ref
    if (streamingBufferRef.current) {
      const buffered = streamingBufferRef.current
      streamingBufferRef.current = ''
      setState((prev) => {
        const fullText = prev.streamingText + buffered
        if (!fullText) return prev
        return {
          ...prev,
          streamingText: '',
          messages: [
            ...prev.messages,
            {
              id: `text-${Date.now()}`,
              role: 'assistant' as const,
              content: fullText,
              timestamp: Date.now(),
            },
          ],
        }
      })
    } else {
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
    }
  }, [])

  // Cleanup flush timer on unmount
  useEffect(() => {
    return () => {
      if (flushTimerRef.current) clearInterval(flushTimerRef.current)
    }
  }, [])

  /** Initialize memories and scan project (once) */
  const initialize = useCallback(async () => {
    if (initializedRef.current) return
    initializedRef.current = true
    await initMemories()
    await scanProject(process.cwd())

    // Check for latest session to offer continuation
    const session = await loadLatestSession()
    if (session && (session.status === 'in_progress' || session.pendingWork.length > 0)) {
      setState((prev) => ({ ...prev, latestSession: session }))
    }
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

      startStreamingFlush()

      const callbacks: AgentCallbacks = {
        onTextDelta: (delta) => {
          streamingBufferRef.current += delta
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

        // Flush any remaining buffered text before finalizing
        stopStreamingFlush()

        // Flush any remaining streaming text to messages
        setState((prev) => {
          if (!prev.streamingText) {
            return { ...prev, isLoading: false, currentToolCall: null }
          }
          return {
            ...prev,
            messages: [
              ...prev.messages,
              {
                id: `text-${Date.now()}`,
                role: 'assistant' as const,
                content: prev.streamingText,
                timestamp: Date.now(),
              },
            ],
            streamingText: '',
            isLoading: false,
            currentToolCall: null,
          }
        })
      } catch (err) {
        stopStreamingFlush()
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
        }))
      }
    },
    [options, initialize, startStreamingFlush, stopStreamingFlush, flushStreamingToMessages],
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
      latestSession: null,
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

  /** Dismiss session continuation prompt */
  const dismissSession = useCallback(() => {
    setState((prev) => ({ ...prev, latestSession: null }))
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
    dismissSession,
    addInfoMessage,
    addUserMessage,
  }
}
