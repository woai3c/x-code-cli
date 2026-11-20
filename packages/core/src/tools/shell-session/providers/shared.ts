import type { ManagedExitStatus, ManagedProcessFrame, SpawnReadyResult } from '../provider.js'
import type { Deferred } from '../session.js'
import type { ProcessTerminationResult } from '../types.js'
import type { ActivationFrameBuffer } from './activation-frames.js'
import { WindowsSupervisorFrameKind } from './windows-supervisor-protocol.js'

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export function timeoutWake(ms: number): { promise: Promise<false>; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    promise: new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    }),
    dispose() {
      if (timer) clearTimeout(timer)
    },
  }
}

export function confirmedTerminationResult(
  rootExited: boolean,
  exitStatus: ManagedExitStatus,
  gracefulAttempted: boolean,
  forceAttempted: boolean,
): ProcessTerminationResult {
  return {
    gracefulAttempted,
    forceAttempted,
    rootExited,
    treeConfirmedExited: true,
    ...exitStatus,
  }
}

export function failedTerminationResult(
  rootExited: boolean,
  exitStatus: ManagedExitStatus,
  gracefulAttempted: boolean,
  forceAttempted: boolean,
  message: string,
): ProcessTerminationResult {
  return {
    gracefulAttempted,
    forceAttempted,
    rootExited,
    treeConfirmedExited: false,
    ...exitStatus,
    failure: { code: 'termination-unconfirmed', message },
  }
}

export interface WindowsLifecycleObserver {
  setRootPid(rootPid: number): void
  observeRootExit(exitCode: number): void
  observeTreeExit(): void
  observeProtocolFailure(message: string): void
}

/**
 * Handle the supervisor lifecycle frames (`ready`, `rootExit`, `treeEmpty`,
 * `spawnError`, `terminationError`) shared by both Windows Job Object and
 * Windows ConPTY spawn attempts. Returns `true` when `kind` was handled.
 */
export function dispatchWindowsSupervisorLifecycleFrame(options: {
  kind: number
  payload: Buffer
  treeKind: SpawnReadyResult['treeKind']
  handle: WindowsLifecycleObserver
  readyState: Deferred<SpawnReadyResult>
  frames: Pick<ActivationFrameBuffer, 'push'>
  failProtocol: (error: Error) => void
  spawnErrorFallback: string
  terminationErrorFallback: string
}): boolean {
  const { kind, payload, treeKind, handle, readyState, frames, failProtocol } = options
  if (kind === WindowsSupervisorFrameKind.ready) {
    if (payload.length !== 4) failProtocol(new Error('ready frame has an invalid payload'))
    else {
      const rootPid = payload.readUInt32LE()
      handle.setRootPid(rootPid)
      readyState.resolve({ rootPid, treeKind })
    }
    return true
  }
  if (kind === WindowsSupervisorFrameKind.rootExit) {
    if (payload.length !== 4) failProtocol(new Error('root-exit frame has an invalid payload'))
    else {
      const exitCode = payload.readUInt32LE()
      handle.observeRootExit(exitCode)
      frames.push({ kind: 'root-exit', exitCode } satisfies ManagedProcessFrame)
    }
    return true
  }
  if (kind === WindowsSupervisorFrameKind.treeEmpty) {
    if (payload.length !== 0) failProtocol(new Error('tree-empty frame has an invalid payload'))
    else {
      handle.observeTreeExit()
      frames.push({ kind: 'tree-exit' })
    }
    return true
  }
  if (kind === WindowsSupervisorFrameKind.spawnError) {
    const message = payload.toString('utf8') || options.spawnErrorFallback
    handle.observeProtocolFailure(message)
    readyState.reject(new Error(message))
    return true
  }
  if (kind === WindowsSupervisorFrameKind.terminationError) {
    const message = payload.toString('utf8') || options.terminationErrorFallback
    handle.observeProtocolFailure(message)
    frames.push({ kind: 'failure', message })
    return true
  }
  return false
}
