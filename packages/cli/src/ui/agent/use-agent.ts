// @x-code-cli/cli — Agent state management hook
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  accumulateUsage,
  admitGoalInput,
  agentLoop,
  appendCheckpoint,
  appendGoalInput,
  appendGoalState,
  appendGoalVerification,
  appendHeader,
  appendInterrupted,
  appendUsage,
  attributedModelId,
  buildContextBreakdownInput,
  buildUserContent,
  buildVerifierFailurePrompt,
  cancelGoal as cancelCoreGoal,
  capabilitiesOf,
  captureSessionForkSnapshot,
  classifyApiError,
  clearGoal as clearCoreGoal,
  clearPeerContext as clearCorePeerContext,
  clearPendingTransition,
  cloneUsageBreakdown,
  compressTrackedMessagesWithUsage,
  createGoal as createCoreGoal,
  createGoalRunCoordinator,
  createLoopState,
  createUsageBreakdown,
  debugLog,
  estimateContextBreakdown,
  flushPendingMessages,
  forkSession as forkCoreSession,
  formatQueuedAgentInput,
  generateTaskSlug,
  getDiffStatsForCheckpoint,
  hydrateLoopState,
  loadPersistedRules,
  markBoundaryAndReflush,
  markExpectedCacheMiss,
  modelSupportsVision,
  normalizeLanguageModelUsage,
  pauseGoal as pauseCoreGoal,
  recordVerificationFailure,
  resetVerificationFailures,
  restoreCheckpoint,
  resumeGoal as resumeCoreGoal,
  runGoalLoop,
  runVerifierLadder,
  saveSession,
  scanCacheMisses,
  summarizePeerOrigins,
  updateGoalStatus,
} from '@x-code-cli/core'
import { extractText } from '@x-code-cli/core'
import type {
  AgentCallbacks,
  AgentLoopResult,
  AgentOptions,
  AuthorityApproval,
  AuthorityApprovalPreview,
  CacheMissSummary,
  CheckpointEntry,
  ContextBreakdown,
  DiffStats,
  DisplayMessage,
  ExecutionAuthority,
  GoalState,
  GoalVerifier,
  LanguageModel,
  LoadedSession,
  LoopState,
  PermissionMode,
  PublicPeer,
  QueuedAgentInput,
  SessionForkSnapshot,
  ShellSessionEvent,
  ShellSessionSummary,
  StepStats,
  StreamRetryEvent,
  TerminateAllResult,
  TerminationBudget,
  TerminationReason,
  TodoItem,
  TokenUsage,
  UsageBreakdown,
  VisionUsageEvent,
} from '@x-code-cli/core'

import { errorMessage } from '../../../../core/src/utils.js'
import { createGoalToolLifecycleCallbacks, createToolLifecycleCallbacks } from './agent-tool-lifecycle.js'
import { invalidateModelDependentState, invalidateToolSurfaceState } from './model-switch-state.js'
import {
  ownerMayDrainQueuedInputs,
  partitionQueuedInputsForDraft,
  takeFreshQueuedInput,
} from './queued-agent-inputs.js'
import { disposeShellSessionsForTransition } from './shell-session-transition.js'
import {
  type BackgroundTerminalView,
  type ShellUiRuntime,
  type ShellWaitStreak,
  createShellUiRuntime,
  flushCompletedShellWait,
  reduceShellSessionEvent,
} from './shell-session-ui.js'
import { createTurnCoordinator } from './turn-coordinator.js'
import type { TurnLease, TurnOwner } from './turn-coordinator.js'
import { useAgentDisplayHelpers } from './use-agent-display-helpers.js'
import { modelMessagesToDisplay } from './use-agent-display.js'
import { extractLastAssistantText, useStreamBuffer } from './use-stream-buffer.js'

interface PendingPermission {
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

interface PendingAuthority {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  preview: AuthorityApprovalPreview
  resolve: (approval: AuthorityApproval) => void
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

/** Project the internal mixed queue (user + peer entries) into the
 *  display-side pending list — only user entries are shown. */
function toQueuedUserMessages(queued: readonly QueuedAgentInput[]): QueuedMessage[] {
  return queued
    .filter((message): message is Extract<QueuedAgentInput, { source: 'user' }> => message.source === 'user')
    .map((message) => ({ id: message.id, text: message.display, inject: message.content }))
}

export interface AgentState {
  messages: DisplayMessage[]
  isLoading: boolean
  activeToolCalls: ActiveToolCall[]
  shellOutput: string
  permissionQueue: PendingPermission[]
  authorityRequest?: PendingAuthority | null
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
  usageBreakdown: UsageBreakdown
  cacheMissSummary: CacheMissSummary
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
   *  flips back to "Working…" between every tool in the chain and
   *  the visible state during a multi-second read flicker is
   *  unreadable. Set true on collapsible read tool-call, false when
   *  any non-read tool runs, the model emits text, the loop ends, or
   *  the user aborts. */
  bufferingReads: boolean
  /** Non-null while context compression is in progress. Drives the
   *  spinner label so the user sees which compression phase is active
   *  instead of a generic "Working…". Cleared when compression ends. */
  compressionLabel: string | null
  /** Transient provider-stream recovery status shown in place of Working. */
  reconnectLabel: string | null
  goalStatus: GoalState | null
  goalRunnerActive: boolean
  goalVerificationActive: boolean
  /** Per-step token usage snapshots from each agentLoop invocation.
   *  Populated after each submit completes; drives /usage step detail. */
  stepStats: StepStats[]
  /** Persistent transcript-derived security indicator. */
  peerInfluenced?: boolean
  /** Display-only state projected from the active LoopState shell event hub. */
  backgroundTerminals: BackgroundTerminalView[]
  shellWaitStreak: ShellWaitStreak | null
}

export interface RunGoalCommand {
  objective: string
  maxTurns?: number
  tokenBudget?: number
  verifiers?: GoalVerifier[]
  requiresUserConfirmation?: boolean
}

function cloneCacheMissSummary(summary: CacheMissSummary): CacheMissSummary {
  return { ...summary, estimates: summary.estimates.slice() }
}

function peerExecutionAuthority(peer: PublicPeer, messageId: string): ExecutionAuthority {
  return {
    source: 'peer',
    peerTainted: true,
    peerOrigins: summarizePeerOrigins([
      {
        instanceId: peer.address.slice('peer:'.length),
        nameAtReceipt: peer.name,
        messageId,
      },
    ]),
  }
}

function authorityApproval(
  preview: AuthorityApprovalPreview,
  decision: 'allow-once' | 'deny',
  viewedComplete: boolean,
): AuthorityApproval {
  return {
    decision,
    viewedComplete,
    authorityHash: preview.authorityHash,
    canonicalCallSha256: preview.canonicalCallSha256,
    ...(preview.outboundPayload ? { canonicalPayloadSha256: preview.outboundPayload.sha256 } : {}),
  }
}

const initialState: Omit<AgentState, 'modelId' | 'permissionMode'> = {
  messages: [],
  isLoading: false,
  activeToolCalls: [],
  shellOutput: '',
  permissionQueue: [],
  authorityRequest: null,
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
  usageBreakdown: createUsageBreakdown(),
  cacheMissSummary: scanCacheMisses([]),
  error: null,
  todos: [],
  bufferingReads: false,
  compressionLabel: null,
  reconnectLabel: null,
  goalStatus: null,
  goalRunnerActive: false,
  goalVerificationActive: false,
  stepStats: [],
  peerInfluenced: false,
  backgroundTerminals: [],
  shellWaitStreak: null,
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
    usageBreakdown: initialSession?.usageBreakdown
      ? cloneUsageBreakdown(initialSession.usageBreakdown)
      : createUsageBreakdown(),
    cacheMissSummary: cloneCacheMissSummary(
      initialSession?.cacheMissSummary ?? scanCacheMisses(initialSession?.providerTurns ?? []),
    ),
    stepStats: initialSession ? initialSession.stepStats.slice() : initialState.stepStats,
    goalStatus: initialSession?.goal ? { ...initialSession.goal } : null,
    peerInfluenced: initialSession?.contextSecurity.peerInfluenceActive ?? false,
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
  const shellUiRuntimeRef = useRef<ShellUiRuntime | null>(null)
  const shellEventSubscriptionRef = useRef<{
    ownerSessionId: string
    managerInstanceId: string
    unsubscribe: () => void
  } | null>(null)
  /** Detached point-in-time state used by `/fork` while an agentLoop is
   *  active. The outer object is also a sentinel for a first request with no
   *  completed context, where `snapshot` is null. */
  const activeForkBoundaryRef = useRef<{ snapshot: SessionForkSnapshot | null; error?: string } | null>(null)
  const pendingForksRef = useRef(new Set<Promise<unknown>>())
  const abortControllerRef = useRef<AbortController | null>(null)
  /** Identifies the controller owned by `/compact`. Manual compression uses
   *  the shared loading/abort UI, but cancelling it must not append a normal
   *  conversation interrupt message or mutate the model-message history. */
  const manualCompressionControllerRef = useRef<AbortController | null>(null)
  /** Deferred interrupt notice text. Set by abort(), consumed by submit()'s
   *  post-agentLoop path once processToolCalls has fully drained. This avoids
   *  pushing a user-role message into state.messages while tool_results are
   *  still being appended (which breaks assistant→tool ordering). */
  const pendingAbortNoticeRef = useRef<string | null>(null)
  const goalCoordinatorRef = useRef(createGoalRunCoordinator())
  const turnCoordinatorRef = useRef(createTurnCoordinator())
  const initializedRef = useRef(false)
  const pendingQuestionRef = useRef<PendingQuestion | null>(null)
  const pendingAuthorityRef = useRef<PendingAuthority | null>(null)
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
  const queuedMessagesRef = useRef<QueuedAgentInput[]>([])
  const consumedPeerInboxKeysRef = useRef<Set<string>>(new Set())
  /** Monotonic id source for queued messages / draft restores. Date.now()
   *  collides within the same millisecond (and `length` repeats after a
   *  pop), which breaks React keys, pop-by-id, and nonce comparisons. */
  const queueSeqRef = useRef(0)

  const dispatchShellSessionEvent = useCallback((event: ShellSessionEvent) => {
    const binding = shellEventSubscriptionRef.current
    if (
      !binding ||
      event.ownerSessionId !== binding.ownerSessionId ||
      event.managerInstanceId !== binding.managerInstanceId
    ) {
      return
    }
    const runtime = shellUiRuntimeRef.current
    if (!runtime) return
    const reduced = reduceShellSessionEvent(runtime, event)
    if (reduced.runtime === runtime && reduced.notices.length === 0) return
    shellUiRuntimeRef.current = reduced.runtime
    setState((previous) => ({
      ...previous,
      backgroundTerminals: reduced.runtime.backgroundTerminals,
      shellWaitStreak: reduced.runtime.shellWaitStreak,
      messages: reduced.notices.length > 0 ? [...previous.messages, ...reduced.notices] : previous.messages,
    }))
  }, [])

  const bindShellSessionEvents = useCallback(
    (loopState: LoopState) => {
      const managerInstanceId = loopState.shellSessions.managerInstanceId
      if (shellEventSubscriptionRef.current?.managerInstanceId === managerInstanceId) return
      shellEventSubscriptionRef.current?.unsubscribe()
      shellUiRuntimeRef.current = createShellUiRuntime(managerInstanceId)
      const unsubscribe = loopState.shellSessions.subscribe(dispatchShellSessionEvent, { replayCurrent: true })
      shellEventSubscriptionRef.current = {
        ownerSessionId: loopState.sessionId,
        managerInstanceId,
        unsubscribe,
      }
      setState((previous) => ({ ...previous, backgroundTerminals: [], shellWaitStreak: null }))
    },
    [dispatchShellSessionEvent],
  )

  const flushShellWaitUi = useCallback(() => {
    const runtime = shellUiRuntimeRef.current
    if (!runtime) return
    const reduced = flushCompletedShellWait(runtime)
    if (reduced.notices.length === 0) return
    shellUiRuntimeRef.current = reduced.runtime
    setState((previous) => ({
      ...previous,
      shellWaitStreak: reduced.runtime.shellWaitStreak,
      messages: [...previous.messages, ...reduced.notices],
    }))
  }, [])

  useEffect(() => {
    return () => {
      shellEventSubscriptionRef.current?.unsubscribe()
      shellEventSubscriptionRef.current = null
    }
  }, [])

  useEffect(() => {
    const service = options.peerService
    if (!service) return
    return turnCoordinatorRef.current.onChange((lease) => {
      const busyKind =
        lease?.owner === 'goal'
          ? 'goal'
          : lease && ['compact', 'resume', 'rewind', 'clear'].includes(lease.owner)
            ? 'maintenance'
            : 'interactive-turn'
      void service
        .updateLocalState(lease ? { status: 'busy', busyKind } : { status: 'idle' })
        .catch((error) => debugLog('peer.registration-state', String(error)))
    })
  }, [options.peerService])

  /** Queue a plain-text submit that arrived while a turn was in flight.
   *  The agent loop drains it at the next tool boundary (or on `stop`).
   *  `inject` overrides what the model sees (display text stays clean). */
  const queueMessage = useCallback((text: string, inject?: string) => {
    const entry: QueuedAgentInput = {
      id: `queued-${queueSeqRef.current++}`,
      source: 'user',
      display: text,
      content: inject ?? text,
    }
    queuedMessagesRef.current = [...queuedMessagesRef.current, entry]
    setState((prev) => ({ ...prev, queuedMessages: toQueuedUserMessages(queuedMessagesRef.current) }))
  }, [])

  /** Remove one queued message by id (ChatInput's ↑-to-pop-back editing). */
  const popQueuedMessage = useCallback((id: string) => {
    queuedMessagesRef.current = queuedMessagesRef.current.filter(
      (message) => message.source === 'peer' || message.id !== id,
    )
    setState((prev) => ({ ...prev, queuedMessages: toQueuedUserMessages(queuedMessagesRef.current) }))
  }, [])

  /** Drain the queue: move every queued message into scrollback as a
   *  regular user message and return the texts for injection into
   *  `state.messages`. Passed to agentLoop as `consumeQueuedInputs` —
   *  MUST stay atomic (read + clear in one synchronous step) so a
   *  message can never be injected twice. */
  const consumeQueuedInputs = useCallback((): QueuedAgentInput[] | undefined => {
    const queued = queuedMessagesRef.current
    if (queued.length === 0) return undefined
    queuedMessagesRef.current = []
    for (const message of queued) {
      if (message.source === 'peer' && message.inboxKey) consumedPeerInboxKeysRef.current.add(message.inboxKey)
    }
    const now = Date.now()
    setState((prev) => ({
      ...prev,
      queuedMessages: [],
      messages: [
        ...prev.messages,
        ...queued.map((message) => ({
          id: message.id,
          role: 'user' as const,
          content: message.display,
          timestamp: now,
          ...(message.source === 'peer'
            ? { kind: 'peer-message' as const, peer: message.peer, peerMessageId: message.messageId }
            : {}),
        })),
      ],
    }))
    return queued
  }, [])

  const dequeueFreshInput = useCallback((): QueuedAgentInput | undefined => {
    if (queuedMessagesRef.current.length === 0) return undefined
    const taken = takeFreshQueuedInput(queuedMessagesRef.current)
    const next = taken.next
    if (!next) return undefined
    queuedMessagesRef.current = taken.remaining
    setState((prev) => ({
      ...prev,
      queuedMessages: toQueuedUserMessages(queuedMessagesRef.current),
      messages: [
        ...prev.messages,
        {
          id: next.id,
          role: 'user',
          content: next.display,
          timestamp: Date.now(),
          ...(next.source === 'peer'
            ? { kind: 'peer-message' as const, peer: next.peer, peerMessageId: next.messageId }
            : {}),
        },
      ],
    }))
    return next
  }, [])

  /** Move every still-queued message back into the input box as a single
   *  merged draft (Codex's input_restore semantics — zero loss on Esc).
   *  Used by abort() and by submit's aborted-completion path for messages
   *  that raced in after abort() already ran. */
  const restoreQueueToDraft = useCallback(() => {
    const queued = queuedMessagesRef.current
    if (queued.length === 0) return
    const { draft, retained } = partitionQueuedInputsForDraft(queued)
    queuedMessagesRef.current = retained
    if (!draft) return
    setState((prev) => ({ ...prev, queuedMessages: [], restoredDraft: { text: draft, nonce: queueSeqRef.current++ } }))
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
        flushShellWaitUi()
        // Text generation ends any in-flight read chain. Avoid a state update
        // for subsequent chunks after the first one has restored "Working".
        setState((previous) => (previous.bufferingReads ? { ...previous, bufferingReads: false } : previous))
      }
      appendTextDelta(delta)
    },
    [appendTextDelta, flushShellWaitUi],
  )

  const handleStreamRetry = useCallback((event: StreamRetryEvent | null) => {
    setState((previous) => ({
      ...previous,
      reconnectLabel: event ? `Reconnecting... ${event.attempt}/${event.maxAttempts}` : null,
    }))
  }, [])

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
      loopStateRef.current = hydrateLoopState(initialSession, options.permissionMode ?? 'default', process.cwd())
      bindShellSessionEvents(loopStateRef.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Wire the async MCP startup callback: when background connections
  // finish, invalidate the system prompt cache so the next turn rebuilds
  // tools with the newly-available MCP entries.
  useEffect(() => {
    options.onMcpReady = () => {
      invalidateToolSurfaceState(loopStateRef.current)
    }
    return () => {
      options.onMcpReady = undefined
    }
  }, [options])

  /** Initialize process-scoped services once. */
  const initialize = useCallback(async () => {
    if (initializedRef.current) return
    initializedRef.current = true
    await options.memoryService?.initialize(process.cwd())
    loadPersistedRules(process.cwd())
  }, [options.memoryService])

  const currentAuthority = useCallback((source: 'user' | 'peer' = 'user'): ExecutionAuthority => {
    const security = loopStateRef.current?.contextSecurity
    const peerTainted =
      source === 'peer' || security?.peerInfluenceActive === true || security?.integrityFailure === true
    return {
      source,
      peerTainted,
      ...(peerTainted && security?.peerOrigins ? { peerOrigins: security.peerOrigins } : {}),
    }
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
        owner?: TurnOwner
        lease?: TurnLease
        authority?: ExecutionAuthority
        rawContent?: boolean
        peerInboxKeys?: readonly string[]
      },
    ): Promise<AgentLoopResult | null> => {
      const authority = submitOptions?.authority ?? currentAuthority()
      const existingLease = submitOptions?.lease
      const lease = existingLease ?? turnCoordinatorRef.current.tryAcquire(submitOptions?.owner ?? 'user', authority)
      if (!lease) {
        if ((submitOptions?.owner ?? 'user') === 'user') queueMessage(text)
        return null
      }
      const ownsLease = existingLease === undefined
      consumedPeerInboxKeysRef.current.clear()
      const boundaryState = loopStateRef.current
      try {
        activeForkBoundaryRef.current = {
          snapshot: boundaryState ? captureSessionForkSnapshot(boundaryState) : null,
        }
      } catch (error) {
        activeForkBoundaryRef.current = {
          snapshot: null,
          error: errorMessage(error),
        }
      }

      setState((prev) => ({
        ...prev,
        isLoading: true,
        shellOutput: '',
        error: null,
        reconnectLabel: null,
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
        onAskAuthority: (request) => {
          return new Promise<AuthorityApproval>((resolve) => {
            const pending: PendingAuthority = { ...request, resolve }
            pendingAuthorityRef.current = pending
            void options.peerService?.updateLocalState({ status: 'waiting' }).catch(() => {})
            setState((prev) => ({ ...prev, authorityRequest: pending }))
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
          setState((prev) => ({
            ...prev,
            usage,
            usageBreakdown: loopStateRef.current
              ? cloneUsageBreakdown(loopStateRef.current.usageBreakdown)
              : prev.usageBreakdown,
            cacheMissSummary: loopStateRef.current
              ? cloneCacheMissSummary(loopStateRef.current.cacheMissSummary)
              : prev.cacheMissSummary,
          }))
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
        onStreamRetry: handleStreamRetry,
        onError: (error) => {
          setState((prev) => ({ ...prev, error: error.message }))
        },
      }

      try {
        await initialize()
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
        const pendingVisionUsage: VisionUsageEvent[] = []
        const content = submitOptions?.rawContent
          ? text
          : await buildUserContent(
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
              abortControllerRef.current.signal,
              (event) => pendingVisionUsage.push(event),
            )

        const activeLoopState =
          loopStateRef.current ?? createLoopState(permissionModeRef.current, { projectCwd: process.cwd() })
        loopStateRef.current = activeLoopState
        bindShellSessionEvents(activeLoopState)
        for (const event of pendingVisionUsage) {
          accumulateUsage(activeLoopState, {
            source: 'vision',
            modelId: event.modelId,
            usage: normalizeLanguageModelUsage(event.usage),
          })
        }
        if (pendingVisionUsage.length > 0) {
          callbacks.onUsageUpdate(activeLoopState.tokenUsage)

          // The vision caption request has already been billed before the main
          // agent loop starts. Persist it now so an abort or provider failure in
          // the main request cannot silently drop that cost from session usage.
          const firstPrompt = text.replace(/<activated_skill\b[^>]*>[\s\S]*?<\/activated_skill>/gi, '').trim() || text
          if (!activeLoopState.taskSlug) activeLoopState.taskSlug = generateTaskSlug(firstPrompt)
          await appendHeader(activeLoopState, modelId, firstPrompt)
          await appendUsage(activeLoopState, pendingVisionUsage.at(-1)!.modelId)
        }

        // agentLoop returns { state, turnCount } — we only keep the state
        // (long-lived session). turnCount is per-invocation and the main
        // interactive loop has no use for it (the cap mechanism is what
        // sub-agents and --print mode use).
        if (submitOptions?.toolFilter && loopStateRef.current) {
          loopStateRef.current.systemPromptCache = null
          markExpectedCacheMiss(loopStateRef.current, 'tool-surface-change')
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
            executionAuthority: lease.authority as ExecutionAuthority,
            // Mid-turn steering: messages the user queued while this turn
            // runs are injected at tool boundaries / on stop. Stable
            // callback — reads and clears queuedMessagesRef atomically.
            consumeQueuedInputs: ownerMayDrainQueuedInputs(lease.owner) ? consumeQueuedInputs : undefined,
          },
          callbacks,
          activeLoopState,
        )
        loopStateRef.current = agentResult.state
        const injectedPeerKeys = new Set([...(submitOptions?.peerInboxKeys ?? []), ...consumedPeerInboxKeysRef.current])
        if (injectedPeerKeys.size > 0) options.peerService?.markAgentInputsInjected([...injectedPeerKeys])
        consumedPeerInboxKeysRef.current.clear()
        if (submitOptions?.toolFilter) {
          loopStateRef.current.systemPromptCache = null
          markExpectedCacheMiss(loopStateRef.current, 'tool-surface-change')
        }
        const finalGoal = agentResult.state.goal ? { ...agentResult.state.goal } : null

        // Finalize: drain whatever's left in the stream buffer into messages,
        // then clear the loading flag. As a safety net, if streaming produced
        // no text (e.g. the provider only emitted reasoning chunks before
        // the final text landed on `response.messages`), extract the last
        // assistant text from loopState so the user always sees a reply.
        flushBuffer()
        flushShellWaitUi()
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
          reconnectLabel: null,
          goalStatus: finalGoal,
          peerInfluenced: agentResult.state.contextSecurity.peerInfluenceActive,
          stepStats: loopStateRef.current?.stepStats.slice() ?? prev.stepStats,
        }))
        externalSignal?.removeEventListener('abort', abortFromExternal)
        if (controller.signal.aborted) {
          // NOW safe to push the interrupt notice into state.messages:
          // agentLoop has returned, meaning processToolCalls has fully
          // drained and all tool_results are in place. Pushing earlier
          // (inside abort()) would interleave a user message between the
          // assistant's tool_calls and their results, breaking providers.
          const noticeText = pendingAbortNoticeRef.current
          if (noticeText && loopStateRef.current) {
            loopStateRef.current.messages.push({ role: 'user', content: noticeText })
            await appendInterrupted(loopStateRef.current)
            await flushPendingMessages(loopStateRef.current)
          }
          pendingAbortNoticeRef.current = null

          // Esc path: anything queued after abort()'s own queue-restore
          // (user hit Esc and Enter nearly simultaneously) would strand a
          // "queued:" row with no spinner and no consumer. Fold it into
          // the restored draft too — zero-loss like abort() itself.
          restoreQueueToDraft()
        }
        return agentResult
      } catch (err) {
        const droppedPeerKeys = new Set([...(submitOptions?.peerInboxKeys ?? []), ...consumedPeerInboxKeysRef.current])
        if (droppedPeerKeys.size > 0) {
          options.peerService?.markAgentInputsDropped([...droppedPeerKeys], 'agent-turn-failed-before-commit')
        }
        consumedPeerInboxKeysRef.current.clear()
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
        if (wasAborted) {
          const noticeText = pendingAbortNoticeRef.current
          if (noticeText && loopStateRef.current) {
            loopStateRef.current.messages.push({ role: 'user', content: noticeText })
            await appendInterrupted(loopStateRef.current)
            await flushPendingMessages(loopStateRef.current)
          }
          pendingAbortNoticeRef.current = null
        }
        setState((prev) => ({
          ...prev,
          isLoading: false,
          activeToolCalls: [],
          bufferingReads: false,
          compressionLabel: null,
          reconnectLabel: null,
          error: wasAborted ? null : classifyApiError(err).message,
        }))
        return null
      } finally {
        activeForkBoundaryRef.current = null
        if (ownsLease) {
          lease.release()
          if (!submitOptions?.skipIdleDrain) {
            queueMicrotask(() => {
              if (turnCoordinatorRef.current.isOwned()) return
              const next = dequeueFreshInput()
              if (!next) return
              if (next.source === 'user') {
                void submitRef.current?.(next.content, { silent: true })
              } else {
                const peerAuthority = peerExecutionAuthority(next.peer, next.messageId)
                void submitRef.current?.(formatQueuedAgentInput(next), {
                  silent: true,
                  owner: 'peer',
                  authority: peerAuthority,
                  rawContent: true,
                  ...(next.inboxKey ? { peerInboxKeys: [next.inboxKey] } : {}),
                })
              }
            })
          }
        }
      }
    },
    [
      options,
      initialize,
      flushBuffer,
      appendMessage,
      handleTextDelta,
      handleStreamRetry,
      toolLifecycleCallbacks,
      consumeQueuedInputs,
      restoreQueueToDraft,
      currentAuthority,
      queueMessage,
      dequeueFreshInput,
      bindShellSessionEvents,
      flushShellWaitUi,
    ],
  )

  const submitRawPeerContent = useCallback(
    async (input: {
      content: string
      peer: PublicPeer
      messageId: string
      inboxKey?: string
    }): Promise<AgentLoopResult | null> => {
      const authority = peerExecutionAuthority(input.peer, input.messageId)
      const lease = turnCoordinatorRef.current.tryAcquire('peer', authority)
      if (!lease) {
        queuedMessagesRef.current = [
          ...queuedMessagesRef.current,
          {
            id: `queued-${queueSeqRef.current++}`,
            source: 'peer',
            display: input.content,
            content: input.content,
            peer: input.peer,
            messageId: input.messageId,
            ...(input.inboxKey ? { inboxKey: input.inboxKey } : {}),
          },
        ]
        return null
      }
      try {
        appendMessage({
          id: `peer-${input.messageId}`,
          role: 'user',
          content: input.content,
          timestamp: Date.now(),
          kind: 'peer-message',
          peer: input.peer,
        })
        return await submit(
          formatQueuedAgentInput({
            id: `peer-${input.messageId}`,
            source: 'peer',
            display: input.content,
            content: input.content,
            peer: input.peer,
            messageId: input.messageId,
            ...(input.inboxKey ? { inboxKey: input.inboxKey } : {}),
          }),
          {
            silent: true,
            owner: 'peer',
            lease,
            authority,
            rawContent: true,
            ...(input.inboxKey ? { peerInboxKeys: [input.inboxKey] } : {}),
          },
        )
      } finally {
        lease.release()
        queueMicrotask(() => {
          if (turnCoordinatorRef.current.isOwned()) return
          const next = dequeueFreshInput()
          if (!next) return
          if (next.source === 'user') {
            void submitRef.current?.(next.content, { silent: true })
          } else {
            const nextAuthority = peerExecutionAuthority(next.peer, next.messageId)
            void submitRef.current?.(formatQueuedAgentInput(next), {
              silent: true,
              owner: 'peer',
              authority: nextAuthority,
              rawContent: true,
              ...(next.inboxKey ? { peerInboxKeys: [next.inboxKey] } : {}),
            })
          }
        })
      }
    },
    [appendMessage, dequeueFreshInput, submit],
  )

  /** Synchronously reserve bounded source-aware queue capacity before a
   *  PeerInbox claim is committed. The returned boolean is the ownership
   *  handoff point used by the App adapter. */
  const enqueuePeerInput = useCallback(
    (input: { content: string; peer: PublicPeer; messageId: string; inboxKey: string }): boolean => {
      if (queuedMessagesRef.current.filter((entry) => entry.source === 'peer').length >= 50) return false
      void submitRawPeerContent(input)
      return true
    },
    [submitRawPeerContent],
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

  const resolveAuthority = useCallback(
    (allow: boolean, viewedComplete: boolean) => {
      const pending = pendingAuthorityRef.current
      pendingAuthorityRef.current = null
      setState((prev) => ({ ...prev, authorityRequest: null }))
      const owner = turnCoordinatorRef.current.current()?.owner
      if (owner && options.peerService) {
        const busyKind = owner === 'goal' ? 'goal' : 'interactive-turn'
        void options.peerService.updateLocalState({ status: 'busy', busyKind }).catch(() => {})
      }
      if (pending) {
        queueMicrotask(() =>
          pending.resolve(authorityApproval(pending.preview, allow ? 'allow-once' : 'deny', viewedComplete)),
        )
      }
    },
    [options.peerService],
  )

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

  const hasPendingPeerInput = useCallback((): boolean => {
    if (queuedMessagesRef.current.some((input) => input.source === 'peer')) return true
    const snapshot = options.peerService?.inbox.getSnapshot()
    return Boolean(snapshot && snapshot.accepted + snapshot.held > 0)
  }, [options.peerService])

  const clearPeerContext = useCallback(async (): Promise<{ ok: boolean; removed: number; reason?: string }> => {
    const ls = loopStateRef.current
    if (!ls?.contextSecurity.peerInfluenceActive) return { ok: true, removed: 0 }
    const lease = turnCoordinatorRef.current.tryAcquire('clear', currentAuthority())
    if (!lease) return { ok: false, removed: 0, reason: 'Another turn or maintenance operation is in progress.' }
    try {
      if (hasPendingPeerInput()) {
        return { ok: false, removed: 0, reason: 'Peer messages are still queued; process or reject them first.' }
      }
      const answer = await askQuestion(
        'Remove the peer-influenced conversation suffix and restore normal permission automation?',
        [
          { label: 'Remove suffix', description: 'Delete the peer message and every response derived from it.' },
          { label: 'Cancel', description: 'Keep the transcript and reduced authority unchanged.' },
        ],
        { noOther: true },
      )
      if (answer !== 'Remove suffix') return { ok: false, removed: 0, reason: 'Cancelled.' }
      if (hasPendingPeerInput()) {
        return { ok: false, removed: 0, reason: 'A peer message arrived while confirmation was open.' }
      }
      const removed = await clearCorePeerContext(ls)
      setState((prev) => ({
        ...prev,
        messages: modelMessagesToDisplay(ls.messages),
        activeToolCalls: [],
        permissionQueue: [],
        pendingQuestion: null,
        peerInfluenced: false,
      }))
      return { ok: true, removed }
    } catch (error) {
      return { ok: false, removed: 0, reason: errorMessage(error) }
    } finally {
      lease.release()
    }
  }, [askQuestion, currentAuthority, hasPendingPeerInput])

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
      onAskAuthority: (request) => {
        return new Promise<AuthorityApproval>((resolve) => {
          const pending: PendingAuthority = { ...request, resolve }
          pendingAuthorityRef.current = pending
          void options.peerService?.updateLocalState({ status: 'waiting' }).catch(() => {})
          setState((prev) => ({ ...prev, authorityRequest: pending }))
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
      onStreamRetry: handleStreamRetry,
      onError: (error) => setState((prev) => ({ ...prev, error: error.message })),
    }
  }, [
    appendMessage,
    appendTextDelta,
    goalToolLifecycleCallbacks,
    handleStreamRetry,
    options.mcpRegistry,
    options.peerService,
  ])

  const ensureLoopState = useCallback((): LoopState => {
    if (!loopStateRef.current) {
      loopStateRef.current = createLoopState(permissionModeRef.current, { projectCwd: process.cwd() })
      bindShellSessionEvents(loopStateRef.current)
    }
    return loopStateRef.current
  }, [bindShellSessionEvents])

  const prepareGoalSession = useCallback(async (ls: LoopState, firstPrompt: string) => {
    if (!ls.taskSlug) {
      ls.taskSlug = generateTaskSlug(firstPrompt)
    }
    await appendHeader(ls, modelIdRef.current, firstPrompt)
  }, [])

  const executeGoalLoop = useCallback(
    async (ls: LoopState, goalId: string, signal: AbortSignal, lease: TurnLease): Promise<void> => {
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
        goalId,
        signal,
        runAgentTurn: async (content, turnOptions) => {
          const result = await submit(content, {
            silent: true,
            toolFilter: turnOptions?.finalSummary ? { allow: [] } : undefined,
            maxTurns: turnOptions?.finalSummary ? 1 : undefined,
            signal,
            skipIdleDrain: true,
            owner: 'goal',
            lease,
            authority: lease.authority as ExecutionAuthority,
          })
          if (!result) throw new Error('Goal agent turn did not complete')
          return {
            ...result,
            text: extractLastAssistantText(result.state.messages),
          }
        },
      })
    },
    [createGoalCallbacks, options, submit],
  )

  const runGoal = useCallback(
    async (command: RunGoalCommand): Promise<void> => {
      const lease = turnCoordinatorRef.current.tryAcquire('goal', currentAuthority())
      if (!lease) return
      const ls = ensureLoopState()
      try {
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
            await executeGoalLoop(ls, goal.id, signal, lease)
          } finally {
            if (loopStateRef.current) {
              await appendGoalState(loopStateRef.current)
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
      } finally {
        lease.release()
      }
    },
    [currentAuthority, ensureLoopState, executeGoalLoop, prepareGoalSession],
  )

  const drainPendingInteractions = useCallback(() => {
    const permResolvers = permissionResolversRef.current
    permissionResolversRef.current = []
    for (const r of permResolvers) r('no')

    const pendingAuthority = pendingAuthorityRef.current
    pendingAuthorityRef.current = null
    if (pendingAuthority) pendingAuthority.resolve(authorityApproval(pendingAuthority.preview, 'deny', false))

    const pendingQuestion = pendingQuestionRef.current
    pendingQuestionRef.current = null
    setState((prev) => ({
      ...prev,
      permissionQueue: [],
      authorityRequest: null,
      pendingQuestion: null,
      bufferingReads: false,
    }))
    if (pendingQuestion) pendingQuestion.resolve(pendingQuestion.abortAnswer)
  }, [])

  const stopGoalRun = useCallback(
    async (ls: LoopState, goal: GoalState): Promise<void> => {
      abortControllerRef.current?.abort()
      drainPendingInteractions()
      await goalCoordinatorRef.current.interrupt(goal.id)
      await appendGoalState(ls)
      setState((prev) => ({ ...prev, goalStatus: { ...goal }, goalRunnerActive: false }))
    },
    [drainPendingInteractions],
  )

  const pauseGoal = useCallback(async (): Promise<GoalState | null> => {
    const ls = loopStateRef.current
    if (!ls?.goal) return null
    if (ls.goal.status !== 'active') return null
    const goal = pauseCoreGoal(ls)
    await stopGoalRun(ls, goal)
    return goal
  }, [stopGoalRun])

  const resumeGoal = useCallback(async (): Promise<GoalState | null> => {
    const ls = loopStateRef.current
    if (!ls?.goal) return null
    const lease = turnCoordinatorRef.current.tryAcquire('goal', currentAuthority())
    if (!lease) return null
    let goal: GoalState
    try {
      goal = ls.goal.status === 'active' ? ls.goal : resumeCoreGoal(ls)
    } catch {
      lease.release()
      return null
    }
    try {
      await appendGoalState(ls)
      setState((prev) => ({ ...prev, goalStatus: { ...goal }, goalRunnerActive: true }))
      goalCoordinatorRef.current.wake(goal.id, async (signal) => {
        try {
          await executeGoalLoop(ls, goal.id, signal, lease)
        } finally {
          lease.release()
          setState((prev) => ({
            ...prev,
            goalStatus: ls.goal ? { ...ls.goal } : null,
            goalRunnerActive: false,
          }))
        }
      })
      return goal
    } catch {
      lease.release()
      return null
    }
  }, [currentAuthority, executeGoalLoop])

  const cancelGoal = useCallback(async (): Promise<GoalState | null> => {
    const ls = loopStateRef.current
    if (!ls?.goal) return null
    const goal = cancelCoreGoal(ls)
    await stopGoalRun(ls, goal)
    return goal
  }, [stopGoalRun])

  const clearGoal = useCallback(async (): Promise<void> => {
    const ls = loopStateRef.current
    if (!ls) return
    const lease = turnCoordinatorRef.current.tryAcquire('clear', currentAuthority())
    if (!lease) return
    const goalId = ls.goal?.id
    try {
      if (goalId) {
        abortControllerRef.current?.abort()
        drainPendingInteractions()
        await goalCoordinatorRef.current.interrupt(goalId)
      }
      clearCoreGoal(ls)
      await appendGoalState(ls)
      setState((prev) => ({ ...prev, goalStatus: null, goalRunnerActive: false }))
    } finally {
      lease.release()
    }
  }, [currentAuthority, drainPendingInteractions])

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

  const editGoal = useCallback(
    async (input: { objective?: string; maxTurns?: number }): Promise<GoalState | null> => {
      const ls = loopStateRef.current
      if (!ls?.goal) return null
      const lease = turnCoordinatorRef.current.tryAcquire('goal', currentAuthority())
      if (!lease) return null
      try {
        if (input.objective !== undefined) {
          const objective = input.objective.trim()
          if (objective) ls.goal.objective = objective
        }
        if (input.maxTurns !== undefined && Number.isFinite(input.maxTurns) && input.maxTurns > 0) {
          ls.goal.maxTurns = Math.floor(input.maxTurns)
        }
        ls.goal.updatedAt = new Date().toISOString()
        ls.systemPromptCache = null
        markExpectedCacheMiss(ls, 'goal-change')
        await appendGoalState(ls)
        setState((prev) => ({ ...prev, goalStatus: ls.goal ? { ...ls.goal } : null }))
        return ls.goal
      } finally {
        lease.release()
      }
    },
    [currentAuthority],
  )

  const verifyGoal = useCallback(async (): Promise<{ goal: GoalState; ok: boolean; summary: string } | null> => {
    const ls = loopStateRef.current
    if (!ls?.goal) return null
    const lease = turnCoordinatorRef.current.tryAcquire('goal', currentAuthority())
    if (!lease) return null
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
          if (!verification.retryable) {
            updateGoalStatus(goal, 'blocked', verification.summary)
          } else {
            const input = admitGoalInput(ls, {
              goalId: goal.id,
              kind: 'verifier_failure',
              content: buildVerifierFailurePrompt(
                goal,
                verification.results,
                verification.summary,
                repeatedFailureCount,
              ),
            })
            await appendGoalInput(ls, input)
            await goalCoordinatorRef.current.run(goal.id, (signal) => executeGoalLoop(ls, goal.id, signal, lease))
          }
        }
      }

      await appendGoalState(ls)
      setState((prev) => ({ ...prev, goalStatus: { ...goal } }))
      return { goal, ok: verification.ok, summary: verification.summary }
    } finally {
      setState((prev) => ({ ...prev, goalVerificationActive: false }))
      lease.release()
    }
  }, [createGoalCallbacks, currentAuthority, executeGoalLoop, options])

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

    if (manualCompressionControllerRef.current === controller) {
      controller.abort()
      return
    }

    // Drain the stream buffer first — appendMessage runs synchronously via
    // setState so the partial assistant reply lands BEFORE the interrupt
    // notice in scrollback order.
    flushBuffer()
    flushShellWaitUi()

    const forToolUse = activeToolCallsLenRef.current > 0
    const noticeText = forToolUse ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]'

    appendMessage({
      id: `interrupt-${Date.now()}`,
      role: 'assistant',
      content: noticeText,
      timestamp: Date.now(),
      kind: 'command-result',
    })

    // Defer the state.messages mutation until agentLoop returns. Pushing
    // the user-role notice NOW would interleave it between assistant
    // tool_calls and their tool_results (processToolCalls is still running
    // and will push synthetic results after the abort signal fires). That
    // breaks the strict assistant→tool ordering providers require and causes
    // "Tool result is missing for tool call ..." on the next request.
    //
    // Store the notice text; submit()'s post-loop abort path will push it
    // and persist once processToolCalls has fully drained.
    pendingAbortNoticeRef.current = noticeText

    if (loopStateRef.current?.goal?.status === 'active') {
      try {
        pauseCoreGoal(loopStateRef.current)
        void goalCoordinatorRef.current.interrupt(loopStateRef.current.goal.id)
        setState((prev) => ({
          ...prev,
          goalStatus: loopStateRef.current?.goal ? { ...loopStateRef.current.goal } : null,
        }))
      } catch {
        // A non-active terminal goal does not need abort-time state changes.
      }
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
  }, [drainPendingInteractions, flushBuffer, flushShellWaitUi, appendMessage, restoreQueueToDraft])

  const cleanupShells = useCallback(
    async (
      reason: TerminationReason = 'cli-shutdown',
      budget?: TerminationBudget,
    ): Promise<TerminateAllResult | null> => {
      const manager = loopStateRef.current?.shellSessions
      return manager ? manager.dispose(reason, budget) : null
    },
    [],
  )

  const listShellSessions = useCallback((): ShellSessionSummary[] => {
    return loopStateRef.current?.shellSessions.list() ?? []
  }, [])

  const stopShellSessions = useCallback(async (shellId?: string): Promise<TerminateAllResult | null> => {
    const manager = loopStateRef.current?.shellSessions
    if (!manager) return null
    if (!shellId) return manager.terminateAll('stop-command')
    const result = await manager.terminate(shellId, 'stop-command')
    return {
      managerInstanceId: manager.managerInstanceId,
      reason: 'stop-command',
      requested: 1,
      confirmed: result.disposition === 'terminated' && result.terminationConfirmed ? 1 : 0,
      alreadyExited: result.disposition === 'already-exited' ? 1 : 0,
      results: [result],
    }
  }, [])

  /** Save session and cleanup */
  const cleanup = useCallback(async () => {
    const sessionSave = loopStateRef.current ? saveSession(loopStateRef.current, modelRef.current) : Promise.resolve()
    const memoryDrain = options.memoryService
      ? options.memoryService.shutdown(options.memoryService.getConfig().drainTimeoutMs)
      : Promise.resolve()
    const forkDrain = Promise.allSettled([...pendingForksRef.current])
    await Promise.all([sessionSave, memoryDrain, forkDrain])
  }, [options.memoryService])

  const reloadMemory = useCallback(async () => {
    await options.memoryService?.reload(loopStateRef.current ?? undefined)
  }, [options.memoryService])

  /** Synchronous snapshot of the live session for the post-exit hint
   *  printed by index.ts. Returns null when no LoopState exists yet
   *  (user launched but never submitted) — index.ts skips the hint in
   *  that case so we don't suggest resuming an empty file. */
  const getSessionInfo = useCallback(() => {
    const ls = loopStateRef.current
    if (!ls || ls.messages.length === 0) return null
    const firstUserMsg = ls.messages.find((m) => m.role === 'user')
    const firstPrompt = firstUserMsg ? extractText(firstUserMsg.content).slice(0, 80) : ''
    return {
      sessionId: ls.sessionId,
      taskSlug: ls.taskSlug,
      messageCount: ls.messages.length,
      firstPrompt,
      peerInfluenced: ls.contextSecurity.peerInfluenceActive || ls.contextSecurity.integrityFailure === true,
    }
  }, [])

  /** Persist an independent conversation branch without switching or
   *  interrupting the current session. The active boundary was fully detached
   *  before that request started, so later compaction and metadata updates in
   *  the original cannot move the branch point. */
  const fork = useCallback(async (name?: string) => {
    const boundary = activeForkBoundaryRef.current
    const activeOwner = turnCoordinatorRef.current.current()?.owner
    if (activeOwner && !boundary) {
      return {
        ok: false as const,
        reason: `Cannot fork while ${activeOwner} owns the active turn because no stable conversation boundary exists.`,
      }
    }
    if (boundary?.error) return { ok: false as const, reason: boundary.error }
    let snapshot = boundary?.snapshot ?? null
    if (!boundary && loopStateRef.current) {
      try {
        snapshot = captureSessionForkSnapshot(loopStateRef.current)
      } catch (error) {
        return { ok: false as const, reason: errorMessage(error) }
      }
    }
    if (!snapshot || snapshot.trackedMessages.length === 0) {
      return {
        ok: false as const,
        reason: boundary
          ? 'No completed conversation context exists before the active request.'
          : 'No active conversation to fork.',
      }
    }
    const operation = forkCoreSession(snapshot, modelIdRef.current, { name })
    pendingForksRef.current.add(operation)
    try {
      const result = await operation
      return { ok: true as const, ...result, excludedActiveTurn: boundary !== null }
    } catch (error) {
      return { ok: false as const, reason: errorMessage(error) }
    } finally {
      pendingForksRef.current.delete(operation)
    }
  }, [])

  /** Shared prologue for /clear and /resume: acquire the turn lease, refuse
   *  while peer input awaits review, and tear down the old session's shells. */
  const beginSessionTransition = useCallback(
    async (operation: 'clear' | 'resume') => {
      const lease = turnCoordinatorRef.current.tryAcquire(operation, currentAuthority())
      if (!lease) return { ok: false as const, reason: 'another turn is active' }
      if (hasPendingPeerInput()) {
        lease.release()
        return { ok: false as const, reason: 'peer input is waiting for review' }
      }
      const previous = loopStateRef.current
      if (previous) {
        const disposed = await disposeShellSessionsForTransition(previous.shellSessions, operation)
        if (!disposed.ok) {
          lease.release()
          return { ok: false as const, reason: disposed.reason, result: disposed.result }
        }
      }
      return { ok: true as const, lease, previous }
    },
    [currentAuthority, hasPendingPeerInput],
  )

  /** Clear conversation while retaining a display-only command echo. */
  const clear = useCallback(
    async (commandText = '/clear') => {
      const transition = await beginSessionTransition('clear')
      if (!transition.ok) return transition
      const { lease, previous } = transition
      const nextState = createLoopState(permissionModeRef.current, {
        projectCwd: previous?.projectCwd ?? process.cwd(),
      })
      loopStateRef.current = nextState
      bindShellSessionEvents(nextState)
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
      lease.release()
      return { ok: true as const }
    },
    [beginSessionTransition, bindShellSessionEvents, resetBuffer],
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
    async (loaded: LoadedSession) => {
      const transition = await beginSessionTransition('resume')
      if (!transition.ok) return transition
      const { lease, previous } = transition
      pendingToolsRef.current.clear()
      queuedMessagesRef.current = []
      resetBuffer()
      loopStateRef.current = hydrateLoopState(loaded, permissionModeRef.current, previous?.projectCwd ?? process.cwd())
      bindShellSessionEvents(loopStateRef.current)
      const converted = modelMessagesToDisplay(loaded.messages)
      setState((prev) => ({
        ...prev,
        activeToolCalls: [],
        shellOutput: '',
        error: null,
        reconnectLabel: null,
        todos: [],
        // queuedMessagesRef was cleared above — keep the state mirror in
        // sync or stale pending rows keep rendering until the next queue
        // mutation overwrites them.
        queuedMessages: [],
        restoredDraft: null,
        messages: [...prev.messages, ...converted],
        usage: { ...loaded.tokenUsage },
        usageBreakdown: loaded.usageBreakdown ? cloneUsageBreakdown(loaded.usageBreakdown) : createUsageBreakdown(),
        cacheMissSummary: cloneCacheMissSummary(loaded.cacheMissSummary ?? scanCacheMisses(loaded.providerTurns ?? [])),
        stepStats: loaded.stepStats.slice(),
        goalStatus: loaded.goal ? { ...loaded.goal } : null,
        peerInfluenced: loaded.contextSecurity.peerInfluenceActive,
      }))
      lease.release()
      return { ok: true as const }
    },
    [beginSessionTransition, bindShellSessionEvents, resetBuffer],
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
      const lease = turnCoordinatorRef.current.tryAcquire('rewind', currentAuthority())
      if (!lease) {
        return { ok: false, reason: 'A turn is in progress. Press Esc to cancel it, then run /rewind.' }
      }
      try {
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
          const candidate = ls.trackedMessages.slice(0, newLen)

          const survivingCheckpoints = ls.checkpoints.filter(
            (checkpoint) => checkpoint.messageCount <= candidate.length,
          )
          await markBoundaryAndReflush(ls, undefined, candidate)
          ls.checkpoints = survivingCheckpoints
          for (const checkpoint of survivingCheckpoints) await appendCheckpoint(ls, checkpoint)

          pendingToolsRef.current.clear()
          resetBuffer()
          const converted = modelMessagesToDisplay(ls.messages)
          setState((prev) => ({
            ...prev,
            activeToolCalls: [],
            shellOutput: '',
            error: null,
            reconnectLabel: null,
            todos: [],
            messages: converted,
          }))
        }

        return { ok: true, preview: target.userPrompt, messageCount: target.messageCount - 1 }
      } finally {
        lease.release()
      }
    },
    [currentAuthority, resetBuffer],
  )

  /** Manual context compression */
  const compact = useCallback(async () => {
    const ls = loopStateRef.current
    if (!ls) return { status: 'nothing' as const, reason: 'no-conversation' as const }
    const lease = turnCoordinatorRef.current.tryAcquire('compact', currentAuthority())
    if (!lease) return { status: 'failed' as const, message: 'Another turn or maintenance operation is in progress.' }
    let compressionApi: typeof import('@x-code-cli/core')
    try {
      compressionApi = await import('@x-code-cli/core')
    } catch (error) {
      lease.release()
      throw error
    }
    const { estimateTokenCount, KEEP_RECENT, KEEP_RECENT_TOKENS } = compressionApi

    const before = estimateTokenCount(ls.messages)
    if (ls.messages.length <= KEEP_RECENT) {
      lease.release()
      return {
        status: 'nothing' as const,
        reason: 'too-few-messages' as const,
        estimatedTokens: before,
        messageCount: ls.messages.length,
        minimumMessages: KEEP_RECENT + 1,
      }
    }
    const controller = new AbortController()
    abortControllerRef.current = controller
    manualCompressionControllerRef.current = controller
    setState((prev) => ({
      ...prev,
      isLoading: true,
      compressionLabel: 'Summarizing conversation',
      reconnectLabel: null,
      error: null,
    }))
    debugLog('compression.manual.start', `messages=${ls.messages.length} tokens=${before}`)

    try {
      // Extract previous summary for incremental update + file tracking
      const firstMsg = ls.messages[0]
      const prefix = '[Previous conversation summary]\n'
      const previousSummary =
        firstMsg?.role === 'user' && typeof firstMsg.content === 'string' && firstMsg.content.startsWith(prefix)
          ? firstMsg.content.slice(prefix.length)
          : undefined
      const modified = [...ls.filesModified]
      const read = [...ls.readFileCache.keys()].filter((p) => !ls.filesModified.has(p))
      const filesTracked = { modified, read }

      const originalTrackedMessages = ls.trackedMessages
      const compressed = await compressTrackedMessagesWithUsage(
        originalTrackedMessages,
        modelRef.current,
        previousSummary,
        filesTracked,
        controller.signal,
      )
      if (controller.signal.aborted) {
        debugLog('compression.manual.cancelled', `tokens=${before}`)
        return { status: 'cancelled' as const }
      }
      if (
        compressed.trackedMessages.length === originalTrackedMessages.length &&
        compressed.trackedMessages.every((entry, index) => entry.entryId === originalTrackedMessages[index]?.entryId)
      ) {
        debugLog('compression.manual.skipped', `messages=${ls.messages.length} tokens=${before}`)
        return {
          status: 'nothing' as const,
          reason: 'within-retention-window' as const,
          estimatedTokens: before,
          retentionTokens: KEEP_RECENT_TOKENS,
        }
      }
      await markBoundaryAndReflush(ls, compressed.summary, compressed.trackedMessages)
      if (compressed.usage) {
        const usageModelId = attributedModelId(modelIdRef.current, compressed.modelId)
        accumulateUsage(ls, {
          source: 'compaction',
          modelId: usageModelId,
          usage: normalizeLanguageModelUsage(compressed.usage),
        })
        setState((prev) => ({
          ...prev,
          usage: { ...ls.tokenUsage },
          usageBreakdown: cloneUsageBreakdown(ls.usageBreakdown),
        }))
        await appendUsage(ls, usageModelId)
      }
      // Messages changed — mirror the auto-compression paths: reset the
      // cache-hit signal so the next turn doesn't wrongly assume a prefix
      // match, and reset lastInputTokens so checkAndCompressContext won't
      // re-trigger on a stale high value. Also write a compact-boundary
      // to the jsonl so the loader can pick up the post-compaction state.
      ls.lastInputTokens = 0
      markExpectedCacheMiss(ls, 'compaction')
      const after = estimateTokenCount(ls.messages)
      // Include the system prompt overhead so the reported numbers match
      // the footer's "N / M · X%" indicator (which shows the full context
      // the API actually received, not just the message body).
      const sysCost = ls.systemPromptCache ? Math.ceil(Buffer.byteLength(ls.systemPromptCache, 'utf8') / 3) : 0
      debugLog('compression.manual.complete', `before=${before} after=${after} sysCost=${sysCost}`)
      return {
        status: 'compressed' as const,
        estimatedTokensBefore: before + sysCost,
        estimatedTokensAfter: after + sysCost,
      }
    } catch (err) {
      if (controller.signal.aborted) {
        debugLog('compression.manual.cancelled', `tokens=${before}`)
        return { status: 'cancelled' as const }
      }
      const message = classifyApiError(err).message
      debugLog('compression.manual.error', message)
      return { status: 'failed' as const, message }
    } finally {
      if (abortControllerRef.current === controller) abortControllerRef.current = null
      if (manualCompressionControllerRef.current === controller) manualCompressionControllerRef.current = null
      setState((prev) => ({ ...prev, isLoading: false, compressionLabel: null, reconnectLabel: null }))
      // Plain text submitted while the spinner was visible enters the
      // mid-turn queue. `/compact` has no agent loop to consume it, so put it
      // back in the editable input instead of leaving a stranded queue row.
      restoreQueueToDraft()
      lease.release()
    }
  }, [currentAuthority, restoreQueueToDraft])

  /** Switch model at runtime */
  const switchModel = useCallback(
    (newModelId: string, newModel: LanguageModel) => {
      modelRef.current = newModel
      modelIdRef.current = newModelId
      invalidateModelDependentState(loopStateRef.current)
      options.memoryService?.setActiveModelId(newModelId)
      setState((prev) => ({ ...prev, modelId: newModelId }))
    },
    [options.memoryService],
  )

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
    invalidateToolSurfaceState(loopStateRef.current)
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
      markExpectedCacheMiss(loopStateRef.current, 'permission-mode-change')
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

  /** Estimate the per-category token split of the current context (system
   *  prompt / tools / rules / skills / MCP / subagents / summary /
   *  conversation), mirroring what the next request would actually send.
   *  Returns null before the first turn builds the system prompt. Used by
   *  /usage to show a Cursor-style context composition — raw estimates;
   *  calibration against the real reported input count happens at render. */
  const getContextBreakdown = useCallback((): ContextBreakdown | null => {
    const ls = loopStateRef.current
    if (!ls) return null
    const input = buildContextBreakdownInput(options, ls)
    return input ? estimateContextBreakdown(input) : null
  }, [options])

  const activeTurnOwner = useCallback(() => turnCoordinatorRef.current.current()?.owner ?? null, [])
  const hasActiveForkBoundary = useCallback(() => activeForkBoundaryRef.current !== null, [])

  const addPeerStatus = useCallback(
    (content: string, peer?: PublicPeer) => {
      appendMessage({
        id: `peer-status-${Date.now()}-${queueSeqRef.current++}`,
        role: 'assistant',
        content,
        timestamp: Date.now(),
        kind: 'peer-status',
        ...(peer ? { peer } : {}),
      })
    },
    [appendMessage],
  )

  const addHeldPeerPreview = useCallback(
    (content: string, peer: PublicPeer, summary?: string) => {
      appendMessage({
        id: `peer-held-${Date.now()}-${queueSeqRef.current++}`,
        role: 'assistant',
        content,
        timestamp: Date.now(),
        kind: 'peer-message',
        peer: { ...peer, ...(summary ? { summary } : {}) },
      })
    },
    [appendMessage],
  )

  const { addInfoMessage, addUserMessage, echoCommand, addCommandMessage, addCommandResult } =
    useAgentDisplayHelpers(appendMessage)

  return {
    state,
    activeTurnOwner,
    hasActiveForkBoundary,
    submit,
    submitRawPeerContent,
    enqueuePeerInput,
    addPeerStatus,
    addHeldPeerPreview,
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
    resolveAuthority,
    resolveQuestion,
    abort,
    cleanup,
    cleanupShells,
    listShellSessions,
    stopShellSessions,
    fork,
    clear,
    clearPeerContext,
    compact,
    resume,
    rewind,
    getCheckpoints,
    getDiffStats,
    getContextBreakdown,
    getSessionInfo,
    switchModel,
    setThinking,
    getThinking,
    reloadMemory,
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
