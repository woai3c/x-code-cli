// @x-code-cli/cli — Agent state management hook
import { useCallback, useRef, useState } from 'react'

import { agentLoop, compressMessages, initMemories, saveSession } from '@x-code-cli/core'
import type {
  AgentCallbacks,
  AgentOptions,
  DisplayMessage,
  DisplayToolCall,
  LanguageModel,
  LoopState,
  TokenUsage,
} from '@x-code-cli/core'

import { extractLastAssistantText, useStreamBuffer } from './use-stream-buffer.js'

export interface PendingPermission {
  toolCallId: string
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
  isLoading: boolean
  currentToolCall: { toolName: string; input: Record<string, unknown> } | null
  shellOutput: string
  permissionQueue: PendingPermission[]
  pendingQuestion: PendingQuestion | null
  usage: TokenUsage
  error: string | null
}

const initialState: AgentState = {
  messages: [],
  isLoading: false,
  currentToolCall: null,
  shellOutput: '',
  permissionQueue: [],
  pendingQuestion: null,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  error: null,
}

export function useAgent(initialModel: LanguageModel, options: AgentOptions) {
  const [state, setState] = useState<AgentState>(initialState)

  const modelRef = useRef<LanguageModel>(initialModel)
  const modelIdRef = useRef<string>(options.modelId)
  const loopStateRef = useRef<LoopState | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const initializedRef = useRef(false)
  const toolCallStartRef = useRef<number>(0)

  /** Append a single message to `messages` (used by the stream buffer). */
  const appendMessage = useCallback((msg: DisplayMessage) => {
    setState((prev) => ({ ...prev, messages: [...prev.messages, msg] }))
  }, [])

  const { appendTextDelta, flushBuffer, resetBuffer } = useStreamBuffer(appendMessage)

  /** Initialize memories (once). Project context comes from AGENTS.md at the repo
   *  root (walked up from cwd, Codex-style), not from language-specific manifest
   *  scanning, which would bias the tool toward Node/TS projects. */
  const initialize = useCallback(async () => {
    if (initializedRef.current) return
    initializedRef.current = true
    await initMemories()
  }, [])

  /** Submit a user message */
  const submit = useCallback(
    async (text: string) => {
      await initialize()

      setState((prev) => ({
        ...prev,
        isLoading: true,
        shellOutput: '',
        error: null,
        messages: [
          ...prev.messages,
          { id: Date.now().toString(), role: 'user', content: text, timestamp: Date.now() },
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
          flushBuffer()
          toolCallStartRef.current = Date.now()
          setState((prev) => ({ ...prev, currentToolCall: { toolName, input } }))
        },
        onToolResult: (_toolCallId, result) => {
          const durationMs = Date.now() - toolCallStartRef.current
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
                  role: 'assistant',
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
            const entry: PendingPermission = {
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              input: toolCall.input,
              resolve,
            }
            setState((prev) => ({ ...prev, permissionQueue: [...prev.permissionQueue, entry] }))
          })
        },
        onAskUser: (question, opts) => {
          return new Promise<string>((resolve) => {
            setState((prev) => ({ ...prev, pendingQuestion: { question, options: opts, resolve } }))
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

        // Finalize: drain whatever's left in the stream buffer into messages,
        // then clear the loading flag. As a safety net, if streaming produced
        // no text (e.g. the provider only emitted reasoning chunks before
        // the final text landed on `response.messages`), extract the last
        // assistant text from loopState so the user always sees a reply.
        flushBuffer()
        if (!sawTextDelta && loopStateRef.current) {
          const fallback = extractLastAssistantText(loopStateRef.current.messages)
          if (fallback) {
            appendMessage({
              id: `text-${Date.now()}`,
              role: 'assistant',
              content: fallback,
              timestamp: Date.now(),
            })
          }
        }
        setState((prev) => ({ ...prev, isLoading: false, currentToolCall: null }))
      } catch (err) {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
        }))
      }
    },
    [options, initialize, appendTextDelta, flushBuffer, appendMessage],
  )

  /** Resolve the first pending permission request and pop it from the queue */
  const resolvePermission = useCallback((approved: boolean) => {
    setState((prev) => {
      const [head, ...tail] = prev.permissionQueue
      if (head) {
        // Defer the side-effect outside the setState updater to avoid
        // double-invocation under React 18 Strict Mode.
        queueMicrotask(() => head.resolve(approved))
      }
      return { ...prev, permissionQueue: tail }
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
    resetBuffer()
    setState(initialState)
  }, [resetBuffer])

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
  const addInfoMessage = useCallback(
    (content: string) => {
      appendMessage({
        id: Date.now().toString(),
        role: 'assistant',
        content,
        timestamp: Date.now(),
      })
    },
    [appendMessage],
  )

  /** Add a user message to the history (for echoing slash commands) */
  const addUserMessage = useCallback(
    (content: string) => {
      appendMessage({
        id: Date.now().toString(),
        role: 'user',
        content,
        timestamp: Date.now(),
      })
    },
    [appendMessage],
  )

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
