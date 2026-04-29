// @x-code-cli/cli — Agent state management hook
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  agentLoop,
  appendInterrupted,
  buildUserContent,
  capabilitiesOf,
  classifyApiError,
  compressMessages,
  flushPendingMessages,
  hydrateLoopState,
  initMemories,
  saveSession,
} from '@x-code-cli/core'
import type {
  AgentCallbacks,
  AgentOptions,
  DisplayMessage,
  DisplayToolCall,
  LanguageModel,
  LoadedSession,
  LoopState,
  ModelMessage,
  PermissionMode,
  TodoItem,
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
  options: { label: string; description: string; freeform?: boolean }[]
  resolve: (answer: string) => void
}

/** Auto-appended trailing option that opens an inline text input.
 *  Mirrors Claude Code's `__other__` row: the model is told (via the
 *  askUser tool's schema description) NOT to add its own "Other"
 *  entry — the UI appends this one at render time so every askUser
 *  dialog is consistently escapable into free text. */
const OTHER_OPTION = {
  label: 'Other',
  description: 'Type a custom answer.',
  freeform: true as const,
}

/** In-flight tool call visible in the live/dynamic UI area. Multiple entries
 *  exist simultaneously when the model issues parallel tool calls in one
 *  turn. The `progress` field holds the LATEST streamed progress message
 *  from `onToolProgress` — it replaces the generic "Running..." fallback
 *  in the `⎿` line, mirroring Claude Code's live tool status updates. */
export interface ActiveToolCall {
  id: string
  toolName: string
  input: Record<string, unknown>
  progress?: string
}

export interface AgentState {
  messages: DisplayMessage[]
  isLoading: boolean
  activeToolCalls: ActiveToolCall[]
  shellOutput: string
  permissionQueue: PendingPermission[]
  pendingQuestion: PendingQuestion | null
  usage: TokenUsage
  error: string | null
  /** Live model id — mirrors modelIdRef so UI can re-render on /model change. */
  modelId: string
  /** Live approval mode for this session. Mirrors `LoopState.permissionMode`
   *  so the bottom UI indicator can re-render whenever the model or the
   *  user (Shift+Tab) flips it. */
  permissionMode: PermissionMode
  /** Live checklist maintained by the model via `todoWrite`. Empty
   *  when the model hasn't started a multi-step task or when all items
   *  have been auto-cleared after completion. Drives the in-frame
   *  todo panel rendered above the spinner in ChatInput. */
  todos: TodoItem[]
}

const initialState: Omit<AgentState, 'modelId' | 'permissionMode'> = {
  messages: [],
  isLoading: false,
  activeToolCalls: [],
  shellOutput: '',
  permissionQueue: [],
  pendingQuestion: null,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  error: null,
  todos: [],
}

type ContentPartLike = { type?: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown; output?: unknown }

/** Pull plain text out of a ModelMessage's content. CoreMessage content
 *  is either a string or an array of typed parts; we only render text
 *  parts (image / file / tool-call go through other paths). */
function extractText(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as ContentPartLike[])
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
}

/** Pull a string output out of a tool-result part. AI SDK normalises
 *  tool outputs to `{ type: 'text' | 'error-text' | ..., value: string }`,
 *  but older / provider-specific shapes also pass through, so we
 *  defensively coerce. */
function readToolOutput(part: ContentPartLike): { output: string; isError: boolean } {
  const out = part.output as { type?: string; value?: unknown } | string | undefined
  if (typeof out === 'string') return { output: out, isError: false }
  if (out && typeof out === 'object') {
    const isError = out.type === 'error-text' || out.type === 'error-json'
    const value = out.value
    if (typeof value === 'string') return { output: value, isError }
    if (value !== undefined) return { output: JSON.stringify(value), isError }
  }
  return { output: '', isError: false }
}

/** Convert a loaded ModelMessage[] back into the DisplayMessage[] shape
 *  that ChatInput renders. Splits each assistant message with N
 *  tool-calls into N+1 DisplayMessages (one text-only when there's
 *  text, then one per tool-call) so the live agent flow's rendering
 *  pattern is preserved verbatim — multiple parallel tool calls in a
 *  single turn still appear as separate `⎿` rows.
 *
 *  Tool messages don't become DisplayMessages of their own; their
 *  output is stitched onto the matching tool-call DisplayMessage by
 *  `toolCallId`. */
function modelMessagesToDisplay(messages: ModelMessage[]): DisplayMessage[] {
  // First pass: index every tool_result by id so we can attach outputs
  // when we encounter the originating tool_call later.
  const toolResults = new Map<string, { output: string; isError: boolean }>()
  for (const msg of messages) {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue
    for (const part of msg.content as ContentPartLike[]) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        toolResults.set(part.toolCallId, readToolOutput(part))
      }
    }
  }
  const out: DisplayMessage[] = []
  let counter = 0
  // Use distinct base timestamps so the message ordering is preserved
  // visually — Date.now() would produce identical ts for back-to-back
  // hydrated messages, which is fine for sorting but reads weirdly in
  // the debug log.
  const baseTs = Date.now() - messages.length
  for (const msg of messages) {
    counter++
    if (msg.role === 'system' || msg.role === 'tool') continue
    const id = `hydrated-${counter}`
    const ts = baseTs + counter
    if (msg.role === 'user') {
      const text = extractText(msg.content)
      if (text) out.push({ id, role: 'user', content: text, timestamp: ts })
      continue
    }
    // assistant
    const text = extractText(msg.content)
    if (text) out.push({ id: `${id}-text`, role: 'assistant', content: text, timestamp: ts })
    if (Array.isArray(msg.content)) {
      let tcIdx = 0
      for (const part of msg.content as ContentPartLike[]) {
        if (part?.type !== 'tool-call' || typeof part.toolCallId !== 'string') continue
        tcIdx++
        const result = toolResults.get(part.toolCallId)
        const tc: DisplayToolCall = {
          id: `${id}-tc-${tcIdx}`,
          toolName: part.toolName ?? 'unknown',
          input: (part.input as Record<string, unknown>) ?? {},
          output: result?.output,
          status: result ? (result.isError ? 'error' : 'completed') : 'pending',
        }
        out.push({
          id: `${id}-tcm-${tcIdx}`,
          role: 'assistant',
          content: '',
          toolCalls: [tc],
          timestamp: ts,
        })
      }
    }
  }
  return out
}

export function useAgent(initialModel: LanguageModel, options: AgentOptions, initialSession?: LoadedSession | null) {
  // If we were launched with a pre-loaded session (--continue), seed the
  // initial UI state from it so messages appear in scrollback before the
  // user submits anything. Token usage is also restored so /usage shows
  // the right totals immediately. The loopStateRef is hydrated in a
  // matching useEffect below — refs can't be set during the useState
  // initializer because useState runs before any other hook.
  const [state, setState] = useState<AgentState>({
    ...initialState,
    modelId: options.modelId,
    permissionMode: options.permissionMode ?? 'default',
    messages: initialSession ? modelMessagesToDisplay(initialSession.messages) : initialState.messages,
    usage: initialSession ? { ...initialSession.tokenUsage } : initialState.usage,
  })

  const modelRef = useRef<LanguageModel>(initialModel)
  const modelIdRef = useRef<string>(options.modelId)
  /** Mirrors state.permissionMode for the agentLoop options on each
   *  submit. The loop reads it via options.permissionMode at start; once
   *  inside the loop, the agent's tool dispatch mutates LoopState
   *  directly, and we mirror that back here via the onPlanModeChange
   *  callback. */
  const permissionModeRef = useRef<PermissionMode>(options.permissionMode ?? 'default')
  /** Mirrors `state.activeToolCalls.length` for the abort() callback, which
   *  needs to read it synchronously without depending on the React state
   *  closure (re-binding the callback per state change would force ChatInput
   *  to re-attach its key handler every render). */
  const activeToolCallsLenRef = useRef(0)
  // Mirror the /thinking toggle so the agent loop reads the LATEST value
  // even when it was changed mid-session — same pattern as modelIdRef.
  // Initial value comes from CLI options (which read it from
  // ~/.x-code/config.json on launch).
  const thinkingRef = useRef<boolean>(options.thinking ?? false)
  const loopStateRef = useRef<LoopState | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const initializedRef = useRef(false)
  /** Pending tool calls keyed by toolCallId. A single slot can't survive
   *  parallel tool calls in one turn — the SDK emits tool-call A, tool-call
   *  B, tool-result A, tool-result B, so a shared slot gets overwritten and
   *  later results fall through to an 'unknown' label. */
  const pendingToolsRef = useRef<
    Map<string, { toolName: string; input: Record<string, unknown>; startedAt: number }>
  >(new Map())

  /** Append a single message to `messages` (used by the stream buffer). */
  const appendMessage = useCallback((msg: DisplayMessage) => {
    setState((prev) => ({ ...prev, messages: [...prev.messages, msg] }))
  }, [])

  const { appendTextDelta, flushBuffer, resetBuffer } = useStreamBuffer(appendMessage)

  // Keep the ref synchronized with state so abort() can decide between
  // `[Request interrupted by user]` and `... for tool use` without taking a
  // state dependency in its useCallback (which would re-bind the prop every
  // render).
  useEffect(() => {
    activeToolCallsLenRef.current = state.activeToolCalls.length
  }, [state.activeToolCalls.length])

  // Hydrate the LoopState ref from the pre-loaded session on first
  // render. Refs can't be initialised in useState (which runs first), so
  // we do it here. Once-only — guarded by initializedRef downstream.
  // useEffect order: this runs after mount but BEFORE the initialPrompt
  // submit effect in App, so by the time the user sends their first
  // message in a resumed session, agentLoop sees `existingState` and
  // continues the same conversation.
  useEffect(() => {
    if (initialSession && !loopStateRef.current) {
      loopStateRef.current = hydrateLoopState(initialSession, options.permissionMode ?? 'default')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
        messages: [...prev.messages, { id: Date.now().toString(), role: 'user', content: text, timestamp: Date.now() }],
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
        onToolCall: (toolCallId, toolName, input) => {
          // Drain the streaming-text buffer AND register the live tool row
          // in the same synchronous tick so React 18 auto-batching folds
          // both setStates into one render → one ChatInput frame → one
          // stdout.write. The previous 4ms `setTimeout` deferral was
          // designed to skip the "Running…" frame for sub-5ms tools, but
          // for slow tools (WebSearch, shell, network) it produced the
          // exact double-write pattern (text-commit frame, then 4ms later
          // tool-row frame) that surfaces as visible flicker on
          // text→tool-call transitions. Fast tools now flash a brief
          // "Running…" row before the result replaces it — acceptable
          // tradeoff: the slow-tool case is the dominant one in real use,
          // and the flash is shorter (~1 frame) than the previous flicker.
          flushBuffer()
          pendingToolsRef.current.set(toolCallId, { toolName, input, startedAt: Date.now() })
          setState((prev) => ({
            ...prev,
            activeToolCalls: [...prev.activeToolCalls, { id: toolCallId, toolName, input }],
          }))
        },
        onToolProgress: (toolCallId, message) => {
          setState((prev) => {
            const idx = prev.activeToolCalls.findIndex((t) => t.id === toolCallId)
            if (idx < 0) return prev
            const next = prev.activeToolCalls.slice()
            next[idx] = { ...next[idx], progress: message }
            return { ...prev, activeToolCalls: next }
          })
        },
        onToolResult: (toolCallId, result, isError) => {
          const pending = pendingToolsRef.current.get(toolCallId)
          pendingToolsRef.current.delete(toolCallId)
          const durationMs = pending ? Date.now() - pending.startedAt : 0
          setState((prev) => {
            const tc: DisplayToolCall = {
              id: `tc-${Date.now()}`,
              toolName: pending?.toolName ?? 'unknown',
              input: pending?.input ?? {},
              output: result,
              status: isError ? 'error' : 'completed',
              durationMs,
            }
            return {
              ...prev,
              activeToolCalls: prev.activeToolCalls.filter((t) => t.id !== toolCallId),
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
            // In plan mode, append two UI-side meta options the model
            // doesn't see in its tool input. Mirrors Claude Code's
            // QuestionView footer (`Chat about this` /
            // `Skip interview and plan immediately`) — the model is
            // taught about them via the system-prompt overlay and
            // recognizes them by their literal label when they come
            // back as the answer.
            //
            // The trailing OTHER_OPTION is appended last so it's always
            // the final row regardless of plan-mode footer presence.
            const planMeta = permissionModeRef.current === 'plan'
              ? [
                  {
                    label: 'Chat about this',
                    description: 'Reply in conversation without picking an option above.',
                  },
                  {
                    label: 'Skip interview and plan immediately',
                    description: 'Stop the questions — produce the final plan now with everything gathered so far.',
                  },
                ]
              : []
            const augmented = [...opts, ...planMeta, OTHER_OPTION]
            setState((prev) => ({ ...prev, pendingQuestion: { question, options: augmented, resolve } }))
          })
        },
        onPlanApprovalRequest: (planText) => {
          // Two-step UX: commit the plan body to scrollback as a regular
          // assistant message (full markdown rendering — headings,
          // bullets, code blocks all look right) and then pop a tight
          // Yes/No dialog. Putting a 50-line plan body inside the
          // SelectOptions `question` field instead overflows the frame,
          // pushes Yes/No off-screen, and produces a wall of `?`-prefixed
          // raw markdown the user can't navigate. The plan file on disk
          // is still the authoritative copy — this scrollback render is
          // for inline review.
          appendMessage({
            id: `plan-approval-${Date.now()}`,
            role: 'assistant',
            content: planText,
            timestamp: Date.now(),
          })
          return new Promise<boolean>((resolve) => {
            setState((prev) => ({
              ...prev,
              pendingQuestion: {
                question: 'Approve the plan above?',
                options: [
                  { label: 'Yes', description: 'Exit plan mode and start implementing (writes auto-approved).' },
                  { label: 'No', description: 'Stay in plan mode and let the model revise.' },
                ],
                resolve: (answer) => resolve(answer === 'Yes'),
              },
            }))
          })
        },
        onPlanModeChange: (mode) => {
          permissionModeRef.current = mode
          setState((prev) => ({ ...prev, permissionMode: mode }))
          // Mode is session-scoped (matches Claude Code) — not
          // persisted to user config. Each new session starts in
          // 'default' unless `--plan` was passed.
        },
        onTodosUpdate: (todos) => {
          // Direct mirror — the core agent has already validated the
          // shape and applied auto-clear semantics; we just store what
          // it gives us so ChatInput can re-render the todo panel.
          setState((prev) => ({ ...prev, todos }))
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
        // Resolve any @path / bare-path references in the input into proper
        // content parts (images for multimodal providers, extracted text for
        // PDF/Office/non-vision providers). Falls through to the plain-string
        // fast path when nothing attachable is detected.
        //
        // The onNotice callback surfaces ingest-time events (currently:
        // vision sub-agent caption emitted) as `⎿`-prefixed gray lines so
        // the user can see when a non-vision model's image was forwarded
        // to a sub-agent (Gemini, GLM-4V, etc.) instead of being OCR'd.
        const content = await buildUserContent(
          text,
          capabilitiesOf(modelIdRef.current),
          (notice) => {
            appendMessage({
              id: `ingest-notice-${Date.now()}`,
              role: 'assistant',
              content: notice,
              timestamp: Date.now(),
              kind: 'command-result',
            })
          },
        )

        loopStateRef.current = await agentLoop(
          content,
          modelRef.current,
          {
            ...options,
            modelId: modelIdRef.current,
            thinking: thinkingRef.current,
            // permissionMode only matters for the FIRST submit (when
            // createLoopState is called inside agentLoop). For subsequent
            // submits the existing LoopState carries the live mode, so
            // this read is just a no-op fallthrough.
            permissionMode: permissionModeRef.current,
            abortSignal: controller.signal,
          },
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
        pendingToolsRef.current.clear()
        setState((prev) => ({ ...prev, isLoading: false, activeToolCalls: [] }))
      } catch (err) {
        pendingToolsRef.current.clear()
        // User-cancel path: agentLoop swallows AbortError into a clean
        // 'aborted' outcome and returns normally, so we shouldn't reach
        // here for an Esc/Ctrl+C abort. But if some unaborted-aware
        // helper (e.g. memory load) does throw mid-flight while the
        // controller is also aborted, suppress the error banner — the
        // `[Request interrupted by user]` notice that abort() already
        // wrote into messages is the user-visible signal we want.
        const wasAborted = controller.signal.aborted
        setState((prev) => ({
          ...prev,
          isLoading: false,
          activeToolCalls: [],
          error: wasAborted ? null : classifyApiError(err).message,
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

  /** Pop a multi-choice question for the user. Same SelectOptions dialog
   *  that `askUser` uses, exposed for slash commands like /model that need
   *  an interactive picker. Returns a promise that resolves to the label
   *  the user chose (or the free-form "Other" text). */
  const askQuestion = useCallback((question: string, options: { label: string; description: string }[]) => {
    return new Promise<string>((resolve) => {
      const augmented = [...options, OTHER_OPTION]
      setState((prev) => ({ ...prev, pendingQuestion: { question, options: augmented, resolve } }))
    })
  }, [])

  /** Abort the in-flight turn. Mirrors Claude Code's onCancel:
   *
   *    1. Flush any buffered streamed text into messages so the user sees
   *       what the model produced before pressing Esc.
   *    2. Append a `[Request interrupted by user]` (or `for tool use`)
   *       notice so both the UI and the next-turn model context show
   *       why the response stopped.
   *    3. Trigger AbortController so streamText / shell execa unwind.
   *
   *  No-op when nothing is in flight (no controller or already aborted).
   *  React state cleanup (isLoading=false, activeToolCalls=[]) happens in
   *  submit()'s success path once agentLoop returns the 'aborted' outcome. */
  const abort = useCallback(() => {
    const controller = abortControllerRef.current
    if (!controller || controller.signal.aborted) return

    // Drain the stream buffer first — appendMessage runs synchronously via
    // setState so the partial assistant reply lands BEFORE the interrupt
    // notice in scrollback order.
    flushBuffer()

    const forToolUse = activeToolCallsLenRef.current > 0
    const noticeText = forToolUse
      ? '[Request interrupted by user for tool use]'
      : '[Request interrupted by user]'

    appendMessage({
      id: `interrupt-${Date.now()}`,
      role: 'assistant',
      content: noticeText,
      timestamp: Date.now(),
      kind: 'command-result',
    })

    // Mirror the notice into the agent loop's message history so the next
    // turn's API call has explicit context that the previous turn was
    // user-interrupted — without it the model would see an unfinished
    // assistant message and might silently try to resume.
    if (loopStateRef.current) {
      loopStateRef.current.messages.push({ role: 'user', content: noticeText })
      // Persist the abort to the jsonl: drop an `interrupted` meta line
      // (informational — picker can show "interrupted" tags) and flush
      // the unsaved tail (which now includes the notice we just pushed)
      // so resume picks up exactly where the user stopped. Both are
      // fire-and-forget; never block the abort path on FS errors.
      void appendInterrupted(loopStateRef.current)
      void flushPendingMessages(loopStateRef.current)
    }

    controller.abort()
  }, [flushBuffer, appendMessage])

  /** Save session and cleanup */
  const cleanup = useCallback(async () => {
    if (loopStateRef.current) {
      await saveSession(loopStateRef.current, modelRef.current)
    }
  }, [])

  /** Synchronous snapshot of the live session for the post-exit hint
   *  printed by index.ts. Returns null when no LoopState exists yet
   *  (user launched but never submitted) — index.ts skips the hint in
   *  that case so we don't suggest resuming an empty file. */
  const getSessionInfo = useCallback(() => {
    const ls = loopStateRef.current
    if (!ls || ls.messages.length === 0) return null
    return { sessionId: ls.sessionId, taskSlug: ls.taskSlug, messageCount: ls.messages.length }
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
    pendingToolsRef.current.clear()
    resetBuffer()
    // Preserve the current live model id and approval mode when clearing
    // — user expects the model they just picked AND the plan-mode toggle
    // they just flipped to stay after /clear (which only nukes the
    // conversation, not session-wide settings).
    setState((prev) => ({ ...initialState, modelId: prev.modelId, permissionMode: prev.permissionMode }))
  }, [resetBuffer])

  /** Mid-session resume: hot-swap the agent state to a previously-saved
   *  session. Hydrates loopStateRef from the jsonl so the next agent
   *  submit appends to the SAME file (filename derives from sessionId +
   *  taskSlug, both preserved by hydrate). Live model and approval mode
   *  carry over from the current session; the resumed session's stored
   *  `modelId` is informational only (in /usage history).
   *
   *  Display-side: we APPEND the converted history to whatever's already
   *  in `state.messages`. We can't replace, because ChatInput's
   *  scrollback-commit diff (`writtenMessageCountRef` in ChatInput.tsx)
   *  treats `messages` as append-only — the only reset trigger is
   *  `length < writtenCount`. Replacing 1 item with 6 leaves the diff
   *  pointing at the wrong slice and the user sees nothing. Appending
   *  matches Claude Code's scrollback discipline ("/resume just
   *  continues; the old prompt and the loaded history both stay
   *  visible") and avoids any diff edge case.
   *
   *  Transient UI state (activeToolCalls, shellOutput, todos, error)
   *  belongs to the OLD session and is reset — those tool calls /
   *  shells / checklists never ran for the loaded session. */
  const resume = useCallback(
    (loaded: LoadedSession) => {
      pendingToolsRef.current.clear()
      resetBuffer()
      loopStateRef.current = hydrateLoopState(loaded, permissionModeRef.current)
      const converted = modelMessagesToDisplay(loaded.messages)
      setState((prev) => ({
        ...prev,
        activeToolCalls: [],
        shellOutput: '',
        error: null,
        todos: [],
        messages: [...prev.messages, ...converted],
        usage: { ...loaded.tokenUsage },
      }))
    },
    [resetBuffer],
  )

  /** Manual context compression */
  const compact = useCallback(async () => {
    if (!loopStateRef.current) return
    loopStateRef.current.messages = await compressMessages(loopStateRef.current.messages, modelRef.current)
  }, [])

  /** Switch model at runtime */
  const switchModel = useCallback((newModelId: string, newModel: LanguageModel) => {
    modelRef.current = newModel
    modelIdRef.current = newModelId
    setState((prev) => ({ ...prev, modelId: newModelId }))
  }, [])

  /** Flip extended-thinking on/off at runtime. Picked up by the next
   *  agent turn via thinkingRef.current. Persistence (saveUserConfig)
   *  happens in the App.tsx command handler, not here — keeping this
   *  hook free of disk side-effects matches the existing model-switch
   *  separation. */
  const setThinking = useCallback((enabled: boolean) => {
    thinkingRef.current = enabled
  }, [])

  /** Read the current /thinking toggle (for status display). */
  const getThinking = useCallback(() => thinkingRef.current, [])

  /** Set permission mode directly. Use this for /plan-style direct
   *  setters where the user is unambiguously asking for a specific
   *  target. Updates LoopState live (so the next agent turn picks up
   *  the new mode), invalidates the system-prompt cache (so the next
   *  turn rebuilds the prompt with the right overlay), reserves /
   *  clears the plan-file path, and mirrors the change into the React
   *  state for UI re-render. */
  const setPermissionMode = useCallback((next: PermissionMode) => {
    if (permissionModeRef.current === next) return
    permissionModeRef.current = next
    if (loopStateRef.current) {
      loopStateRef.current.permissionMode = next
      loopStateRef.current.systemPromptCache = null
      // Clear the path on leaving plan mode so a future re-entry gets a
      // fresh slug derived from whatever the user is asking next; the
      // path is re-derived lazily in agentLoop / enterPlanMode handler
      // from the next user message.
      if (next !== 'plan') loopStateRef.current.currentPlanPath = null
    }
    setState((prev) => ({ ...prev, permissionMode: next }))
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

  /** Render a slash command + its short result as a Claude-style 2-line block:
   *    > /cmd
   *      ⎿  result
   *  Use for single-line command responses. For long multi-line output
   *  (/help, /usage, /init) call addUserMessage + addInfoMessage directly. */
  const addCommandMessage = useCallback(
    (commandText: string, resultText: string) => {
      const base = Date.now()
      appendMessage({
        id: `cmd-${base}`,
        role: 'user',
        content: commandText,
        timestamp: base,
        kind: 'command-echo',
      })
      appendMessage({
        id: `cmd-res-${base}`,
        role: 'assistant',
        content: resultText,
        timestamp: base,
        kind: 'command-result',
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
    resume,
    getSessionInfo,
    switchModel,
    setThinking,
    getThinking,
    setPermissionMode,
    saveCurrentSession,
    addInfoMessage,
    addUserMessage,
    addCommandMessage,
    askQuestion,
  }
}
