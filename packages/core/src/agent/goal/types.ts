import type { TokenUsage } from '../../types/index.js'

export type GoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'complete'
  | 'cancelled'
  | 'budget_limited'
  | 'usage_limited'
  | 'max_turns'
  | 'failed'

export type GoalInputKind = 'initial' | 'continuation' | 'user_steering' | 'verifier_failure' | 'final_summary'

export type GoalTransitionKind = 'complete_requested' | 'blocked_requested'

export interface GoalVerifierShell {
  kind: 'shell'
  command: string
  timeoutMs?: number
}

export interface GoalVerifierSubAgent {
  kind: 'subagent'
  agent: string
  prompt: string
  timeoutMs?: number
}

export interface GoalVerifierFile {
  kind: 'file'
  path: string
  exists?: boolean
  contains?: string
}

export type GoalVerifier = GoalVerifierShell | GoalVerifierSubAgent | GoalVerifierFile

export interface GoalVerificationResult {
  verifier: GoalVerifier
  ok: boolean
  retryable?: boolean
  summary: string
  exitCode?: number | null
  stdout?: string
  stderr?: string
  findings?: string[]
  requiredFixes?: string[]
  durationMs: number
  ts: string
  verificationRunId?: string
}

export interface GoalAttempt {
  id: string
  turn: number
  inputKind: GoalInputKind
  promptPreview: string
  startedAt: string
  endedAt?: string
  turnCount: number
  tokenUsageBefore: TokenUsage
  tokenUsageAfter?: TokenUsage
  finish: 'stop' | 'aborted' | 'error' | 'max_turns' | 'budget_limited' | 'verification_failed' | 'complete' | 'blocked'
}

export interface GoalPendingTransition {
  kind: GoalTransitionKind
  evidence: string
  summary?: string
  blocker?: string
  requestedAt: string
  requestedByToolCallId?: string
}

export interface GoalState {
  id: string
  objective: string
  status: GoalStatus
  createdAt: string
  updatedAt: string
  createdBy: 'slash' | 'tool' | 'resume'
  maxTurns?: number
  turnCount: number
  tokenBudget?: number
  baselineTokens: number
  verifiers: GoalVerifier[]
  verificationResults: GoalVerificationResult[]
  pendingTransition?: GoalPendingTransition
  lastBlocker?: string
  repeatedBlockerCount: number
  lastVerificationFailureFingerprint?: string
  repeatedVerificationFailureCount: number
  attempts: GoalAttempt[]
  finalSummary?: string
  requiresUserConfirmation?: boolean
}

export interface GoalInput {
  id: string
  goalId: string
  kind: GoalInputKind
  content: string
  admittedAt: string
  promotedAt?: string
}

export interface GoalRunSummary {
  goalId: string
  status: GoalStatus
  turns: number
  summary?: string
}
