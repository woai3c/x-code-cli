import type {
  AgentLoopResult,
  AgentOptions,
  AuthorityApproval,
  AuthorityApprovalPreview,
  CacheMissSummary,
  DisplayMessage,
  ExecutionAuthority,
  GoalState,
  GoalVerifier,
  PermissionMode,
  StepStats,
  TodoItem,
  TokenUsage,
  UsageBreakdown,
} from '@x-code-cli/core'

import type { BackgroundTerminalView, ShellWaitStreak } from './shell-session-ui.js'
import type { TurnLease, TurnOwner } from './turn-coordinator.js'

export interface SubmitOptions {
  silent?: boolean
  toolFilter?: AgentOptions['toolFilter']
  maxTurns?: number
  signal?: AbortSignal
  /** Goal execution owns its submit sequence, so idle draining here would race the next goal turn. */
  skipIdleDrain?: boolean
  owner?: TurnOwner
  lease?: TurnLease
  authority?: ExecutionAuthority
  rawContent?: boolean
  peerInboxKeys?: readonly string[]
}

export type SubmitAgentInput = (text: string, options?: SubmitOptions) => Promise<AgentLoopResult | null>

export interface PendingPermission {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  /** Resolved MCP identity used by the permission dialog instead of the mangled tool name. */
  mcp?: { serverName: string; rawName: string }
}

export interface PendingAuthority {
  requestId: number
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  preview: AuthorityApprovalPreview
  resolve: (approval: AuthorityApproval) => void
}

export interface PendingQuestion {
  question: string
  options: { label: string; description: string; freeform?: boolean; preview?: string[] }[]
  resolve: (answer: string) => void
  /** Value supplied when the active turn is aborted so the agent loop can unblock. */
  abortAnswer: string
  /** User-opened pickers may be dismissed; model questions must receive an explicit answer. */
  dismissible?: boolean
  layout?: 'compact' | 'compact-vertical'
}

/** An in-flight tool call rendered in the live UI area. */
export interface ActiveToolCall {
  id: string
  toolName: string
  input: Record<string, unknown>
  progress?: string
  subToolHistory?: string[]
}

/** A user message queued while an agent turn is in flight. */
export interface QueuedMessage {
  id: string
  /** Text rendered in the pending list and committed to scrollback. */
  text: string
  /** Optional content sent to the model when it differs from the display text. */
  inject?: string
}

export interface AgentState {
  messages: DisplayMessage[]
  isLoading: boolean
  activeToolCalls: ActiveToolCall[]
  shellOutput: string
  permissionQueue: PendingPermission[]
  authorityRequest?: PendingAuthority | null
  pendingQuestion: PendingQuestion | null
  /** Inputs waiting for the next tool boundary or idle drain. */
  queuedMessages: QueuedMessage[]
  /** One-shot request to restore queued text to the input after an aborted turn. */
  restoredDraft: { text: string; nonce: number } | null
  usage: TokenUsage
  usageBreakdown: UsageBreakdown
  cacheMissSummary: CacheMissSummary
  error: string | null
  /** Live model identifier, mirrored from the agent ref for UI updates. */
  modelId: string
  /** Live approval mode for the current session. */
  permissionMode: PermissionMode
  /** Live checklist maintained by the model. */
  todos: TodoItem[]
  /** Keeps the reading status stable across consecutive read-only tool calls. */
  bufferingReads: boolean
  /** Current context-compression phase, when compression is active. */
  compressionLabel: string | null
  /** Current local attachment-processing phase, including model download progress. */
  ingestLabel: string | null
  /** Transient provider stream recovery status. */
  reconnectLabel: string | null
  goalStatus: GoalState | null
  goalRunnerActive: boolean
  goalVerificationActive: boolean
  /** Per-step usage snapshots recorded after each agent-loop invocation. */
  stepStats: StepStats[]
  /** Persistent transcript-derived security indicator. */
  peerInfluenced?: boolean
  /** Display-only state projected from the active shell event hub. */
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
