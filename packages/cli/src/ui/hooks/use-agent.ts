// @x-code-cli/cli — Agent state management hook
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  admitGoalInput,
  agentLoop,
  appendCheckpoint,
  appendGoalInput,
  appendGoalState,
  appendGoalVerification,
  appendHeader,
  appendInterrupted,
  buildUserContent,
  buildVerifierFailurePrompt,
  cancelGoal as cancelCoreGoal,
  capabilitiesOf,
  classifyApiError,
  clearGoal as clearCoreGoal,
  clearPendingTransition,
  compressMessages,
  createGoal as createCoreGoal,
  createGoalRunCoordinator,
  createLoopState,
  flushPendingMessages,
  generateTaskSlug,
  getDiffStatsForCheckpoint,
  hydrateLoopState,
  initMemories,
  loadPersistedRules,
  markBoundaryAndReflush,
  modelSupportsVision,
  pauseGoal as pauseCoreGoal,
  recordVerificationFailure,
  resetVerificationFailures,
  restoreCheckpoint,
  resumeGoal as resumeCoreGoal,
  runGoalLoop,
  runVerifierLadder,
  saveSession,
  updateGoalStatus,
} from '@x-code-cli/core'
import { extractText } from '@x-code-cli/core'
import type {
  AgentCallbacks,
  AgentLoopResult,
  AgentOptions,
  CheckpointEntry,
  DiffStats,
  DisplayMessage,
  GoalState,
  GoalVerifier,
  LanguageModel,
  LoadedSession,
  LoopState,
  PermissionMode,
  TodoItem,
  TokenUsage,
} from '@x-code-cli/core'

import { createGoalToolLifecycleCallbacks, createToolLifecycleCallbacks } from './agent-tool-lifecycle.js'
import { useAgentDisplayHelpers } from './use-agent-display-helpers.js'
import { modelMessagesToDisplay } from './use-agent-display.js'
import { extractLastAssistantText, useStreamBuffer } from './use-stream-buffer.js'

export interface PendingPermission {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  /** Populated when the tool name resolves to an MCP registry entry.
   *  Carries the unmangled `<server>/<rawName>` pair so the dialog can
   *  show "MCP tool: filesystem/read_file" instead of the mangled
   *  `filesystem__read_file`. Looked up here rather than in ChatInput so
   *  the registry stays a CLI-startup concern. */
  mcp?: { serverName: string; rawName: string }
}

interface PendingQuestion {
  question: string
  options: { label: string; description: string; freeform?: boolean; preview?: string[] }[]
  resolve: (answer: string) => void
  /** Value passed to `resolve` when the user aborts the turn (Ctrl+C / Esc)
   *  so the agent loop unblocks — `'No'` for plan approval, `''` for
   *  dismissible pickers, interrupt text for `askUser`. */
  abortAnswer: string
  /** True when Esc should dismiss the dialog (resolves with empty string).
   *  User-initiated pickers (`/theme`, `/model`, …) set this — the user
   *  may have opened the menu just to look. AI-initiated questions
   *  (`onAskUser`, plan approval) leave it falsy so the model isn't
   *  silently fed an empty answer. */
  dismissible?: boolean
  layout?: 'compact' | 'compact-vertical'
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
  subToolHistory?: string[]
}

/** A user message submitted while a turn was in flight. Lives in the
 *  pending list above the input box until the agent loop injects it at
 *  the next tool boundary (steering) — then it becomes a regular user
 *  message in scrollback. Mirrors Codex's QueuedUserMessage. */
export interface QueuedMessage {
  id: string
  /** Display text — shown in the pending list and committed to scrollback. */
  text: string
  /** What the model actually sees, when it differs from the display text
   *  (e.g. a queued `/skill` activation: scrollback shows the user's
   *  request, the model receives the <activated_skill> envelope).
   *  Defaults to `text` when absent. */
  inject?: string
}

export interface AgentState {
  messages: DisplayMessage[]
  isLoading: boolean
  activeToolCalls: ActiveToolCall[]
  shellOutput: string
  permissionQueue: PendingPermission[]
  pendingQuestion: PendingQuestion | null
  /** Mid-turn queue: plain-text submits that arrived while `isLoading`.
   *  Rendered by ChatInput above the spinner; drained by the agent loop
   *  via `consumeQueuedInputs` (see AgentOptions in core). */
  queuedMessages: QueuedMessage[]
  /** One-shot draft restore request for ChatInput. Set when Esc aborts a
   *  turn with messages still queued — they go back into the input box
   *  (merged) instead of vanishing (Codex's input-restore semantics).
   *  `nonce` lets ChatInput's effect distinguish consecutive restores. */
  restoredDraft: { text: string; nonce: number } | null
  usage: TokenUsage
  error: string | null
  /** Live model id — mirrors modelIdRef so UI can re-render on /model change. */
  modelId: string
  /** Live approval mode for this session. Mirrors `LoopState.permissionMode`
   *  so the bottom UI indicator can re-render whenever the model or the
   *  user (via /plan) flips it. */
  permissionMode: PermissionMode
  /** Live checklist maintained by the model via `todoWrite`. Empty
   *  when the model hasn't started a multi-step task or when all items
   *  have been auto-cleared after completion. Drives the in-frame
   *  todo panel rendered above the spinner in ChatInput. */
  todos: TodoItem[]
  /** Sticky flag: true while we're inside a chain of consecutive
   *  collapsible read-only tools (Read/Glob/Grep/ListDir). Drives the
   *  spinner's "Reading…" label across the brief 50-200ms gaps between
   *  one read finishing and the next starting — without it the label
   *  flips back to "Thinking…" between every tool in the chain and
   *  the visible state during a multi-second read flicker is
   *  unreadable. Set true on collapsible read tool-call, false when
   *  any non-read tool runs, the model emits text, the loop ends, or
   *  the user aborts. */
  bufferingReads: boolean
  /** Non-null while context compression is in progress. Drives the
   *  spinner label so the user sees which compression phase is active
   *  instead of a generic "Thinking…". Cleared when compression ends. */
  compressionLabel: string | null
  goalStatus: GoalState | null
  goalRunnerActive: boolean
  goalVerificationActive: boolean
}

export interface RunGoalCommand {
  objective: string
  maxTurns?: number
  tokenBudget?: number
  verifiers?: GoalVerifier[]
  requiresUserConfirmation?: boolean
}

const initialState: Omit<AgentState, 'modelId' | 'permissionMode'> = {
  messages: [],
  isLoading: false,
  activeToolCalls: [],
  shellOutput: '',
  permissionQueue: [],
  pendingQuestion: null,
  queuedMessages: [],
  restoredDraft: null,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    currentContextTokens: 0,
  },
  error: null,
  todos: [],
  bufferingReads: false,
  compressionLabel: null,
  goalStatus: null,
  goalRunnerActive: false,
  goalVerificationActive: false,
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
    goalStatus: initialSession?.goal ? { ...initialSession.goal } : null,
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
  const goalCoordinatorRef = useRef(createGoalRunCoordinator())
  const initializedRef = useRef(false)
  const pendingQuestionRef = useRef<PendingQuestion | null>(null)
  /** Pending tool calls keyed by toolCallId. A single slot can't survive
   *  parallel tool calls in one turn — the SDK emits tool-call A, tool-call
   *  B, tool-result A, tool-result B, so a shared slot gets overwritten and
   *  later results fall through to an 'unknown' label. */
  const pendingToolsRef = useRef<Map<string, { toolName: string; input: Record<string, unknown>; startedAt: number }>>(
    new Map(),
  )
  /** Edit-tool diff payloads keyed by toolCallId. Filled by `onFileEdit`
   *  (which fires from tool-execution right before `onToolResult`) and
   *  drained by `onToolResult` to attach the diff to the new
   *  DisplayToolCall. Keyed separately from pendingToolsRef because not
   *  every tool produces a diff and we don't want a default empty
   *  field bloating the pending record. */
  const pendingEditDiffsRef = useRef<Map<string, import('@x-code-cli/core').EditDiffPayload>>(new Map())
  /** Parallel to `permissionQueue`: resolvers for `onAskPermission` promises.
   *  Kept in a ref so `abort()` can deny every queued gate synchronously
   *  before `controller.abort()` — otherwise the core loop stays blocked
   *  on the first shell while the UI still shows stale Yes/No. */
  const permissionResolversRef = useRef<Array<(decision: 'yes' | 'always' | 'no') => void>>([])

  /** Source of truth for the mid-turn message queue. The React state
   *  mirror (`state.queuedMessages`) drives ChatInput's pending list;
   *  the ref exists because `consumeQueuedInputs` is called synchronously
   *  by the agent loop between awaits — reading state there would see a
   *  stale closure. Every mutation updates BOTH in the same tick. */
  const queuedMessagesRef = useRef<QueuedMessage[]>([])
  /** Monotonic id source for queued messages / draft restores. Date.now()
   *  collides within the same millisecond (and `length` repeats after a
   *  pop), which breaks React keys, pop-by-id, and nonce comparisons. */
  const queueSeqRef = useRef(0)

  /** Queue a plain-text submit that arrived while a turn was in flight.
   *  The agent loop drains it at the next tool boundary (or on `stop`).
   *  `inject` overrides what the model sees (display text stays clean). */
  const queueMessage = useCallback((text: string, inject?: string) => {
    const entry: QueuedMessage = { id: `queued-${queueSeqRef.current++}`, text, inject }
    queuedMessagesRef.current = [...queuedMessagesRef.current, entry]
    setState((prev) => ({ ...prev, queuedMessages: queuedMessagesRef.current }))
  }, [])

  /** Remove one queued message by id (ChatInput's ↑-to-pop-back editing). */
  const popQueuedMessage = useCallback((id: string) => {
    queuedMessagesRef.current = queuedMessagesRef.current.filter((m) => m.id !== id)
    setState((prev) => ({ ...prev, queuedMessages: queuedMessagesRef.current }))
  }, [])

  /** Drain the queue: move every queued message into scrollback as a
   *  regular user message and return the texts for injection into
   *  `state.messages`. Passed to agentLoop as `consumeQueuedInputs` —
   *  MUST stay atomic (read + clear in one synchronous step) so a
   *  message can never be injected twice. */
  const consumeQueuedInputs = useCallback((): string[] | undefined => {
    const queued = queuedMessagesRef.current
    if (queued.length === 0) return undefined
    queuedMessagesRef.current = []
    const now = Date.now()
    setState((prev) => ({
      ...prev,
      queuedMessages: [],
      messages: [
        ...prev.messages,
        ...queued.map((m) => ({ id: m.id, role: 'user' as const, content: m.text, timestamp: now })),
      ],
    }))
    return queued.map((m) => m.inject ?? m.text)
  }, [])

  /** Move every still-queued message back into the input box as a single
   *  merged draft (Codex's input_restore semantics — zero loss on Esc).
   *  Used by abort() and by submit's aborted-completion path for messages
   *  that raced in after abort() already ran. */
  const restoreQueueToDraft = useCallback(() => {
    const queued = queuedMessagesRef.current
    if (queued.length === 0) return
    queuedMessagesRef.current = []
    const text = queued.map((m) => m.text).join('\n\n')
    setState((prev) => ({ ...prev, queuedMessages: [], restoredDraft: { text, nonce: queueSeqRef.current++ } }))
  }, [])

  /** Append a single message to `messages` (used by the stream buffer). */
  const appendMessage = useCallback((msg: DisplayMessage) => {
    setState((prev) => ({ ...prev, messages: [...prev.messages, msg] }))
  }, [])

  const { appendTextDelta, flushBuffer, resetBuffer } = useStreamBuffer(appendMessage)

  const toolLifecycleCallbacks = useMemo(
    () =>
      createToolLifecycleCallbacks({
        setState,
        flushBuffer,
        pendingToolsRef,
        pendingEditDiffsRef,
      }),
    [flushBuffer],
  )

  const goalToolLifecycleCallbacks = useMemo(
    () =>
      createGoalToolLifecycleCallbacks({
        setState,
        flushBuffer,
        pendingToolsRef,
      }),
    [flushBuffer],
  )

  const handleTextDelta = useCallback(
    (delta: string) => {
      if (delta) {
        // Text generation ends any in-flight read chain. Avoid a state update
        // for subsequent chunks after the first one has restored "Thinking".
        setState((previous) => (previous.bufferingReads ? { ...previous, bufferingReads: false } : previous))
      }
      appendTextDelta(delta)
    },
    [appendTextDelta],
  )

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

  // Wire the async MCP startup callback: when background connections
  // finish, invalidate the system prompt cache so the next turn rebuilds
  // tools with the newly-available MCP entries.
  useEffect(() => {
    options.onMcpReady = () => {
      if (loopStateRef.current) {
        loopStateRef.current.systemPromptCache = null
        loopStateRef.current.deferredCatalog = undefined
      }
    }
    return () => {
      options.onMcpReady = undefined
    }
  }, [options])

  /** Initialize memories (once). Project context comes from AGENTS.md at the repo
   *  root (walked up from cwd, Codex-style), not from language-specific manifest
   *  scanning, which would bias the tool toward Node/TS projects. */
  const initialize = useCallback(async () => {
    if (initializedRef.current) return
    initializedRef.current = true
    await initMemories()
    loadPersistedRules(process.cwd())
  }, [])

  /** Submit a user message.
   *
   *  `silent: true` skips appending the text to the UI scrollback while still
   *  feeding it to the model (agentLoop pushes the user turn into
   *  loopState.messages on its own). Used by slash commands like `/init` that
   *  inject a long author-side prompt — the user already sees `/init` from
   *  echoCommand, and dumping the full prompt body into scrollback would be
   *  noise. The spinner / abort signal / session save still fire normally. */
  const submit = useCallback(
    async (
      text: string,
      submitOptions?: {
        silent?: boolean
        toolFilter?: AgentOptions['toolFilter']
        maxTurns?: number
        signal?: AbortSignal
        /** Skip the end-of-submit idle-drain. The goal runner drives its
         *  own sequence of submit() calls — a fire-and-forget drain here
         *  would race the runner's NEXT runAgentTurn, running two
         *  agentLoops concurrently over the same LoopState.messages. */
        skipIdleDrain?: boolean
      },
    ): Promise<AgentLoopResult | null> => {
      await initialize()

      setState((prev) => ({
        ...prev,
        isLoading: true,
        shellOutput: '',
        error: null,
        messages: submitOptions?.silent
          ? prev.messages
          : [...prev.messages, { id: Date.now().toString(), role: 'user', content: text, timestamp: Date.now() }],
      }))

      const controller = new AbortController()
      abortControllerRef.current = controller
      const externalSignal = submitOptions?.signal
      const abortFromExternal = () => controller.abort()
      if (externalSignal?.aborted) controller.abort()
      else externalSignal?.addEventListener('abort', abortFromExternal, { once: true })

      // Track whether the stream produced any text for this submit, so the
      // safety-net extraction below doesn't duplicate already-flushed text.
      let sawTextDelta = false

      const callbacks: AgentCallbacks = {
        onTextDelta: (delta) => {
          if (delta) sawTextDelta = true
          handleTextDelta(delta)
        },
        ...toolLifecycleCallbacks,
        onAskPermission: (toolCall) => {
          return new Promise<'yes' | 'always' | 'no'>((resolve) => {
            permissionResolversRef.current.push(resolve)
            // MCP lookup: the registry holds the unmangled server + raw
            // tool name pair we need for the dialog title and the
            // always-allow label. Built-in tools miss the registry and
            // leave `mcp` undefined — ChatInput falls back to its
            // existing per-tool rendering for them.
            const mcpEntry = options.mcpRegistry?.get(toolCall.toolName)
            const entry: PendingPermission = {
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              input: toolCall.input,
              mcp: mcpEntry ? { serverName: mcpEntry.serverName, rawName: mcpEntry.rawName } : undefined,
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
            const planMeta =
              permissionModeRef.current === 'plan'
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
            const pendingQuestion: PendingQuestion = {
              question,
              options: augmented,
              resolve,
              abortAnswer: '[Request interrupted by user]',
              layout: 'compact-vertical',
            }
            pendingQuestionRef.current = pendingQuestion
            setState((prev) => ({ ...prev, pendingQuestion }))
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
            // Delay opening the dialog so the plan-text commit
            // paints first — avoids a simultaneous commit+grow
            // that confuses the geometry engine.
            setTimeout(() => {
              const pendingQuestion: PendingQuestion = {
                question: 'Approve the plan above?',
                options: [
                  { label: 'Yes', description: 'Exit plan mode and start implementing (writes auto-approved).' },
                  { label: 'No', description: 'Stay in plan mode and let the model revise.' },
                ],
                resolve: (answer) => resolve(answer === 'Yes'),
                abortAnswer: 'No',
              }
              pendingQuestionRef.current = pendingQuestion
              setState((prev) => ({ ...prev, pendingQuestion }))
            }, 0)
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
        onUsageUpdate: (usage) => {
          setState((prev) => ({ ...prev, usage }))
        },
        onCompressionProgress: (description) => {
          setState((prev) => ({ ...prev, compressionLabel: description }))
        },
        onContextCompressed: (summary) => {
          setState((prev) => ({ ...prev, compressionLabel: null }))
          appendMessage({
            id: `compress-${Date.now()}`,
            role: 'assistant',
            content: summary,
            timestamp: Date.now(),
            kind: 'command-result',
          })
        },
        onError: (error) => {
          setState((prev) => ({ ...prev, error: error.message }))
        },
        onMemoryWrite: ({ scope, category, key, fact }) => {
          // Fire-and-forget extractor → may arrive after submit() resolved
          // and even into the next turn. We append directly to scrollback;
          // the cell-buffer renderer treats this like any other assistant
          // message and inserts it above the (now possibly active) input
          // box without disturbing whatever the user is typing.
          appendMessage({
            id: `mem-${Date.now()}-${key}`,
            role: 'assistant',
            content: `Remembered (${scope} · ${category}) \`${key}\`: ${fact}`,
            timestamp: Date.now(),
            kind: 'command-result',
          })
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
        const modelId = modelIdRef.current
        const providerCaps = capabilitiesOf(modelId)
        const content = await buildUserContent(
          text,
          modelSupportsVision(modelId) ? providerCaps : { ...providerCaps, image: false },
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

        // agentLoop returns { state, turnCount } — we only keep the state
        // (long-lived session). turnCount is per-invocation and the main
        // interactive loop has no use for it (the cap mechanism is what
        // sub-agents and --print mode use).
        if (submitOptions?.toolFilter && loopStateRef.current) {
          loopStateRef.current.systemPromptCache = null
          loopStateRef.current.expectCacheMiss = true
        }

        const agentResult = await agentLoop(
          content,
          modelRef.current,
          {
            ...options,
            modelId: modelIdRef.current,
            thinking: thinkingRef.current,
            toolFilter: submitOptions?.toolFilter ?? options.toolFilter,
            maxTurns: submitOptions?.maxTurns ?? options.maxTurns,
            // permissionMode only matters for the FIRST submit (when
            // createLoopState is called inside agentLoop). For subsequent
            // submits the existing LoopState carries the live mode, so
            // this read is just a no-op fallthrough.
            permissionMode: permissionModeRef.current,
            abortSignal: controller.signal,
            // Mid-turn steering: messages the user queued while this turn
            // runs are injected at tool boundaries / on stop. Stable
            // callback — reads and clears queuedMessagesRef atomically.
            consumeQueuedInputs,
          },
          callbacks,
          loopStateRef.current ?? undefined,
        )
        loopStateRef.current = agentResult.state
        if (submitOptions?.toolFilter) {
          loopStateRef.current.systemPromptCache = null
          loopStateRef.current.expectCacheMiss = true
        }
        const finalGoal = agentResult.state.goal ? { ...agentResult.state.goal } : null

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
        setState((prev) => ({
          ...prev,
          isLoading: false,
          activeToolCalls: [],
          bufferingReads: false,
          compressionLabel: null,
          goalStatus: finalGoal,
        }))
        externalSignal?.removeEventListener('abort', abortFromExternal)
        if (controller.signal.aborted) {
          // Esc path: anything queued after abort()'s own queue-restore
          // (user hit Esc and Enter nearly simultaneously) would strand a
          // "queued:" row with no spinner and no consumer. Fold it into
          // the restored draft too — zero-loss like abort() itself.
          restoreQueueToDraft()
        } else if (!submitOptions?.skipIdleDrain && queuedMessagesRef.current.length > 0) {
          // Idle-drain: a message queued after the loop's last boundary
          // check (sub-millisecond race at turn end) would otherwise sit
          // in the pending list until the user's next manual submit. Fire
          // it as a fresh silent turn — consumeQueuedInputs already moved
          // it into scrollback. Skipped for goal-runner submits (the
          // runner owns the next turn; a concurrent drain would corrupt
          // shared history).
          const texts = consumeQueuedInputs()
          if (texts?.length) void submitRef.current?.(texts.join('\n\n'), { silent: true })
        }
        return agentResult
      } catch (err) {
        pendingToolsRef.current.clear()
        externalSignal?.removeEventListener('abort', abortFromExternal)
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
          bufferingReads: false,
          compressionLabel: null,
          error: wasAborted ? null : classifyApiError(err).message,
        }))
        return null
      }
    },
    [
      options,
      initialize,
      flushBuffer,
      appendMessage,
      handleTextDelta,
      toolLifecycleCallbacks,
      consumeQueuedInputs,
      restoreQueueToDraft,
    ],
  )

  /** Self-reference for the idle-drain follow-up fired from inside
   *  submit()'s success path — a direct recursive call would make the
   *  useCallback depend on itself. Synced every render; the trailing
   *  drain always reaches the latest submit closure. */
  const submitRef = useRef<typeof submit | null>(null)
  useEffect(() => {
    submitRef.current = submit
  })

  /** Resolve the first pending permission request and pop it from the queue */
  const resolvePermission = useCallback((decision: 'yes' | 'always' | 'no') => {
    setState((prev) => {
      const [head, ...tail] = prev.permissionQueue
      if (head) {
        const r = permissionResolversRef.current[0]
        queueMicrotask(() => {
          if (r !== undefined && permissionResolversRef.current[0] === r) {
            permissionResolversRef.current.shift()
            r(decision)
          }
        })
      }
      return { ...prev, permissionQueue: tail }
    })
  }, [])

  /** Resolve a pending question */
  const resolveQuestion = useCallback((answer: string) => {
    const pendingQuestion = pendingQuestionRef.current
    pendingQuestionRef.current = null
    if (pendingQuestion) queueMicrotask(() => pendingQuestion.resolve(answer))
    setState((prev) => ({ ...prev, pendingQuestion: null }))
  }, [])

  /** Pop a multi-choice question for the user. Same SelectOptions dialog
   *  that `askUser` uses, exposed for slash commands like /model that need
   *  an interactive picker. Returns a promise that resolves to the label
   *  the user chose (or the free-form "Other" text). */
  const askQuestion = useCallback(
    (
      question: string,
      options: { label: string; description: string; preview?: string[] }[],
      opts?: { layout?: 'compact' | 'compact-vertical'; noOther?: boolean },
    ) => {
      return new Promise<string>((resolve) => {
        const augmented = opts?.noOther ? options : [...options, OTHER_OPTION]
        const pendingQuestion: PendingQuestion = {
          question,
          options: augmented,
          resolve,
          abortAnswer: '',
          dismissible: true,
          layout: opts?.layout,
        }
        pendingQuestionRef.current = pendingQuestion
        setState((prev) => ({ ...prev, pendingQuestion }))
      })
    },
    [],
  )

  const createGoalCallbacks = useCallback((): AgentCallbacks => {
    return {
      onTextDelta: appendTextDelta,
      ...goalToolLifecycleCallbacks,
      onAskPermission: (toolCall) => {
        return new Promise<'yes' | 'always' | 'no'>((resolve) => {
          permissionResolversRef.current.push(resolve)
          const mcpEntry = options.mcpRegistry?.get(toolCall.toolName)
          setState((prev) => ({
            ...prev,
            permissionQueue: [
              ...prev.permissionQueue,
              {
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                input: toolCall.input,
                mcp: mcpEntry ? { serverName: mcpEntry.serverName, rawName: mcpEntry.rawName } : undefined,
              },
            ],
          }))
        })
      },
      onAskUser: (question, opts) => {
        return new Promise<string>((resolve) => {
          const pendingQuestion: PendingQuestion = {
            question,
            options: [...opts, OTHER_OPTION],
            resolve,
            abortAnswer: '',
            layout: 'compact-vertical',
          }
          pendingQuestionRef.current = pendingQuestion
          setState((prev) => ({ ...prev, pendingQuestion }))
        })
      },
      onPlanApprovalRequest: async () => false,
      onPlanModeChange: (mode) => {
        permissionModeRef.current = mode
        setState((prev) => ({ ...prev, permissionMode: mode }))
      },
      onTodosUpdate: (todos) => setState((prev) => ({ ...prev, todos })),
      onShellOutput: (chunk) => setState((prev) => ({ ...prev, shellOutput: prev.shellOutput + chunk })),
      onUsageUpdate: (usage) => setState((prev) => ({ ...prev, usage })),
      onContextCompressed: (summary) => {
        appendMessage({
          id: `compress-${Date.now()}`,
          role: 'assistant',
          content: summary,
          timestamp: Date.now(),
          kind: 'command-result',
        })
      },
      onError: (error) => setState((prev) => ({ ...prev, error: error.message })),
    }
  }, [appendMessage, appendTextDelta, goalToolLifecycleCallbacks, options.mcpRegistry])

  const ensureLoopState = useCallback((): LoopState => {
    if (!loopStateRef.current) {
      loopStateRef.current = createLoopState(permissionModeRef.current)
    }
    return loopStateRef.current
  }, [])

  const prepareGoalSession = useCallback(async (ls: LoopState, firstPrompt: string) => {
    if (!ls.taskSlug) {
      ls.taskSlug = generateTaskSlug(firstPrompt)
    }
    await appendHeader(ls, modelIdRef.current, firstPrompt)
  }, [])

  const runGoal = useCallback(
    async (command: RunGoalCommand): Promise<void> => {
      const ls = ensureLoopState()
      const goal = createCoreGoal(ls, {
        objective: command.objective,
        maxTurns: command.maxTurns,
        tokenBudget: command.tokenBudget,
        verifiers: command.verifiers ?? [],
        requiresUserConfirmation: command.requiresUserConfirmation,
      })
      setState((prev) => ({ ...prev, goalStatus: { ...goal }, goalRunnerActive: true }))
      await prepareGoalSession(ls, command.objective)
      await appendGoalState(ls)

      await goalCoordinatorRef.current.run(goal.id, async (signal) => {
        try {
          await runGoalLoop({
            state: ls,
            model: modelRef.current,
            options: {
              ...options,
              modelId: modelIdRef.current,
              thinking: thinkingRef.current,
              permissionMode: permissionModeRef.current,
              abortSignal: signal,
            },
            callbacks: createGoalCallbacks(),
            goalId: goal.id,
            signal,
            runAgentTurn: async (content, turnOptions) => {
              const result = await submit(content, {
                silent: true,
                toolFilter: turnOptions?.finalSummary ? { allow: [] } : undefined,
                maxTurns: turnOptions?.finalSummary ? 1 : undefined,
                signal,
                skipIdleDrain: true,
              })
              if (!result) throw new Error('Goal agent turn did not complete')
              return {
                ...result,
                text: extractLastAssistantText(result.state.messages),
              }
            },
          })
        } finally {
          if (loopStateRef.current) {
            void appendGoalState(loopStateRef.current)
            setState((prev) => ({
              ...prev,
              goalStatus: loopStateRef.current?.goal ? { ...loopStateRef.current.goal } : null,
              goalRunnerActive: false,
            }))
          } else {
            setState((prev) => ({ ...prev, goalRunnerActive: false }))
          }
        }
      })
    },
    [createGoalCallbacks, ensureLoopState, options, prepareGoalSession, submit],
  )

  const drainPendingInteractions = useCallback(() => {
    const permResolvers = permissionResolversRef.current
    permissionResolversRef.current = []
    for (const r of permResolvers) r('no')

    const pendingQuestion = pendingQuestionRef.current
    pendingQuestionRef.current = null
    setState((prev) => ({ ...prev, permissionQueue: [], pendingQuestion: null, bufferingReads: false }))
    if (pendingQuestion) pendingQuestion.resolve(pendingQuestion.abortAnswer)
  }, [])

  const pauseGoal = useCallback(async (): Promise<GoalState | null> => {
    const ls = loopStateRef.current
    if (!ls?.goal) return null
    if (ls.goal.status !== 'active') return null
    const goal = pauseCoreGoal(ls)
    abortControllerRef.current?.abort()
    drainPendingInteractions()
    await goalCoordinatorRef.current.interrupt(goal.id)
    await appendGoalState(ls)
    setState((prev) => ({ ...prev, goalStatus: { ...goal }, goalRunnerActive: false }))
    return goal
  }, [drainPendingInteractions])

  const resumeGoal = useCallback(async (): Promise<GoalState | null> => {
    const ls = loopStateRef.current
    if (!ls?.goal) return null
    let goal: GoalState
    try {
      goal = ls.goal.status === 'active' ? ls.goal : resumeCoreGoal(ls)
    } catch {
      return null
    }
    await appendGoalState(ls)
    setState((prev) => ({ ...prev, goalStatus: { ...goal }, goalRunnerActive: true }))
    goalCoordinatorRef.current.wake(goal.id, async (signal) => {
      try {
        await runGoalLoop({
          state: ls,
          model: modelRef.current,
          options: {
            ...options,
            modelId: modelIdRef.current,
            thinking: thinkingRef.current,
            permissionMode: permissionModeRef.current,
            abortSignal: signal,
          },
          callbacks: createGoalCallbacks(),
          goalId: goal.id,
          signal,
          runAgentTurn: async (content, turnOptions) => {
            const result = await submit(content, {
              silent: true,
              toolFilter: turnOptions?.finalSummary ? { allow: [] } : undefined,
              maxTurns: turnOptions?.finalSummary ? 1 : undefined,
              signal,
              skipIdleDrain: true,
            })
            if (!result) throw new Error('Goal agent turn did not complete')
            return { ...result, text: extractLastAssistantText(result.state.messages) }
          },
        })
      } finally {
        setState((prev) => ({
          ...prev,
          goalStatus: ls.goal ? { ...ls.goal } : null,
          goalRunnerActive: false,
        }))
      }
    })
    return goal
  }, [createGoalCallbacks, options, submit])

  const cancelGoal = useCallback(async (): Promise<GoalState | null> => {
    const ls = loopStateRef.current
    if (!ls?.goal) return null
    const goal = cancelCoreGoal(ls)
    abortControllerRef.current?.abort()
    drainPendingInteractions()
    await goalCoordinatorRef.current.interrupt(goal.id)
    await appendGoalState(ls)
    setState((prev) => ({ ...prev, goalStatus: { ...goal }, goalRunnerActive: false }))
    return goal
  }, [drainPendingInteractions])

  const clearGoal = useCallback(async (): Promise<void> => {
    const ls = loopStateRef.current
    if (!ls) return
    const goalId = ls.goal?.id
    if (goalId) {
      abortControllerRef.current?.abort()
      drainPendingInteractions()
      await goalCoordinatorRef.current.interrupt(goalId)
    }
    clearCoreGoal(ls)
    await appendGoalState(ls)
    setState((prev) => ({ ...prev, goalStatus: null, goalRunnerActive: false }))
  }, [drainPendingInteractions])

  const steerGoal = useCallback(
    async (text: string): Promise<GoalState | null> => {
      const ls = loopStateRef.current
      if (!ls?.goal) return null
      const input = admitGoalInput(ls, { goalId: ls.goal.id, kind: 'user_steering', content: text })
      await appendGoalInput(ls, input)
      await appendGoalState(ls)
      setState((prev) => ({ ...prev, goalStatus: ls.goal ? { ...ls.goal } : null }))
      await resumeGoal()
      return ls.goal
    },
    [resumeGoal],
  )

  const editGoal = useCallback(async (input: { objective?: string; maxTurns?: number }): Promise<GoalState | null> => {
    const ls = loopStateRef.current
    if (!ls?.goal) return null
    if (input.objective !== undefined) {
      const objective = input.objective.trim()
      if (objective) ls.goal.objective = objective
    }
    if (input.maxTurns !== undefined && Number.isFinite(input.maxTurns) && input.maxTurns > 0) {
      ls.goal.maxTurns = Math.floor(input.maxTurns)
    }
    ls.goal.updatedAt = new Date().toISOString()
    ls.systemPromptCache = null
    await appendGoalState(ls)
    setState((prev) => ({ ...prev, goalStatus: ls.goal ? { ...ls.goal } : null }))
    return ls.goal
  }, [])

  const verifyGoal = useCallback(async (): Promise<{ goal: GoalState; ok: boolean; summary: string } | null> => {
    const ls = loopStateRef.current
    if (!ls?.goal) return null
    const controller = new AbortController()
    abortControllerRef.current = controller
    setState((prev) => ({ ...prev, goalVerificationActive: true }))
    try {
      const goal = ls.goal
      const verification = await runVerifierLadder({
        goal,
        state: ls,
        options: {
          ...options,
          modelId: modelIdRef.current,
          thinking: thinkingRef.current,
          permissionMode: permissionModeRef.current,
          abortSignal: controller.signal,
        },
        callbacks: createGoalCallbacks(),
        model: modelRef.current,
      })
      for (const result of verification.results) {
        await appendGoalVerification(ls, goal.id, result)
      }

      if (goal.status === 'active') {
        if (verification.ok) {
          resetVerificationFailures(goal)
          updateGoalStatus(goal, 'complete', verification.summary)
          clearPendingTransition(goal)
        } else {
          const repeatedFailureCount = recordVerificationFailure(goal, verification.results)
          clearPendingTransition(goal)
          const input = admitGoalInput(ls, {
            goalId: goal.id,
            kind: 'verifier_failure',
            content: buildVerifierFailurePrompt(goal, verification.results, verification.summary, repeatedFailureCount),
          })
          await appendGoalInput(ls, input)
          await resumeGoal()
        }
      }

      await appendGoalState(ls)
      setState((prev) => ({ ...prev, goalStatus: { ...goal } }))
      return { goal, ok: verification.ok, summary: verification.summary }
    } finally {
      setState((prev) => ({ ...prev, goalVerificationActive: false }))
    }
  }, [createGoalCallbacks, options, resumeGoal])

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
   *  submit()'s success path once agentLoop returns the 'aborted' outcome.
   *
   *  Queued permission prompts and pending SelectOptions dialogs are
   *  resolved synchronously so `processToolCalls` cannot stay blocked on
   *  `await onAskPermission` / `onAskUser` after the user cancels. */
  const abort = useCallback(() => {
    const controller = abortControllerRef.current
    if (!controller || controller.signal.aborted) return

    // Drain the stream buffer first — appendMessage runs synchronously via
    // setState so the partial assistant reply lands BEFORE the interrupt
    // notice in scrollback order.
    flushBuffer()

    const forToolUse = activeToolCallsLenRef.current > 0
    const noticeText = forToolUse ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]'

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
      if (loopStateRef.current.goal?.status === 'active') {
        try {
          pauseCoreGoal(loopStateRef.current)
          void appendGoalState(loopStateRef.current)
          void goalCoordinatorRef.current.interrupt(loopStateRef.current.goal.id)
          setState((prev) => ({
            ...prev,
            goalStatus: loopStateRef.current?.goal ? { ...loopStateRef.current.goal } : null,
          }))
        } catch {
          // A non-active terminal goal does not need abort-time state changes.
        }
      }
      loopStateRef.current.messages.push({ role: 'user', content: noticeText })
      // Persist the abort to the jsonl: drop an `interrupted` meta line
      // (informational — picker can show "interrupted" tags) and flush
      // the unsaved tail (which now includes the notice we just pushed)
      // so resume picks up exactly where the user stopped. Both are
      // fire-and-forget; never block the abort path on FS errors.
      void appendInterrupted(loopStateRef.current)
      void flushPendingMessages(loopStateRef.current)
    }

    // Unblock any `await onAskPermission` in the core loop (parallel tool
    // calls queue extra UI rows, but execution is sequential — the first
    // shell often sits here while the user thinks the UI is "frozen").
    drainPendingInteractions()

    // Zero-loss queue restore (Codex's input_restore semantics): messages
    // queued mid-turn but never injected go back into the input box as an
    // editable draft instead of being silently dropped or auto-run after
    // the interrupt. ChatInput applies `restoredDraft` on nonce change.
    restoreQueueToDraft()

    controller.abort()
  }, [drainPendingInteractions, flushBuffer, appendMessage, restoreQueueToDraft])

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
    const firstUserMsg = ls.messages.find((m) => m.role === 'user')
    const firstPrompt = firstUserMsg ? extractText(firstUserMsg.content).slice(0, 80) : ''
    return { sessionId: ls.sessionId, taskSlug: ls.taskSlug, messageCount: ls.messages.length, firstPrompt }
  }, [])

  /** Clear conversation while retaining a display-only command echo. */
  const clear = useCallback(
    (commandText = '/clear') => {
      loopStateRef.current = null
      pendingToolsRef.current.clear()
      permissionResolversRef.current = []
      pendingQuestionRef.current = null
      queuedMessagesRef.current = []
      resetBuffer()
      // Preserve the current live model id and approval mode when clearing
      // — user expects the model they just picked AND the plan-mode toggle
      // they just flipped to stay after /clear (which only nukes the
      // conversation, not session-wide settings).
      setState((prev) => ({
        ...initialState,
        modelId: prev.modelId,
        permissionMode: prev.permissionMode,
        messages: [
          {
            id: `cmd-${Date.now()}`,
            role: 'user',
            content: commandText,
            timestamp: Date.now(),
            kind: 'command-echo',
          },
        ],
      }))
    },
    [resetBuffer],
  )

  /** Mid-session resume: hot-swap the agent state to a previously-saved
   *  session. Hydrates loopStateRef from the jsonl so the next agent
   *  submit appends to the SAME file (the exact path is preserved by
   *  hydrate, including legacy slug-prefixed paths). Live model and approval mode
   *  carry over from the current session; the resumed session's stored
   *  `modelId` is informational only (in /usage-history).
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
      queuedMessagesRef.current = []
      resetBuffer()
      loopStateRef.current = hydrateLoopState(loaded, permissionModeRef.current)
      const converted = modelMessagesToDisplay(loaded.messages)
      setState((prev) => ({
        ...prev,
        activeToolCalls: [],
        shellOutput: '',
        error: null,
        todos: [],
        // queuedMessagesRef was cleared above — keep the state mirror in
        // sync or stale pending rows keep rendering until the next queue
        // mutation overwrites them.
        queuedMessages: [],
        restoredDraft: null,
        messages: [...prev.messages, ...converted],
        usage: { ...loaded.tokenUsage },
        goalStatus: loaded.goal ? { ...loaded.goal } : null,
      }))
    },
    [resetBuffer],
  )

  /** Read the live list of /rewind checkpoints for the current session.
   *  Empty when no session exists yet or when nothing has been
   *  checkpointed (the very first turn has no preceding state to
   *  rewind to). Returned as a fresh array so callers can build picker
   *  choices without aliasing the in-memory list. */
  const getCheckpoints = useCallback((): CheckpointEntry[] => {
    return loopStateRef.current?.checkpoints.slice() ?? []
  }, [])

  /** Rewind to a previous checkpoint: restore the working tree to that
   *  point and truncate the message history past it. Caller (App.tsx)
   *  is responsible for picking `ckptId` from `getCheckpoints()` and
   *  surfacing the result message.
   *
   *  Returns ok=false with a human-readable `reason` on any precondition
   *  failure (no session, unknown id, manifest missing) — callers should
   *  surface those via addInfoMessage rather than throwing in the UI.
   *
   *  Side effects on success:
   *    - working tree rolled back per checkpoint manifest
   *    - state.messages truncated to messageCount-1 (drops the user
   *      message that triggered the snapshot AND everything after)
   *    - session jsonl gains a compact-boundary so /resume sees the
   *      same truncated history
   *    - display messages array shrinks → ChatInput's shrink-detection
   *      wipes the scrollback and repaints with the truncated view */
  const rewind = useCallback(
    async (
      ckptId: string,
      mode: 'both' | 'code' | 'conversation' = 'both',
    ): Promise<{ ok: true; preview: string; messageCount: number } | { ok: false; reason: string }> => {
      const ls = loopStateRef.current
      if (!ls) return { ok: false, reason: 'No active session to rewind.' }
      if (state.isLoading) {
        return { ok: false, reason: 'A turn is in progress. Press Esc to cancel it, then run /rewind.' }
      }
      const target = ls.checkpoints.find((c) => c.ckptId === ckptId)
      if (!target) return { ok: false, reason: `Checkpoint not found: ${ckptId}` }

      // Restore working tree (skip for conversation-only rewind).
      if (mode === 'both' || mode === 'code') {
        const ok = await restoreCheckpoint(ls, ckptId)
        if (!ok) {
          return { ok: false, reason: 'Failed to read checkpoint manifest — backups may have been cleaned up.' }
        }
      }

      // Truncate conversation (skip for code-only rewind).
      if (mode === 'both' || mode === 'conversation') {
        const newLen = Math.max(0, target.messageCount - 1)
        ls.messages = ls.messages.slice(0, newLen)
        ls.persistedMessageCount = ls.messages.length

        const survivingCheckpoints = ls.checkpoints.slice()
        await markBoundaryAndReflush(ls)
        ls.checkpoints = survivingCheckpoints
        for (const c of survivingCheckpoints) {
          await appendCheckpoint(ls, c)
        }

        pendingToolsRef.current.clear()
        resetBuffer()
        const converted = modelMessagesToDisplay(ls.messages)
        setState((prev) => ({
          ...prev,
          activeToolCalls: [],
          shellOutput: '',
          error: null,
          todos: [],
          messages: converted,
        }))
      }

      return { ok: true, preview: target.userPrompt, messageCount: target.messageCount - 1 }
    },
    [resetBuffer, state.isLoading],
  )

  /** Manual context compression */
  const compact = useCallback(async (onProgress?: (description: string) => void) => {
    if (!loopStateRef.current) return null
    const { estimateTokenCount, KEEP_RECENT } = await import('@x-code-cli/core')
    if (loopStateRef.current.messages.length <= KEEP_RECENT) return null
    const before = estimateTokenCount(loopStateRef.current.messages)
    onProgress?.('Summarizing conversation...')

    // Extract previous summary for incremental update + file tracking
    const ls = loopStateRef.current
    const firstMsg = ls.messages[0]
    const prefix = '[Previous conversation summary]\n'
    const previousSummary =
      firstMsg?.role === 'user' && typeof firstMsg.content === 'string' && firstMsg.content.startsWith(prefix)
        ? firstMsg.content.slice(prefix.length)
        : undefined
    const modified = [...ls.filesModified]
    const read = [...ls.readFileCache.keys()].filter((p) => !ls.filesModified.has(p))
    const filesTracked = { modified, read }

    ls.messages = await compressMessages(ls.messages, modelRef.current, previousSummary, filesTracked)
    // Messages changed — mirror the auto-compression paths: reset the
    // cache-hit signal so the next turn doesn't wrongly assume a prefix
    // match, and reset lastInputTokens so checkAndCompressContext won't
    // re-trigger on a stale high value. Also write a compact-boundary
    // to the jsonl so the loader can pick up the post-compaction state.
    ls.lastInputTokens = 0
    ls.expectCacheMiss = true
    void markBoundaryAndReflush(ls)
    const after = estimateTokenCount(ls.messages)
    return { beforeTokens: before, afterTokens: after }
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

  /** Drop the cached system prompt so the next agent turn rebuilds it
   *  with whatever the current tool surface looks like.
   *
   *  The cache is the tool-list + plan-overlay snapshot the agent loop
   *  builds at the start of every session and reuses across turns to
   *  preserve OpenAI-compatible providers' prefix caches. Anything that
   *  changes the visible tools — `/mcp refresh` adding or removing
   *  servers, `/mcp auth <name>` bringing a previously-needs_auth server
   *  online — MUST invalidate the cache so the next streamText call
   *  sends a prompt that matches the actual tool list. Otherwise the
   *  model would see tools that don't exist (or miss new ones), and
   *  the loop's `MCP tool not found: …` error path would fire. */
  const invalidateSystemPromptCache = useCallback(() => {
    if (loopStateRef.current) {
      loopStateRef.current.systemPromptCache = null
    }
  }, [])

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

  const getDiffStats = useCallback(async (ckptId: string): Promise<DiffStats | null> => {
    const ls = loopStateRef.current
    if (!ls) return null
    return getDiffStatsForCheckpoint(ls, ckptId)
  }, [])

  const { addInfoMessage, addUserMessage, echoCommand, addCommandMessage, addCommandResult } =
    useAgentDisplayHelpers(appendMessage)

  return {
    state,
    submit,
    queueMessage,
    popQueuedMessage,
    runGoal,
    pauseGoal,
    resumeGoal,
    cancelGoal,
    clearGoal,
    steerGoal,
    editGoal,
    verifyGoal,
    resolvePermission,
    resolveQuestion,
    abort,
    cleanup,
    clear,
    compact,
    resume,
    rewind,
    getCheckpoints,
    getDiffStats,
    getSessionInfo,
    switchModel,
    setThinking,
    getThinking,
    invalidateSystemPromptCache,
    setPermissionMode,
    addInfoMessage,
    addUserMessage,
    echoCommand,
    addCommandMessage,
    addCommandResult,
    askQuestion,
  }
}
