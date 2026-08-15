import { randomUUID } from 'node:crypto'

import { stripTerminalControls } from '../../peers/terminal-sanitize.js'
import { debugLog } from '../../utils.js'
import { ShellSessionEventHub } from './event-hub.js'
import type { ShellOutputSnapshot } from './output-buffer.js'
import type { ManagedProcessFrame, ManagedShellProvider, ManagedSpawnAttempt } from './provider.js'
import { type ShellSession, createDeferred, createShellSession, isCompositeTerminal } from './session.js'
import { registerManagedShellTarget, unregisterManagedShellTarget } from './shutdown-target-registry.js'
import type {
  FinalObservationLease,
  InteractShellRequest,
  ProcessTerminationResult,
  ShellEventPayload,
  ShellExecutionResult,
  ShellFailure,
  ShellFailureCode,
  ShellObservation,
  ShellSessionController,
  ShellSessionEvent,
  ShellSessionListener,
  ShellSessionSummary,
  ShellTerminationResult,
  StartShellRequest,
  TerminateAllResult,
  TerminateAndObserveRequest,
  TerminationBudget,
  TerminationReason,
  WaitPolicy,
} from './types.js'
import { DEFAULT_TERMINATION_BUDGET } from './types.js'

const MAX_ACTIVE_SESSIONS = 64
const COMPLETED_RETENTION_MS = 5 * 60 * 1000
const MAX_RECENT_OUTPUT_BYTES = 16 * 1024
const TRAILING_OUTPUT_GRACE_MS = 75

const issuedManagerIds = new Set<string>()

export interface UnifiedShellSessionManagerOptions {
  ownerSessionId: string
  projectCwd: string
  provider: ManagedShellProvider
  managerInstanceId?: string
  idFactory?: () => string
  now?: () => number
  monotonicNow?: () => number
  maxActiveSessions?: number
  completedRetentionMs?: number
  trailingOutputGraceMs?: number
}

interface WakeHandle {
  promise: Promise<void>
  dispose(): void
}

interface ObservationContext {
  source: 'initial' | 'transport'
  toolCallId: string
  policy: WaitPolicy
  chars: string
  resize?: { cols: number; rows: number }
  maxOutputBytes: number
  turnAbortSignal?: AbortSignal
}

class ShellSessionManagerError extends Error {
  constructor(
    readonly code: ShellFailureCode,
    message: string,
  ) {
    super(message)
    this.name = 'ShellSessionManagerError'
  }
}

function createManagerInstanceId(idFactory: () => string): string {
  for (let attempt = 0; attempt < 16; attempt++) {
    const id = idFactory().replaceAll('-', '').toLowerCase()
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('manager id factory must return a UUID')
    if (issuedManagerIds.has(id)) continue
    issuedManagerIds.add(id)
    return id
  }
  throw new Error('Unable to allocate a unique shell manager instance id')
}

function abortWake(signal: AbortSignal | undefined): WakeHandle {
  if (!signal) return { promise: new Promise<void>(() => {}), dispose() {} }
  if (signal.aborted) return { promise: Promise.resolve(), dispose() {} }
  let listener!: () => void
  const promise = new Promise<void>((resolve) => {
    listener = resolve
    signal.addEventListener('abort', listener, { once: true })
  })
  return { promise, dispose: () => signal.removeEventListener('abort', listener) }
}

function deadlineWake(policy: WaitPolicy): WakeHandle {
  if (policy.kind === 'immediate') return { promise: Promise.resolve(), dispose() {} }
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, policy.ms)
  })
  return {
    promise,
    dispose() {
      if (timer) clearTimeout(timer)
    },
  }
}

function utf8Tail(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.length <= maxBytes) return value
  let start = buffer.length - maxBytes
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++
  return buffer.subarray(start).toString('utf8')
}

function mergeSnapshots(left: ShellOutputSnapshot, right: ShellOutputSnapshot): ShellOutputSnapshot {
  return {
    output: [left.output, right.output].filter(Boolean).join(''),
    originalBytes: left.originalBytes + right.originalBytes,
    omittedBytes: left.omittedBytes + right.omittedBytes,
  }
}

function terminationDisposition(result: ProcessTerminationResult): ShellTerminationResult['disposition'] {
  if (result.treeConfirmedExited) return 'terminated'
  return result.failure ? 'failed' : 'still-running'
}

export class UnifiedShellSessionManager implements ShellSessionController {
  readonly managerInstanceId: string
  readonly ownerSessionId: string
  readonly projectCwd: string

  private readonly sessions = new Map<string, ShellSession>()
  private readonly adoptedManagers = new Map<string, { controller: ShellSessionController; unsubscribe: () => void }>()
  private readonly adoptedShellOwners = new Map<string, string>()
  private readonly eventHub: ShellSessionEventHub
  private readonly now: () => number
  private readonly monotonicNow: () => number
  private readonly maxActiveSessions: number
  private readonly completedRetentionMs: number
  private readonly trailingOutputGraceMs: number
  private shellCounter = 0
  private chunkCounter = 0
  private claimCounter = 0
  private acceptingStarts = true
  private closed = false
  private disposeFlight?: Promise<TerminateAllResult>

  constructor(private readonly options: UnifiedShellSessionManagerOptions) {
    this.ownerSessionId = options.ownerSessionId
    this.projectCwd = options.projectCwd
    this.now = options.now ?? Date.now
    this.monotonicNow = options.monotonicNow ?? performance.now.bind(performance)
    this.maxActiveSessions = options.maxActiveSessions ?? MAX_ACTIVE_SESSIONS
    this.completedRetentionMs = options.completedRetentionMs ?? COMPLETED_RETENTION_MS
    this.trailingOutputGraceMs = options.trailingOutputGraceMs ?? TRAILING_OUTPUT_GRACE_MS
    this.managerInstanceId = options.managerInstanceId
      ? options.managerInstanceId.replaceAll('-', '').toLowerCase()
      : createManagerInstanceId(options.idFactory ?? randomUUID)
    this.eventHub = new ShellSessionEventHub(this.ownerSessionId, this.managerInstanceId, () => this.list(), this.now)
  }

  async start(request: StartShellRequest): Promise<ShellObservation> {
    if (!this.acceptingStarts || this.closed) {
      throw new ShellSessionManagerError('manager-disposed', 'Shell session manager is draining or disposed')
    }
    if (this.liveSessionCount() >= this.maxActiveSessions) {
      throw new ShellSessionManagerError(
        'termination-unconfirmed',
        `The ${this.maxActiveSessions}-session limit is full. Use /ps to inspect sessions and /stop to close one.`,
      )
    }

    const shellId = `bg_${this.managerInstanceId}_${++this.shellCounter}`
    const session = createShellSession({
      ownerSessionId: this.ownerSessionId,
      managerInstanceId: this.managerInstanceId,
      id: shellId,
      originToolCallId: request.originToolCallId,
      command: request.prepared.command,
      requestedCwd: request.prepared.requestedCwd,
      effectiveCwd: request.prepared.effectiveCwd,
      tty: request.prepared.tty,
      maxOutputBytes: request.prepared.maxOutputBytes,
      hookOrigin: request.hookOrigin,
      now: this.now(),
      monotonicNow: this.monotonicNow(),
    })
    this.sessions.set(shellId, session)

    let attempt: ManagedSpawnAttempt
    try {
      attempt = this.options.provider.spawnManaged(request.prepared.command, {
        cwd: request.prepared.effectiveCwd,
        buffer: false,
        isolatedProcessTree: true,
        tty: request.prepared.tty,
      })
    } catch (error) {
      return this.completeFailedBeforeHandle(session, error, request.originToolCallId)
    }
    session.attempt = attempt
    session.process = attempt.handle
    registerManagedShellTarget(this.managerInstanceId, shellId, attempt.handle)

    const readyOutcome = await this.awaitSpawnReady(session, attempt, request.turnAbortSignal)
    if (readyOutcome.kind !== 'ready') {
      return this.settleFailedSpawn(
        session,
        attempt,
        readyOutcome.reason,
        readyOutcome.failure,
        request.originToolCallId,
      )
    }

    // No await is allowed between this arbitration check and the activation
    // commit below. A concurrent dispose either marks the starting session
    // before this point (so we clean it up without publishing started), or
    // observes the fully activated session and terminates it normally.
    if (!this.acceptingStarts || session.managerDrainingReason !== undefined) {
      return this.settleFailedSpawn(
        session,
        attempt,
        session.managerDrainingReason ?? 'manager-dispose',
        { code: 'manager-disposed', message: 'Shell manager began draining before activation committed' },
        request.originToolCallId,
      )
    }

    const startedAt = this.now()
    session.spawnOutcome = 'ready'
    session.status = 'running'
    session.startedAt = startedAt
    session.startedMonotonicAt = this.monotonicNow()
    session.lifecycleChanged.notify({ kind: 'spawn-ready' })
    this.eventHub.publish({
      kind: 'started',
      shellId,
      originToolCallId: request.originToolCallId,
      command: request.prepared.command,
      requestedCwd: request.prepared.requestedCwd,
      effectiveCwd: request.prepared.effectiveCwd,
      tty: request.prepared.tty,
      startedAt,
    })
    session.activation = 'active'
    attempt.activate((frame) => this.onFrame(session, frame))

    if (request.prepared.hardTimeoutMs !== undefined) {
      session.hardTimeoutAt = startedAt + request.prepared.hardTimeoutMs
      const hardTimeoutMonotonicAt = session.startedMonotonicAt + request.prepared.hardTimeoutMs
      session.hardTimeoutMonotonicAt = hardTimeoutMonotonicAt
      const onHardTimeout = () => {
        if (session.treeConfirmedExited) return
        const remaining = hardTimeoutMonotonicAt - this.monotonicNow()
        if (remaining > 0) {
          session.hardTimeoutTimer = setTimeout(onHardTimeout, remaining)
          return
        }
        session.hardTimeoutTimer = undefined
        session.timedOut = true
        void this.terminate(shellId, 'hard-timeout').catch((error) => {
          debugLog('shell-session.hard-timeout-error', `${shellId} ${String(error)}`)
        })
      }
      session.hardTimeoutTimer = setTimeout(onHardTimeout, request.prepared.hardTimeoutMs)
    }

    return this.observeSessionUntil(session, {
      source: 'initial',
      toolCallId: request.originToolCallId,
      policy: request.prepared.initialWait,
      chars: '',
      maxOutputBytes: request.prepared.maxOutputBytes,
      turnAbortSignal: request.turnAbortSignal,
    })
  }

  async interact(request: InteractShellRequest): Promise<ShellObservation> {
    const adopted = this.adoptedControllerFor(request.shellId)
    if (adopted) return adopted.interact(request)
    const session = this.requireSession(request.shellId)
    if (!session.tty && request.resize) {
      throw new ShellSessionManagerError(
        'stdin-unavailable',
        'terminal resize is unavailable for non-TTY shell sessions',
      )
    }
    if (!session.tty && request.chars !== '') {
      if (request.chars === '\u0003') {
        return this.terminateAndObserve({
          shellId: request.shellId,
          observerToolCallId: request.toolCallId,
          reason: 'kill-tool',
          turnAbortSignal: request.turnAbortSignal,
        })
      }
      throw new ShellSessionManagerError('stdin-unavailable', 'stdin is unavailable for non-TTY shell sessions')
    }
    if (this.closed) throw new ShellSessionManagerError('manager-disposed', 'Shell session manager is disposed')
    session.lastInteractionAt = this.now()
    const beforeObserve =
      session.tty && (request.resize !== undefined || request.chars !== '')
        ? async () => {
            const process = session.process
            if (!process) throw new ShellSessionManagerError('stdin-unavailable', 'PTY process is unavailable')
            if (request.resize) {
              if (!process.resize) throw new ShellSessionManagerError('stdin-unavailable', 'PTY resize is unavailable')
              await process.resize(request.resize.cols, request.resize.rows)
            }
            if (request.chars !== '') {
              if (!process.write) throw new ShellSessionManagerError('stdin-unavailable', 'PTY stdin is unavailable')
              await process.write(request.chars)
            }
          }
        : undefined
    return this.observeSessionUntil(
      session,
      {
        source: 'transport',
        toolCallId: request.toolCallId,
        policy: request.wait,
        chars: request.chars,
        resize: request.resize,
        maxOutputBytes: request.maxOutputBytes,
        turnAbortSignal: request.turnAbortSignal,
      },
      beforeObserve,
    )
  }

  async terminate(
    shellId: string,
    reason: TerminationReason,
    budget: TerminationBudget = DEFAULT_TERMINATION_BUDGET,
  ): Promise<ShellTerminationResult> {
    const adopted = this.adoptedControllerFor(shellId)
    if (adopted) return adopted.terminate(shellId, reason, budget)
    const session = this.requireSession(shellId)
    if (session.treeConfirmedExited) return this.alreadyExitedTermination(session, reason)
    if (session.terminationFlight) return session.terminationFlight

    const flight = this.runTermination(session, reason, budget)
    session.terminationFlight = flight
    try {
      return await flight
    } finally {
      if (session.terminationFlight === flight) session.terminationFlight = undefined
    }
  }

  async terminateAndObserve(request: TerminateAndObserveRequest): Promise<ShellObservation> {
    const adopted = this.adoptedControllerFor(request.shellId)
    if (adopted) return adopted.terminateAndObserve(request)
    const session = this.requireSession(request.shellId)
    const flight = this.terminate(request.shellId, request.reason, request.budget)
    const wake = abortWake(request.turnAbortSignal)
    try {
      const outcome = await Promise.race([
        flight.then(() => 'terminated' as const),
        wake.promise.then(() => 'aborted' as const),
      ])
      if (outcome === 'aborted') {
        return {
          kind: 'running',
          result: this.executionResult(session, session.unreadOutput.drain(), session.spawnMonotonicAt, {
            waitInterrupted: true,
            forceError: true,
          }),
        }
      }
      if (!session.treeConfirmedExited) {
        return {
          kind: 'running',
          result: this.executionResult(session, session.unreadOutput.drain(), session.spawnMonotonicAt, {
            forceError: true,
          }),
        }
      }
      if (!isCompositeTerminal(session)) await session.completion.promise
      return this.claimTerminalObservation(
        session,
        request.observerToolCallId,
        {
          output: '',
          originalBytes: 0,
          omittedBytes: 0,
        },
        true,
      )
    } finally {
      wake.dispose()
    }
  }

  list(): ShellSessionSummary[] {
    const summaries = [...this.sessions.values()].map((session) => this.summary(session))
    for (const { controller } of this.adoptedManagers.values()) {
      for (const summary of controller.list()) {
        if (this.adoptedShellOwners.get(summary.shellId) === controller.managerInstanceId) summaries.push(summary)
      }
    }
    return summaries
  }

  getSessionMetadata(
    shellId: string,
  ): Readonly<{ managerInstanceId: string; shellId: string; command: string; effectiveCwd: string }> | undefined {
    const session = this.sessions.get(shellId)
    if (session) {
      return {
        managerInstanceId: this.managerInstanceId,
        shellId: session.id,
        command: session.command,
        effectiveCwd: session.effectiveCwd,
      }
    }
    return this.adoptedControllerFor(shellId)?.getSessionMetadata(shellId)
  }

  adoptResidualManager(manager: ShellSessionController, shellIds: readonly string[]): string[] {
    if (manager === this) return []
    let adopted = this.adoptedManagers.get(manager.managerInstanceId)
    if (!adopted) {
      adopted = {
        controller: manager,
        unsubscribe: manager.subscribe((event) => this.forwardAdoptedEvent(manager, event)),
      }
      this.adoptedManagers.set(manager.managerInstanceId, adopted)
    } else if (adopted.controller !== manager) {
      throw new Error(`Shell manager identity collision: ${manager.managerInstanceId}`)
    }

    const accepted: string[] = []
    for (const shellId of new Set(shellIds)) {
      if (!manager.getSessionMetadata(shellId)) continue
      const existingOwner = this.adoptedShellOwners.get(shellId)
      if (existingOwner && existingOwner !== manager.managerInstanceId) {
        throw new Error(`Shell session identity collision: ${shellId}`)
      }
      this.adoptedShellOwners.set(shellId, manager.managerInstanceId)
      accepted.push(shellId)
    }
    if (accepted.length === 0 && ![...this.adoptedShellOwners.values()].includes(manager.managerInstanceId)) {
      adopted.unsubscribe()
      this.adoptedManagers.delete(manager.managerInstanceId)
      return []
    }
    this.eventHub.publish({ kind: 'snapshot', sessions: this.list() })
    return accepted
  }

  async terminateAll(
    reason: TerminationReason,
    budget: TerminationBudget = DEFAULT_TERMINATION_BUDGET,
  ): Promise<TerminateAllResult> {
    const targets = [...this.sessions.values()].filter((session) => !session.treeConfirmedExited)
    const localResultsPromise = Promise.all(
      targets.map((session) =>
        this.terminate(session.id, reason, budget).catch((error): ShellTerminationResult => {
          const failure = this.failure('termination-failed', error)
          return {
            managerInstanceId: this.managerInstanceId,
            shellId: session.id,
            reason,
            disposition: 'failed',
            gracefulAttempted: false,
            forceAttempted: false,
            rootExited: session.rootExited,
            treeConfirmedExited: session.treeConfirmedExited,
            terminationConfirmed: false,
            exitCode: session.exitCode,
            signal: session.signal,
            failure,
            output: session.unreadOutput.snapshot().output,
          }
        }),
      ),
    )
    const adoptedSummaries = new Map(
      [...this.adoptedManagers].map(([managerInstanceId, { controller }]) => [
        managerInstanceId,
        new Map(controller.list().map((summary) => [summary.shellId, summary])),
      ]),
    )
    const adoptedTargets = [...this.adoptedShellOwners].flatMap(([shellId, managerInstanceId]) => {
      const controller = this.adoptedManagers.get(managerInstanceId)?.controller
      const summary = adoptedSummaries.get(managerInstanceId)?.get(shellId)
      return controller && summary && !summary.treeConfirmedExited ? [{ controller, summary }] : []
    })
    const adoptedResultsPromise = Promise.all(
      adoptedTargets.map(async ({ controller, summary }): Promise<ShellTerminationResult> => {
        try {
          return await controller.terminate(summary.shellId, reason, budget)
        } catch (error) {
          return {
            managerInstanceId: summary.managerInstanceId,
            shellId: summary.shellId,
            reason,
            disposition: 'failed',
            gracefulAttempted: false,
            forceAttempted: false,
            rootExited: summary.rootExited,
            treeConfirmedExited: summary.treeConfirmedExited,
            terminationConfirmed: false,
            exitCode: summary.exitCode,
            signal: summary.signal,
            failure: this.failure('termination-failed', error),
            output: summary.recentOutput,
          }
        }
      }),
    )
    const [localResults, adoptedResults] = await Promise.all([localResultsPromise, adoptedResultsPromise])
    const results = [...localResults, ...adoptedResults]
    await this.closeConfirmedAdoptedManagers(reason, budget)
    return {
      managerInstanceId: this.managerInstanceId,
      reason,
      requested: targets.length + adoptedTargets.length,
      confirmed: results.filter((result) => result.disposition === 'terminated' && result.terminationConfirmed).length,
      alreadyExited: results.filter((result) => result.disposition === 'already-exited').length,
      results,
    }
  }

  dispose(
    reason: TerminationReason,
    budget: TerminationBudget = DEFAULT_TERMINATION_BUDGET,
  ): Promise<TerminateAllResult> {
    if (this.disposeFlight) return this.disposeFlight
    this.acceptingStarts = false
    for (const session of this.sessions.values()) {
      if (session.treeConfirmedExited) continue
      session.managerDrainingReason = reason
      session.lifecycleChanged.notify({ kind: 'manager-draining', reason })
    }
    const flight = this.runDispose(reason, budget)
    this.disposeFlight = flight
    void flight.then((result) => {
      if (result.results.some((entry) => !entry.treeConfirmedExited)) this.disposeFlight = undefined
    })
    return flight
  }

  subscribe(listener: ShellSessionListener, options?: { replayCurrent?: boolean }): () => void {
    return this.eventHub.subscribe(listener, options)
  }

  private async runDispose(reason: TerminationReason, budget: TerminationBudget): Promise<TerminateAllResult> {
    const result = await this.terminateAll(reason, budget)
    if (result.results.every((entry) => entry.treeConfirmedExited)) {
      const completions = [...this.sessions.values()]
        .filter((session) => session.treeConfirmedExited && !session.completion.settled)
        .map((session) => session.completion.promise)
      await Promise.all(completions)
      await this.eventHub.drain()
      await this.eventHub.close()
      this.abandonFinalObservations(reason)
      this.closed = true
    }
    return result
  }

  private async awaitSpawnReady(
    session: ShellSession,
    attempt: ManagedSpawnAttempt,
    signal: AbortSignal | undefined,
  ): Promise<
    | { kind: 'ready' }
    | { kind: 'cancelled'; reason: TerminationReason | 'turn-abort-before-ready'; failure: ShellFailure }
    | { kind: 'failed'; reason: 'spawn-failure-cleanup'; failure: ShellFailure }
  > {
    if (signal?.aborted) {
      return {
        kind: 'cancelled',
        reason: 'turn-abort-before-ready',
        failure: { code: 'spawn-failed', message: 'Shell start was interrupted before the process became ready' },
      }
    }
    const abort = abortWake(signal)
    const lifecycleGeneration = session.lifecycleChanged.generation
    const lifecycleWake = session.lifecycleChanged.waitAfterDisposable(lifecycleGeneration)
    try {
      const outcome = await Promise.race([
        attempt.ready.then(
          () => ({ kind: 'ready' as const }),
          (error) => ({ kind: 'failed' as const, error }),
        ),
        abort.promise.then(() => ({ kind: 'aborted' as const })),
        lifecycleWake.promise.then(() => ({ kind: 'lifecycle' as const })),
      ])
      if (outcome.kind === 'ready') return outcome
      if (outcome.kind === 'failed') {
        return { kind: 'failed', reason: 'spawn-failure-cleanup', failure: this.failure('spawn-failed', outcome.error) }
      }
      const reason =
        outcome.kind === 'aborted'
          ? 'turn-abort-before-ready'
          : (session.terminationReason ?? session.managerDrainingReason ?? 'manager-dispose')
      return {
        kind: 'cancelled',
        reason,
        failure: {
          code:
            outcome.kind === 'aborted'
              ? 'spawn-failed'
              : session.terminationReason
                ? 'termination-failed'
                : 'manager-disposed',
          message:
            outcome.kind === 'aborted'
              ? 'Shell start was interrupted before the process became ready'
              : session.terminationReason
                ? `Shell start was terminated before ready (${session.terminationReason})`
                : 'Shell manager began draining before the process became ready',
        },
      }
    } finally {
      abort.dispose()
      lifecycleWake.dispose()
    }
  }

  private async settleFailedSpawn(
    session: ShellSession,
    attempt: ManagedSpawnAttempt,
    reason: TerminationReason | 'turn-abort-before-ready',
    failure: ShellFailure,
    observerToolCallId: string,
  ): Promise<ShellObservation> {
    session.spawnOutcome = 'failed'
    session.failure = failure
    const cleanup = await attempt.cancelBeforeReady(reason, DEFAULT_TERMINATION_BUDGET)
    const frames = attempt.discardBufferedFrames()
    this.consumeDiscardedFrames(session, frames)
    session.activation = 'discarded'
    this.applyTerminationMetadata(session, cleanup)
    if (cleanup.treeConfirmedExited) this.commitTreeConfirmed(session)
    if (cleanup.rootExited) this.commitRootExit(session, cleanup.exitCode, cleanup.signal, false)
    if (cleanup.treeConfirmedExited) {
      this.forceFinalizeOutput(session)
      this.maybeFinalizeSession(session)
      return this.claimTerminalObservation(session, observerToolCallId, {
        output: '',
        originalBytes: 0,
        omittedBytes: 0,
      })
    }

    session.cleanupResidual = true
    session.status = 'termination-failed'
    session.failure = cleanup.failure ?? failure
    this.eventHub.publish({
      kind: 'residual-registered',
      shellId: session.id,
      originToolCallId: session.originToolCallId,
      command: session.command,
      effectiveCwd: session.effectiveCwd,
      failure: session.failure,
    })
    session.terminationAttempts++
    this.eventHub.publish({
      kind: 'termination-failed',
      shellId: session.id,
      reason: reason === 'turn-abort-before-ready' ? 'spawn-failure-cleanup' : reason,
      attempt: session.terminationAttempts,
      failure: session.failure,
      stillRunning: true,
    })
    session.lifecycleChanged.notify({
      kind: 'termination-failed',
      reason: reason === 'turn-abort-before-ready' ? 'spawn-failure-cleanup' : reason,
      failure: session.failure,
    })
    session.activation = 'active'
    attempt.activate((frame) => this.onFrame(session, frame))
    return {
      kind: 'running',
      result: this.executionResult(session, session.unreadOutput.drain(), session.spawnMonotonicAt, {
        forceError: true,
      }),
    }
  }

  private completeFailedBeforeHandle(
    session: ShellSession,
    error: unknown,
    observerToolCallId: string,
  ): Promise<ShellObservation> {
    session.spawnOutcome = 'failed'
    session.status = 'failed'
    session.failure = this.failure('spawn-failed', error)
    session.treeConfirmedExited = true
    session.treeConfirmedAt = this.now()
    session.outputFinalized = true
    this.maybeFinalizeSession(session)
    return this.claimTerminalObservation(session, observerToolCallId, {
      output: '',
      originalBytes: 0,
      omittedBytes: 0,
    })
  }

  private consumeDiscardedFrames(session: ShellSession, frames: ManagedProcessFrame[]): void {
    for (const frame of frames) {
      if (frame.kind === 'output') this.appendOutput(session, frame.stream, frame.chunk, false)
      else if (frame.kind === 'stream-end') this.endStream(session, frame.stream, false)
      else if (frame.kind === 'root-exit') this.commitRootExit(session, frame.exitCode, frame.signal, false)
      else if (frame.kind === 'tree-exit') this.commitTreeConfirmed(session)
    }
  }

  private onFrame(session: ShellSession, frame: ManagedProcessFrame): void {
    if (session.activation !== 'active') return
    if (frame.kind === 'output') {
      this.appendOutput(session, frame.stream, frame.chunk, true)
      return
    }
    if (frame.kind === 'stream-end') {
      this.endStream(session, frame.stream, true)
      return
    }
    if (frame.kind === 'root-exit') {
      this.commitRootExit(session, frame.exitCode, frame.signal, true)
      return
    }
    if (frame.kind === 'tree-exit') {
      this.commitTreeConfirmed(session)
      return
    }
    const failure = { code: 'termination-failed' as const, message: frame.message }
    session.failure = failure
    const cleanup = this.terminate(session.id, 'provider-failure')
    session.lifecycleChanged.notify({ kind: 'provider-failure', failure })
    void cleanup.catch((error) => {
      debugLog('shell-session.provider-failure-cleanup-error', `${session.id} ${String(error)}`)
    })
  }

  private appendOutput(session: ShellSession, stream: 'stdout' | 'stderr', chunk: Uint8Array, publish: boolean): void {
    if (session.outputFinalized) return
    const text = session.streamDecoders[stream].write(Buffer.from(chunk))
    if (!text) return
    session.unreadOutput.append(text)
    session.transcript.append(text)
    session.outputAvailable.notify(undefined)
    if (publish) this.eventHub.publish({ kind: 'output', shellId: session.id, stream, chunk: text })
  }

  private endStream(session: ShellSession, stream: 'stdout' | 'stderr', publish: boolean): void {
    if (session.streamsEnded.has(stream)) return
    const tail = session.streamDecoders[stream].end()
    if (tail) {
      session.unreadOutput.append(tail)
      session.transcript.append(tail)
      session.outputAvailable.notify(undefined)
      if (publish) this.eventHub.publish({ kind: 'output', shellId: session.id, stream, chunk: tail })
    }
    session.streamsEnded.add(stream)
    if (session.streamsEnded.size === 2) {
      session.outputFinalized = true
      if (session.trailingOutputTimer) clearTimeout(session.trailingOutputTimer)
      this.maybeFinalizeSession(session)
    }
  }

  private commitRootExit(
    session: ShellSession,
    exitCode: number | undefined,
    signal: string | undefined,
    publish: boolean,
  ): void {
    if (session.rootExited) return
    session.rootExited = true
    session.rootExitedAt = this.now()
    session.exitCode = exitCode
    session.signal = signal
    if (!session.treeConfirmedExited && session.status !== 'termination-failed') session.status = 'root-exited'
    session.lifecycleChanged.notify({ kind: 'root-exited', exitCode, signal })
    if (publish && !session.treeConfirmedExited) {
      this.eventHub.publish({
        kind: 'root-exited',
        shellId: session.id,
        exitCode,
        signal,
        treeConfirmedExited: false,
      })
    }
    if (!session.treeConfirmedExited && session.activation === 'active') {
      void this.terminate(session.id, 'root-exited-residual').catch((error) => {
        debugLog('shell-session.residual-cleanup-error', `${session.id} ${String(error)}`)
      })
    }
    this.maybeFinalizeSession(session)
  }

  private commitTreeConfirmed(session: ShellSession): void {
    if (session.treeConfirmedExited) return
    session.treeConfirmedExited = true
    session.treeConfirmedMonotonicAt = this.monotonicNow()
    if (session.hardTimeoutTimer) {
      clearTimeout(session.hardTimeoutTimer)
      session.hardTimeoutTimer = undefined
    }
    unregisterManagedShellTarget(this.managerInstanceId, session.id)
    session.treeConfirmedAt = this.now()
    session.terminationConfirmed = session.terminationReason !== undefined ? true : session.terminationConfirmed
    session.lifecycleChanged.notify({ kind: 'tree-confirmed' })
    if (!session.outputFinalized && !session.trailingOutputTimer) {
      session.trailingOutputTimer = setTimeout(() => this.forceFinalizeOutput(session), this.trailingOutputGraceMs)
    }
    this.maybeFinalizeSession(session)
  }

  private forceFinalizeOutput(session: ShellSession): void {
    if (session.outputFinalized || !session.treeConfirmedExited) return
    for (const stream of ['stdout', 'stderr'] as const) {
      if (session.streamsEnded.has(stream)) continue
      const tail = session.streamDecoders[stream].end()
      if (tail) {
        session.unreadOutput.append(tail)
        session.transcript.append(tail)
        session.outputAvailable.notify(undefined)
        if (session.activation === 'active') {
          this.eventHub.publish({ kind: 'output', shellId: session.id, stream, chunk: tail })
        }
      }
      session.streamsEnded.add(stream)
    }
    session.outputFinalized = true
    this.maybeFinalizeSession(session)
  }

  private maybeFinalizeSession(session: ShellSession): void {
    if (!isCompositeTerminal(session) || session.completion.settled) return
    session.status = session.spawnOutcome === 'failed' ? 'failed' : 'exited'
    session.exitedAt = this.now()
    session.exitedMonotonicAt = this.monotonicNow()
    if (session.hardTimeoutTimer) clearTimeout(session.hardTimeoutTimer)
    session.completion.resolve({ completedAt: session.exitedAt })
    const interactionBarrier = session.activeInteraction?.finished.promise
    void (async () => {
      if (interactionBarrier) await interactionBarrier
      if (session.exitEventPublished) return
      if (session.spawnOutcome === 'failed' && !session.cleanupResidual) return
      const event = this.eventHub.publish({
        kind: 'exited',
        shellId: session.id,
        exitCode: session.exitCode,
        signal: session.signal,
        failure: session.failure,
        durationMs: Math.max(0, (session.exitedMonotonicAt ?? this.monotonicNow()) - session.spawnMonotonicAt),
        wasYielded: session.yielded,
        timedOut: session.timedOut,
        terminationReason: session.terminationReason,
        terminationConfirmed: true,
        spawnOutcome: session.spawnOutcome === 'ready' ? 'ready' : 'failed',
        cleanupResidual: session.cleanupResidual,
        rootExited: session.rootExited,
        treeConfirmedExited: true,
        recentOutput: this.recentOutput(session),
        uiOmittedBytes: this.eventHub.omittedBytesFor(session.id),
      })
      session.exitEventPublished = true
      session.exitedSeq = event.seq
    })()
    this.scheduleCompletedExpiration(session)
  }

  private async observeSessionUntil(
    session: ShellSession,
    context: ObservationContext,
    beforeObserve?: () => Promise<void>,
  ): Promise<ShellObservation> {
    return session.interactionLock.runExclusive(async () => {
      const active = isCompositeTerminal(session) ? undefined : this.beginInteraction(session, context)
      const deadline = deadlineWake(context.policy)
      const abort = abortWake(context.turnAbortSignal)
      try {
        if (!isCompositeTerminal(session) && !context.turnAbortSignal?.aborted) await beforeObserve?.()
        while (true) {
          const outputGeneration = session.outputAvailable.generation
          const lifecycleGeneration = session.lifecycleChanged.generation

          if (isCompositeTerminal(session)) {
            return await this.claimTerminalObservation(session, context.toolCallId, {
              output: '',
              originalBytes: 0,
              omittedBytes: 0,
            })
          }

          if (session.status === 'termination-failed') {
            this.exposeInitialNonTerminal(session, context, 'termination-failed')
            return {
              kind: 'running',
              result: this.executionResult(session, session.unreadOutput.drain(), session.spawnMonotonicAt, {
                forceError: true,
              }),
            }
          }
          if (
            session.terminationReason === 'provider-failure' &&
            session.failure !== undefined &&
            !session.treeConfirmedExited
          ) {
            this.exposeInitialNonTerminal(session, context, 'termination-failed')
            return {
              kind: 'running',
              result: this.executionResult(session, session.unreadOutput.drain(), session.spawnMonotonicAt, {
                forceError: true,
              }),
            }
          }
          if (session.managerDrainingReason !== undefined) {
            this.exposeInitialNonTerminal(session, context, 'manager-draining')
            return {
              kind: 'running',
              result: this.executionResult(session, session.unreadOutput.drain(), session.spawnMonotonicAt, {
                waitInterrupted: true,
                forceError: true,
              }),
            }
          }
          if (context.turnAbortSignal?.aborted && !session.treeConfirmedExited) {
            this.exposeInitialNonTerminal(session, context, 'turn-abort')
            return {
              kind: 'running',
              result: this.executionResult(session, session.unreadOutput.drain(), session.spawnMonotonicAt, {
                waitInterrupted: true,
                forceError: true,
              }),
            }
          }
          if (context.policy.kind === 'immediate' && !session.treeConfirmedExited) {
            if (context.source === 'initial') this.transitionToYielded(session, 'explicit-background', 0)
            return {
              kind: 'running',
              result: this.executionResult(session, session.unreadOutput.drain(), session.spawnMonotonicAt),
            }
          }

          // Once the tree is confirmed, deadline and abort no longer describe
          // a live background process. Waiting only on composite completion
          // lets stream EOF or the bounded trailing-output grace finish without
          // a permanently resolved wake source spinning the microtask queue.
          if (session.treeConfirmedExited) {
            await session.completion.promise
            continue
          }

          const outputWake = session.outputAvailable.waitAfterDisposable(outputGeneration)
          const lifecycleWake = session.lifecycleChanged.waitAfterDisposable(lifecycleGeneration)
          let winner: 'output' | 'lifecycle' | 'completion' | 'deadline' | 'abort'
          try {
            winner = await Promise.race([
              outputWake.promise.then(() => 'output' as const),
              lifecycleWake.promise.then(() => 'lifecycle' as const),
              session.completion.promise.then(() => 'completion' as const),
              deadline.promise.then(() => 'deadline' as const),
              abort.promise.then(() => 'abort' as const),
            ])
          } finally {
            outputWake.dispose()
            lifecycleWake.dispose()
          }
          if (winner === 'deadline' && !session.treeConfirmedExited) {
            this.exposeInitialNonTerminal(session, context, 'deadline')
            return {
              kind: 'running',
              result: this.executionResult(session, session.unreadOutput.drain(), session.spawnMonotonicAt),
            }
          }
          if (winner === 'abort' && !session.treeConfirmedExited) {
            this.exposeInitialNonTerminal(session, context, 'turn-abort')
            return {
              kind: 'running',
              result: this.executionResult(session, session.unreadOutput.drain(), session.spawnMonotonicAt, {
                waitInterrupted: true,
                forceError: true,
              }),
            }
          }
        }
      } finally {
        deadline.dispose()
        abort.dispose()
        this.finishInteraction(session, active)
      }
    })
  }

  private beginInteraction(session: ShellSession, context: ObservationContext): ShellSession['activeInteraction'] {
    if (
      context.source !== 'transport' ||
      (context.policy.kind !== 'timed' && context.chars === '' && context.resize === undefined)
    ) {
      return undefined
    }
    const active = {
      toolCallId: context.toolCallId,
      chars: context.chars,
      cols: context.resize?.cols,
      rows: context.resize?.rows,
      eventEmitted: true,
      finished: createDeferred<void>(),
    }
    session.activeInteraction = active
    this.eventHub.publish({
      kind: 'wait-started',
      shellId: session.id,
      toolCallId: context.toolCallId,
      chars: context.chars,
      cols: context.resize?.cols,
      rows: context.resize?.rows,
    })
    return active
  }

  private finishInteraction(session: ShellSession, active: ShellSession['activeInteraction']): void {
    if (!active) return
    this.eventHub.publish({
      kind: 'wait-finished',
      shellId: session.id,
      toolCallId: active.toolCallId,
      chars: active.chars,
      cols: active.cols,
      rows: active.rows,
      running: !session.treeConfirmedExited,
    })
    active.finished.resolve()
    if (session.activeInteraction === active) session.activeInteraction = undefined
  }

  private exposeInitialNonTerminal(
    session: ShellSession,
    context: ObservationContext,
    reason: 'deadline' | 'turn-abort' | 'manager-draining' | 'termination-failed',
  ): void {
    if (context.source !== 'initial') return
    this.transitionToYielded(session, reason, context.policy.kind === 'timed' ? context.policy.ms : 0)
  }

  private transitionToYielded(
    session: ShellSession,
    reason: 'explicit-background' | 'deadline' | 'turn-abort' | 'manager-draining' | 'termination-failed',
    yieldAfterMs: number,
  ): void {
    if (session.yielded || session.spawnOutcome !== 'ready' || isCompositeTerminal(session)) return
    session.yielded = true
    this.eventHub.publish({ kind: 'yielded', shellId: session.id, yieldAfterMs, reason })
  }

  private async claimTerminalObservation(
    session: ShellSession,
    observerToolCallId: string,
    accumulated: ShellOutputSnapshot,
    killToolResult = false,
  ): Promise<ShellObservation> {
    while (session.finalObservation.status === 'claimed') {
      const outcome = await session.finalObservation.settled.promise
      if (outcome === 'acked') {
        throw new ShellSessionManagerError('unknown-shell-id', `Shell ${session.id} final output was already observed`)
      }
    }
    if (session.finalObservation.status === 'acked' || session.finalObservation.status === 'abandoned') {
      throw new ShellSessionManagerError('unknown-shell-id', `Shell ${session.id} final output is no longer available`)
    }
    const finalUnread = session.unreadOutput.snapshot()
    const output = mergeSnapshots(accumulated, finalUnread)
    const claimId = `${this.managerInstanceId}:${++this.claimCounter}`
    const settled = createDeferred<'acked' | 'released' | 'abandoned'>()
    session.finalObservation = { status: 'claimed', claimId, observerToolCallId, settled }
    const originalIsError = this.terminalIsError(session)
    const result = this.executionResult(session, output, session.spawnMonotonicAt, {
      forceError: killToolResult ? false : originalIsError,
    })
    const lease: FinalObservationLease = {
      claimId,
      observerToolCallId,
      origin: session.hookOrigin,
      post: { isError: originalIsError },
      ack: () => {
        if (session.finalObservation.status !== 'claimed' || session.finalObservation.claimId !== claimId) return
        if (session.retentionTimer) clearTimeout(session.retentionTimer)
        session.unreadOutput.drain()
        session.finalObservation = { status: 'acked', claimId, observerToolCallId }
        settled.resolve('acked')
        this.sessions.delete(session.id)
      },
      release: () => {
        if (session.finalObservation.status !== 'claimed' || session.finalObservation.claimId !== claimId) return
        session.finalObservation = { status: 'pending' }
        settled.resolve('released')
        this.scheduleCompletedExpiration(session)
      },
    }
    return { kind: 'terminal', result, lease }
  }

  private executionResult(
    session: ShellSession,
    output: ShellOutputSnapshot,
    startedMonotonicAt: number,
    options: { waitInterrupted?: boolean; forceError?: boolean } = {},
  ): ShellExecutionResult {
    const lifecycle =
      session.spawnOutcome === 'failed' && session.treeConfirmedExited
        ? 'spawn-failed'
        : session.treeConfirmedExited
          ? 'exited'
          : session.status === 'termination-failed'
            ? 'termination-failed'
            : session.managerDrainingReason
              ? 'manager-draining'
              : session.rootExited
                ? 'root-exited'
                : 'running'
    return {
      chunkId: `${this.managerInstanceId.slice(0, 6)}-${++this.chunkCounter}`,
      wallTimeMs: Math.max(0, this.monotonicNow() - startedMonotonicAt),
      output: output.output,
      isError: options.forceError ?? false,
      originalBytes: output.originalBytes,
      omittedBytes: output.omittedBytes,
      shellId: session.treeConfirmedExited && !session.cleanupResidual ? undefined : session.id,
      exitCode: session.exitCode,
      signal: session.signal,
      running: !session.treeConfirmedExited,
      rootExited: session.rootExited,
      treeConfirmedExited: session.treeConfirmedExited,
      cleanupResidual: session.cleanupResidual,
      lifecycle,
      timedOut: session.timedOut,
      waitInterrupted: options.waitInterrupted ?? false,
      managerDraining: session.managerDrainingReason !== undefined,
      failure: session.failure,
      terminationReason: session.terminationReason,
      terminationConfirmed: session.terminationConfirmed,
    }
  }

  private async runTermination(
    session: ShellSession,
    reason: TerminationReason,
    budget: TerminationBudget,
  ): Promise<ShellTerminationResult> {
    if (!session.process) {
      const failure = { code: 'termination-failed' as const, message: 'Shell process handle is unavailable' }
      return this.failedTermination(session, reason, failure, false, false)
    }
    session.terminationReason ??= reason
    session.status = 'terminating'
    const result =
      session.spawnOutcome === 'pending' && session.attempt
        ? await session.attempt.cancelBeforeReady(session.terminationReason, budget)
        : await session.process.terminateTree(session.terminationReason, budget)
    this.applyTerminationMetadata(session, result)
    if (result.rootExited) this.commitRootExit(session, result.exitCode, result.signal, session.activation === 'active')
    if (result.treeConfirmedExited) {
      this.commitTreeConfirmed(session)
      if (!session.outputFinalized) await session.completion.promise
      return {
        managerInstanceId: this.managerInstanceId,
        shellId: session.id,
        reason: session.terminationReason,
        disposition: 'terminated',
        gracefulAttempted: result.gracefulAttempted,
        forceAttempted: result.forceAttempted,
        rootExited: session.rootExited,
        treeConfirmedExited: true,
        terminationConfirmed: true,
        exitCode: session.exitCode,
        signal: session.signal,
        output: session.unreadOutput.snapshot().output,
      }
    }

    const failure = result.failure ?? {
      code: 'termination-unconfirmed' as const,
      message: 'Process-tree termination could not be confirmed',
    }
    session.status = 'termination-failed'
    session.failure = failure
    session.terminationConfirmed = false
    session.terminationAttempts++
    session.lifecycleChanged.notify({ kind: 'termination-failed', reason: session.terminationReason, failure })
    if (session.activation === 'active') {
      this.eventHub.publish({
        kind: 'termination-failed',
        shellId: session.id,
        reason: session.terminationReason,
        attempt: session.terminationAttempts,
        failure,
        stillRunning: true,
      })
    }
    return {
      managerInstanceId: this.managerInstanceId,
      shellId: session.id,
      reason: session.terminationReason,
      disposition: terminationDisposition(result),
      gracefulAttempted: result.gracefulAttempted,
      forceAttempted: result.forceAttempted,
      rootExited: session.rootExited,
      treeConfirmedExited: false,
      terminationConfirmed: false,
      exitCode: session.exitCode,
      signal: session.signal,
      failure,
      output: session.unreadOutput.snapshot().output,
    }
  }

  private applyTerminationMetadata(session: ShellSession, result: ProcessTerminationResult): void {
    if (result.exitCode !== undefined) session.exitCode = result.exitCode
    if (result.signal !== undefined) session.signal = result.signal
    if (result.failure) session.failure = result.failure
  }

  private failedTermination(
    session: ShellSession,
    reason: TerminationReason,
    failure: ShellFailure,
    gracefulAttempted: boolean,
    forceAttempted: boolean,
  ): ShellTerminationResult {
    return {
      managerInstanceId: this.managerInstanceId,
      shellId: session.id,
      reason,
      disposition: 'failed',
      gracefulAttempted,
      forceAttempted,
      rootExited: session.rootExited,
      treeConfirmedExited: session.treeConfirmedExited,
      terminationConfirmed: session.treeConfirmedExited,
      exitCode: session.exitCode,
      signal: session.signal,
      failure,
      output: session.unreadOutput.snapshot().output,
    }
  }

  private alreadyExitedTermination(session: ShellSession, reason: TerminationReason): ShellTerminationResult {
    return {
      managerInstanceId: this.managerInstanceId,
      shellId: session.id,
      reason,
      disposition: 'already-exited',
      gracefulAttempted: false,
      forceAttempted: false,
      rootExited: session.rootExited,
      treeConfirmedExited: true,
      terminationConfirmed: true,
      exitCode: session.exitCode,
      signal: session.signal,
      output: session.unreadOutput.snapshot().output,
    }
  }

  private terminalIsError(session: ShellSession): boolean {
    return (
      session.spawnOutcome === 'failed' ||
      session.timedOut ||
      session.failure !== undefined ||
      session.signal !== undefined ||
      (session.exitCode !== undefined && session.exitCode !== 0)
    )
  }

  private summary(session: ShellSession): ShellSessionSummary {
    return {
      managerInstanceId: this.managerInstanceId,
      ownerSessionId: this.ownerSessionId,
      shellId: session.id,
      originToolCallId: session.originToolCallId,
      command: session.command,
      requestedCwd: session.requestedCwd,
      effectiveCwd: session.effectiveCwd,
      tty: session.tty,
      status: session.status,
      yielded: session.yielded,
      spawnOutcome: session.spawnOutcome,
      cleanupResidual: session.cleanupResidual,
      spawnRequestedAt: session.spawnRequestedAt,
      startedAt: session.startedAt,
      rootExited: session.rootExited,
      treeConfirmedExited: session.treeConfirmedExited,
      outputFinalized: session.outputFinalized,
      rootExitedAt: session.rootExitedAt,
      treeConfirmedAt: session.treeConfirmedAt,
      exitedAt: session.exitedAt,
      exitCode: session.exitCode,
      signal: session.signal,
      failure: session.failure,
      timedOut: session.timedOut,
      terminationReason: session.terminationReason,
      terminationConfirmed: session.terminationConfirmed,
      exitedSeq: session.exitedSeq,
      recentOutput: this.recentOutput(session),
      omittedBytes: session.transcript.omittedBytes,
      uiOmittedBytes: this.eventHub.omittedBytesFor(session.id),
    }
  }

  private recentOutput(session: ShellSession): string {
    return utf8Tail(
      stripTerminalControls(session.transcript.tailSnapshot(MAX_RECENT_OUTPUT_BYTES)),
      MAX_RECENT_OUTPUT_BYTES,
    )
  }

  private adoptedControllerFor(shellId: string): ShellSessionController | undefined {
    const managerInstanceId = this.adoptedShellOwners.get(shellId)
    return managerInstanceId ? this.adoptedManagers.get(managerInstanceId)?.controller : undefined
  }

  private forwardAdoptedEvent(manager: ShellSessionController, event: ShellSessionEvent): void {
    if (event.kind === 'snapshot' || this.adoptedShellOwners.get(event.shellId) !== manager.managerInstanceId) return
    const {
      seq: _seq,
      ownerSessionId: _ownerSessionId,
      managerInstanceId: _managerInstanceId,
      occurredAt: _occurredAt,
      ...payload
    } = event
    this.eventHub.publish(payload as ShellEventPayload)
  }

  private async closeConfirmedAdoptedManagers(reason: TerminationReason, budget: TerminationBudget): Promise<void> {
    for (const [managerInstanceId, adopted] of [...this.adoptedManagers]) {
      const shellIds = [...this.adoptedShellOwners]
        .filter(([, owner]) => owner === managerInstanceId)
        .map(([shellId]) => shellId)
      const summaries = new Map(adopted.controller.list().map((summary) => [summary.shellId, summary]))
      if (shellIds.some((shellId) => summaries.get(shellId)?.treeConfirmedExited === false)) continue
      let cleanup: TerminateAllResult
      try {
        cleanup = await adopted.controller.dispose(reason, budget)
      } catch (error) {
        debugLog('shell-session.adopted-manager-dispose-error', `${managerInstanceId} ${String(error)}`)
        continue
      }
      if (cleanup.results.some((result) => !result.treeConfirmedExited)) continue
      adopted.unsubscribe()
      this.adoptedManagers.delete(managerInstanceId)
      for (const shellId of shellIds) this.adoptedShellOwners.delete(shellId)
    }
  }

  private requireSession(shellId: string): ShellSession {
    const session = this.sessions.get(shellId)
    if (session) return session
    throw new ShellSessionManagerError(
      'unknown-shell-id',
      `Background shell ${shellId} is not available in manager ${this.managerInstanceId}. Shell sessions do not survive /clear, /resume, or CLI restart.`,
    )
  }

  private liveSessionCount(): number {
    let count = 0
    for (const session of this.sessions.values()) {
      if (!session.treeConfirmedExited) count++
    }
    return count
  }

  private expireCompletedSession(session: ShellSession): void {
    if (!session.treeConfirmedExited) return
    session.retentionTimer = undefined
    if (session.finalObservation.status === 'claimed') return
    if (session.finalObservation.status === 'pending') {
      session.finalObservation = { status: 'abandoned', reason: 'retention-expired' }
    }
    this.sessions.delete(session.id)
  }

  private scheduleCompletedExpiration(session: ShellSession): void {
    if (!session.treeConfirmedExited || session.finalObservation.status === 'acked') return
    if (session.retentionTimer) clearTimeout(session.retentionTimer)
    session.retentionTimer = setTimeout(() => this.expireCompletedSession(session), this.completedRetentionMs)
    session.retentionTimer.unref?.()
  }

  private abandonFinalObservations(reason: TerminationReason): void {
    for (const session of this.sessions.values()) {
      if (session.retentionTimer) clearTimeout(session.retentionTimer)
      session.retentionTimer = undefined
      if (session.finalObservation.status === 'claimed') {
        session.finalObservation.settled.resolve('abandoned')
      }
      if (session.finalObservation.status === 'pending' || session.finalObservation.status === 'claimed') {
        debugLog(
          'shell-session.final-observation-abandoned',
          `manager=${this.managerInstanceId} shell=${session.id} reason=${reason}`,
        )
        session.finalObservation = { status: 'abandoned', reason }
      }
    }
  }

  private failure(code: ShellFailureCode, error: unknown): ShellFailure {
    const message = error instanceof Error ? error.message : String(error)
    return { code, message }
  }
}
