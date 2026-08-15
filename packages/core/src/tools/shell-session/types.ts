import type { ToolHookSnapshot } from '../../hooks/bus.js'
import type { ExecutionAuthority } from '../../types/index.js'

export type ShellFailureCode =
  | 'invalid-cwd'
  | 'spawn-failed'
  | 'stdin-unavailable'
  | 'termination-failed'
  | 'termination-unconfirmed'
  | 'manager-disposed'
  | 'unknown-shell-id'

export interface ShellFailure {
  code: ShellFailureCode
  message: string
}

export type TerminationReason =
  | 'kill-tool'
  | 'stop-command'
  | 'hard-timeout'
  | 'clear'
  | 'resume'
  | 'subagent-finished'
  | 'cli-shutdown'
  | 'print-exit'
  | 'manager-dispose'
  | 'spawn-failure-cleanup'
  | 'double-sigint'
  | 'sighup'
  | 'fatal-exit'
  | 'root-exited-residual'

export interface TerminationBudget {
  gracefulMs: number
  forceMs: number
  confirmMs: number
}

export interface ProcessTerminationResult {
  gracefulAttempted: boolean
  forceAttempted: boolean
  rootExited: boolean
  treeConfirmedExited: boolean
  exitCode?: number
  signal?: string
  failure?: ShellFailure
}

export interface ShellTerminationResult {
  managerInstanceId: string
  shellId: string
  reason: TerminationReason
  disposition: 'terminated' | 'already-exited' | 'failed' | 'still-running'
  gracefulAttempted: boolean
  forceAttempted: boolean
  rootExited: boolean
  treeConfirmedExited: boolean
  terminationConfirmed: boolean
  exitCode?: number
  signal?: string
  failure?: ShellFailure
  output: string
}

export interface TerminateAllResult {
  managerInstanceId: string
  reason: TerminationReason
  requested: number
  confirmed: number
  alreadyExited: number
  results: ShellTerminationResult[]
}

export interface EmergencyTerminationResult {
  reason: TerminationReason
  requested: number
  results: Array<{
    managerInstanceId: string
    shellId: string
    disposition: 'already-exited' | 'force-sent-unconfirmed' | 'deadline-exhausted' | 'failed'
    failure?: ShellFailure
  }>
}

export interface ShellHookOrigin {
  toolCallId: string
  toolName: 'shell'
  effectiveArgs: Record<string, unknown>
  effectiveCwd: string
  modelId: string
  authority: ExecutionAuthority
  authorityApprovedOnce: boolean
  preToolUse: 'executed' | 'skipped-peer-tainted' | 'not-configured'
  hookRegistryGeneration: number
  hookSnapshot: ToolHookSnapshot
}

export interface PreparedShellRequest {
  command: string
  requestedCwd?: string
  effectiveCwd: string
  projectCwd: string
  initialWait: InitialWaitPolicy
  hardTimeoutMs?: number
  tty: boolean
  maxOutputBytes: number
  hookInput: Record<string, unknown>
}

export interface StartShellRequest {
  prepared: PreparedShellRequest
  originToolCallId: string
  hookOrigin: ShellHookOrigin
  turnAbortSignal?: AbortSignal
}

export interface InteractShellRequest {
  shellId: string
  toolCallId: string
  chars: string
  resize?: { cols: number; rows: number }
  wait: WaitPolicy
  maxOutputBytes: number
  turnAbortSignal?: AbortSignal
}

export interface ShellExecutionResult {
  chunkId: string
  wallTimeMs: number
  output: string
  isError: boolean
  originalBytes: number
  omittedBytes: number
  shellId?: string
  exitCode?: number
  signal?: string
  running: boolean
  rootExited: boolean
  treeConfirmedExited: boolean
  cleanupResidual: boolean
  lifecycle: 'running' | 'manager-draining' | 'root-exited' | 'termination-failed' | 'exited' | 'spawn-failed'
  timedOut: boolean
  waitInterrupted: boolean
  managerDraining: boolean
  failure?: ShellFailure
  terminationReason?: TerminationReason
  terminationConfirmed?: boolean
}

export interface FinalObservationLease {
  readonly claimId: string
  readonly observerToolCallId: string
  readonly origin: ShellHookOrigin
  readonly post: { output: string; isError: boolean }
  ack(): void
  release(): void
}

export type ShellObservation =
  | { kind: 'running'; result: ShellExecutionResult }
  | { kind: 'terminal'; result: ShellExecutionResult; lease: FinalObservationLease }

export interface TerminateAndObserveRequest {
  shellId: string
  observerToolCallId: string
  reason: 'kill-tool'
  budget?: TerminationBudget
  turnAbortSignal?: AbortSignal
}

export type ShellSessionStatus =
  | 'starting'
  | 'running'
  | 'root-exited'
  | 'terminating'
  | 'termination-failed'
  | 'finalizing'
  | 'exited'
  | 'failed'

export interface ShellSessionSummary {
  managerInstanceId: string
  ownerSessionId: string
  shellId: string
  originToolCallId: string
  command: string
  requestedCwd?: string
  effectiveCwd: string
  tty: boolean
  status: ShellSessionStatus
  yielded: boolean
  spawnOutcome: 'pending' | 'ready' | 'failed'
  cleanupResidual: boolean
  spawnRequestedAt: number
  startedAt?: number
  rootExited: boolean
  treeConfirmedExited: boolean
  outputFinalized: boolean
  rootExitedAt?: number
  treeConfirmedAt?: number
  exitedAt?: number
  exitCode?: number
  signal?: string
  failure?: ShellFailure
  timedOut: boolean
  terminationReason?: TerminationReason
  terminationConfirmed?: boolean
  exitedSeq?: number
  recentOutput: string
  omittedBytes: number
  uiOmittedBytes: number
}

export interface ShellSessionEventBase {
  seq: number
  ownerSessionId: string
  managerInstanceId: string
  occurredAt: number
}

export type ShellSessionEvent = ShellSessionEventBase &
  (
    | { kind: 'snapshot'; sessions: ShellSessionSummary[] }
    | {
        kind: 'started'
        shellId: string
        originToolCallId: string
        command: string
        requestedCwd?: string
        effectiveCwd: string
        tty: boolean
        startedAt: number
      }
    | {
        kind: 'residual-registered'
        shellId: string
        originToolCallId: string
        command: string
        effectiveCwd: string
        failure: ShellFailure
      }
    | {
        kind: 'yielded'
        shellId: string
        yieldAfterMs: number
        reason: 'explicit-background' | 'deadline' | 'turn-abort' | 'manager-draining' | 'termination-failed'
      }
    | {
        kind: 'output'
        shellId: string
        stream: 'stdout' | 'stderr'
        chunk: string
        truncated?: boolean
        omittedBytesBefore?: number
      }
    | { kind: 'root-exited'; shellId: string; exitCode?: number; signal?: string; treeConfirmedExited: false }
    | {
        kind: 'wait-started'
        shellId: string
        toolCallId: string
        chars: string
        cols?: number
        rows?: number
      }
    | {
        kind: 'wait-finished'
        shellId: string
        toolCallId: string
        chars: string
        cols?: number
        rows?: number
        running: boolean
      }
    | {
        kind: 'termination-failed'
        shellId: string
        reason: TerminationReason
        attempt: number
        failure: ShellFailure
        stillRunning: true
      }
    | {
        kind: 'exited'
        shellId: string
        exitCode?: number
        signal?: string
        failure?: ShellFailure
        durationMs: number
        wasYielded: boolean
        timedOut: boolean
        terminationReason?: TerminationReason
        terminationConfirmed: true
        spawnOutcome: 'ready' | 'failed'
        cleanupResidual: boolean
        rootExited: boolean
        treeConfirmedExited: true
        recentOutput: string
        uiOmittedBytes: number
      }
  )

export type ShellSessionListener = (event: ShellSessionEvent) => void

export interface ShellSessionEventSource {
  readonly managerInstanceId: string
  subscribe(listener: ShellSessionListener, options?: { replayCurrent?: boolean }): () => void
}

export interface ShellSessionController extends ShellSessionEventSource {
  start(request: StartShellRequest): Promise<ShellObservation>
  interact(request: InteractShellRequest): Promise<ShellObservation>
  terminate(shellId: string, reason: TerminationReason, budget?: TerminationBudget): Promise<ShellTerminationResult>
  terminateAndObserve(request: TerminateAndObserveRequest): Promise<ShellObservation>
  list(): ShellSessionSummary[]
  terminateAll(reason: TerminationReason, budget?: TerminationBudget): Promise<TerminateAllResult>
  dispose(reason: TerminationReason, budget?: TerminationBudget): Promise<TerminateAllResult>
}

export type ShellEventPayload = ShellSessionEvent extends infer Event
  ? Event extends ShellSessionEvent
    ? Omit<Event, keyof ShellSessionEventBase>
    : never
  : never

export const DEFAULT_TERMINATION_BUDGET: TerminationBudget = {
  gracefulMs: 1_000,
  forceMs: 1_000,
  confirmMs: 250,
}

export type WaitPolicy = { kind: 'immediate' } | { kind: 'timed'; ms: number }
export type InitialWaitPolicy = WaitPolicy
