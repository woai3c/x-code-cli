// @x-code/cli — Agent state management hook
import { useCallback, useEffect, useRef, useState } from 'react'

import { agentLoop, compressMessages, initMemories, loadLatestSession, saveSession, scanProject } from '@x-code/core'
import type {
  AgentCallbacks,
  AgentOptions,
  DisplayMessage,
  LanguageModel,
  LoopState,
  SessionSummary,
  TokenUsage,
} from '@x-code/core'

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

  const startStreamingFlush = useCallback(() => {
    if (flushTimerRef.current) return
    flushTimerRef.current = setInterval(() => {
      if (streamingBufferRef.current) {
        const buffered = streamingBufferRef.current
        streamingBufferRef.current = ''
        setState((prev) => ({ ...prev, streamingText: prev.streamingText + buffered }))
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
          setState((prev) => ({ ...prev, currentToolCall: { toolName, input } }))
        },
        onToolResult: (_toolCallId, _result) => {
          setState((prev) => ({ ...prev, currentToolCall: null, shellOutput: '' }))
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

        // Add assistant message from streaming text
        setState((prev) => {
          const assistantMsg: DisplayMessage = {
            id: Date.now().toString(),
            role: 'assistant',
            content: prev.streamingText,
            timestamp: Date.now(),
          }
          return {
            ...prev,
            messages: prev.streamingText ? [...prev.messages, assistantMsg] : prev.messages,
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
    [options, initialize, startStreamingFlush, stopStreamingFlush],
  )

  /** Resolve a pending permission request */
  const resolvePermission = useCallback((approved: boolean) => {
    setState((prev) => {
      prev.pendingPermission?.resolve(approved)
      return { ...prev, pendingPermission: null }
    })
  }, [])

  /** Resolve a pending question */
  const resolveQuestion = useCallback((answer: string) => {
    setState((prev) => {
      prev.pendingQuestion?.resolve(answer)
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
  }
}
