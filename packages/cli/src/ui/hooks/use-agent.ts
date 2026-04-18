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

export function useAgent(initialModel: LanguageModel, options: AgentOptions) {
  const [state, setState] = useState<AgentState>({
    messages: [],
    isLoading: false,
    currentToolCall: null,
    shellOutput: '',
    permissionQueue: [],
    pendingQuestion: null,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    error: null,
  })

  const modelRef = useRef<LanguageModel>(initialModel)
  const modelIdRef = useRef<string>(options.modelId)
  const loopStateRef = useRef<LoopState | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const initializedRef = useRef(false)

  // ── Tool call timing ──
  const toolCallStartRef = useRef<number>(0)

  // ── Streaming text buffer ──
  //
  // We deliberately DO NOT render streaming text in Ink's dynamic region.
  // Ink + CJK wide characters + Yoga layout don't play well: long Chinese
  // paragraphs get their visual row count miscalculated, so when Ink rewinds
  // to repaint the dynamic region the cursor overshoots and old content
  // splices into new content — you see merged bullet points and mangled
  // scrollback on long responses.
  //
  // Instead, deltas are accumulated in a ref and flushed to `messages`
  // (which renders via Ink <Static> — write-once scrollback). Flushes happen
  // at paragraph breaks, every ~300 chars, and on tool-call / end-of-turn
  // boundaries. The user sees text appear a paragraph at a time rather than
  // char-by-char, which trades some "typewriter" feel for a completely
  // corruption-free terminal.
  const streamBufferRef = useRef<string>('')
  const FLUSH_CHAR_THRESHOLD = 300
  const FLUSH_LINE_THRESHOLD = 5

  /** Push whatever is in the buffer into `messages` as one assistant text item. */
  const flushBuffer = useCallback(() => {
    const text = streamBufferRef.current
    if (!text) return
    streamBufferRef.current = ''
    setState((prev) => ({
      ...prev,
      messages: [
        ...prev.messages,
        {
          id: `stream-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: 'assistant' as const,
          content: text,
          timestamp: Date.now(),
        },
      ],
    }))
  }, [])

  /**
   * Accept a text delta from the agent loop.
   *
   * The buffer is flushed when any of these trigger:
   *   1. A paragraph break (`\n\n`) — natural prose boundary
   *   2. ≥ FLUSH_CHAR_THRESHOLD characters accumulated
   *   3. ≥ FLUSH_LINE_THRESHOLD lines accumulated
   *
   * Otherwise the buffer keeps growing silently; `flushBuffer()` is also
   * called by `onToolCall` and at end-of-submit to drain residuals.
   */
  const appendTextDelta = useCallback(
    (delta: string) => {
      if (!delta) return
      streamBufferRef.current += delta
      const buf = streamBufferRef.current
      const shouldFlush =
        buf.includes('\n\n') || buf.length >= FLUSH_CHAR_THRESHOLD || buf.split('\n').length > FLUSH_LINE_THRESHOLD
      if (shouldFlush) flushBuffer()
    },
    [flushBuffer],
  )

  /** Back-compat alias: used by onToolCall to drain text before a tool call. */
  const flushStreamingToMessages = flushBuffer

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
            const entry: PendingPermission = {
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              input: toolCall.input,
              resolve,
            }
            setState((prev) => ({
              ...prev,
              permissionQueue: [...prev.permissionQueue, entry],
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

        // Finalize: drain whatever's left in the stream buffer into messages,
        // then clear the loading flag. As a safety net, if streaming produced
        // no text (e.g. the provider only emitted reasoning chunks before
        // the final text landed on `response.messages`), extract the last
        // assistant text from loopState so the user always sees a reply.
        flushBuffer()
        if (!sawTextDelta && loopStateRef.current) {
          const fallback = extractLastAssistantText(loopStateRef.current.messages)
          if (fallback) {
            setState((prev) => ({
              ...prev,
              messages: [
                ...prev.messages,
                {
                  id: `text-${Date.now()}`,
                  role: 'assistant' as const,
                  content: fallback,
                  timestamp: Date.now(),
                },
              ],
            }))
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
    [options, initialize, appendTextDelta, flushStreamingToMessages, flushBuffer],
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
    streamBufferRef.current = ''
    setState({
      messages: [],
      isLoading: false,
      currentToolCall: null,
      shellOutput: '',
      permissionQueue: [],
      pendingQuestion: null,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
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
