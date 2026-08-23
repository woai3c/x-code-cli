import { StringDecoder } from 'node:string_decoder'

import { HeadTailOutputBuffer } from './output-buffer.js'
import { ShellOutputSpill } from './output-spill.js'
import type { ManagedProcess, ManagedSpawnAttempt } from './provider.js'
import type {
  ShellFailure,
  ShellHookOrigin,
  ShellSessionStatus,
  ShellTerminationResult,
  TerminationReason,
} from './types.js'
import { AsyncMutex, VersionedAsyncSignal } from './wait-notifier.js'

export interface Deferred<T> {
  readonly promise: Promise<T>
  readonly settled: boolean
  resolve(value: T): void
  reject(error: unknown): void
}

export function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (error: unknown) => void
  let settled = false
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    get settled() {
      return settled
    },
    resolve(value) {
      if (settled) return
      settled = true
      resolvePromise(value)
    },
    reject(error) {
      if (settled) return
      settled = true
      rejectPromise(error)
    },
  }
}

export type ShellLifecycleChange =
  | { kind: 'spawn-ready' }
  | { kind: 'root-exited'; exitCode?: number; signal?: string }
  | { kind: 'tree-confirmed' }
  | { kind: 'provider-failure'; failure: ShellFailure }
  | { kind: 'manager-draining'; reason: TerminationReason }
  | { kind: 'termination-failed'; reason: TerminationReason; failure: ShellFailure }

export interface ShellCompletion {
  completedAt: number
}

export type FinalObservationState =
  | { status: 'pending' }
  | {
      status: 'claimed'
      claimId: string
      observerToolCallId: string
      settled: Deferred<'acked' | 'released' | 'abandoned'>
    }
  | { status: 'acked'; claimId: string; observerToolCallId: string }
  | { status: 'abandoned'; reason: TerminationReason | 'retention-expired' }

export interface ShellSession {
  ownerSessionId: string
  managerInstanceId: string
  id: string
  originToolCallId: string
  command: string
  requestedCwd?: string
  effectiveCwd: string
  tty: boolean
  maxOutputBytes: number
  process?: ManagedProcess
  attempt?: ManagedSpawnAttempt
  activation: 'pending' | 'active' | 'discarded'
  spawnOutcome: 'pending' | 'ready' | 'failed'
  cleanupResidual: boolean
  status: ShellSessionStatus
  spawnRequestedAt: number
  spawnMonotonicAt: number
  startedAt?: number
  startedMonotonicAt?: number
  lastInteractionAt: number
  rootExitedAt?: number
  treeConfirmedAt?: number
  exitedAt?: number
  exitedMonotonicAt?: number
  exitedSeq?: number
  hardTimeoutAt?: number
  hardTimeoutMonotonicAt?: number
  treeConfirmedMonotonicAt?: number
  rootExited: boolean
  treeConfirmedExited: boolean
  outputFinalized: boolean
  exitCode?: number
  signal?: string
  failure?: ShellFailure
  timedOut: boolean
  managerDrainingReason?: TerminationReason
  terminationReason?: TerminationReason
  terminationConfirmed?: boolean
  terminationFlight?: Promise<ShellTerminationResult>
  terminationAttempts: number
  yielded: boolean
  interactionLock: AsyncMutex
  activeInteraction?: {
    toolCallId: string
    chars: string
    cols?: number
    rows?: number
    eventEmitted: boolean
    finished: Deferred<void>
  }
  outputAvailable: VersionedAsyncSignal<undefined>
  lifecycleChanged: VersionedAsyncSignal<ShellLifecycleChange | undefined>
  completion: Deferred<ShellCompletion>
  unreadOutput: HeadTailOutputBuffer
  transcript: HeadTailOutputBuffer
  outputSpill: ShellOutputSpill
  streamDecoders: Record<'stdout' | 'stderr', StringDecoder>
  streamsEnded: Set<'stdout' | 'stderr'>
  trailingOutputTimer?: ReturnType<typeof setTimeout>
  hardTimeoutTimer?: ReturnType<typeof setTimeout>
  retentionTimer?: ReturnType<typeof setTimeout>
  hookOrigin: ShellHookOrigin
  finalObservation: FinalObservationState
  exitEventPublished: boolean
}

export function createShellSession(input: {
  ownerSessionId: string
  managerInstanceId: string
  id: string
  originToolCallId: string
  command: string
  requestedCwd?: string
  effectiveCwd: string
  tty: boolean
  maxOutputBytes: number
  spillMaxInlineBytes?: number
  hookOrigin: ShellHookOrigin
  now: number
  monotonicNow: number
}): ShellSession {
  return {
    ownerSessionId: input.ownerSessionId,
    managerInstanceId: input.managerInstanceId,
    id: input.id,
    originToolCallId: input.originToolCallId,
    command: input.command,
    requestedCwd: input.requestedCwd,
    effectiveCwd: input.effectiveCwd,
    tty: input.tty,
    maxOutputBytes: input.maxOutputBytes,
    activation: 'pending',
    spawnOutcome: 'pending',
    cleanupResidual: false,
    status: 'starting',
    spawnRequestedAt: input.now,
    spawnMonotonicAt: input.monotonicNow,
    lastInteractionAt: input.now,
    rootExited: false,
    treeConfirmedExited: false,
    outputFinalized: false,
    timedOut: false,
    terminationAttempts: 0,
    yielded: false,
    interactionLock: new AsyncMutex(),
    outputAvailable: new VersionedAsyncSignal(undefined),
    lifecycleChanged: new VersionedAsyncSignal<ShellLifecycleChange | undefined>(undefined),
    completion: createDeferred<ShellCompletion>(),
    unreadOutput: new HeadTailOutputBuffer(input.maxOutputBytes),
    transcript: new HeadTailOutputBuffer(input.maxOutputBytes),
    outputSpill: new ShellOutputSpill({ maxInlineBytes: input.spillMaxInlineBytes }),
    streamDecoders: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') },
    streamsEnded: new Set(),
    hookOrigin: input.hookOrigin,
    finalObservation: { status: 'pending' },
    exitEventPublished: false,
  }
}

export function isCompositeTerminal(session: ShellSession): boolean {
  if (session.spawnOutcome === 'ready') {
    return session.rootExited && session.treeConfirmedExited && session.outputFinalized
  }
  return session.spawnOutcome === 'failed' && session.treeConfirmedExited && session.outputFinalized
}
