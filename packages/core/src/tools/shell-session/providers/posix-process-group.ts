import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

import type {
  ManagedExitStatus,
  ManagedProcess,
  ManagedProcessFrame,
  ManagedShellProvider,
  ManagedShellSpawnOptions,
  ManagedSpawnAttempt,
  SpawnReadyResult,
} from '../provider.js'
import { type Deferred, createDeferred } from '../session.js'
import type { ProcessTerminationResult, TerminationBudget, TerminationReason } from '../types.js'
import { ActivationFrameBuffer } from './activation-frames.js'

const MIN_CONFIRM_DELAY_MS = 25
const MAX_CONFIRM_DELAY_MS = 100

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function exitStatus(child: ChildProcessWithoutNullStreams): ManagedExitStatus {
  return {
    exitCode: child.exitCode ?? undefined,
    signal: child.signalCode ?? undefined,
  }
}

class PosixManagedProcess implements ManagedProcess {
  readonly stdin
  readonly stdout
  readonly stderr
  readonly rootPid?: number
  private readonly rootExit = createDeferred<ManagedExitStatus>()
  private readonly treeExit = createDeferred<void>()
  private terminationFlight?: Promise<ProcessTerminationResult>

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly frames: ActivationFrameBuffer,
  ) {
    this.stdin = child.stdin
    this.stdout = child.stdout
    this.stderr = child.stderr
    this.rootPid = child.pid
  }

  observeRootExit(status: ManagedExitStatus): void {
    this.rootExit.resolve(status)
  }

  observeTreeExit(): void {
    this.treeExit.resolve()
  }

  waitForRootExit(): Promise<ManagedExitStatus> {
    return this.rootExit.promise
  }

  waitForTreeExit(): Promise<void> {
    return this.treeExit.promise
  }

  async probeTree(): Promise<'live' | 'confirmed-exited' | 'unknown'> {
    return this.probeTreeSync()
  }

  terminateTree(reason: TerminationReason, budget: TerminationBudget): Promise<ProcessTerminationResult> {
    if (this.terminationFlight) return this.terminationFlight
    const flight = this.runTermination(reason, budget)
    this.terminationFlight = flight
    void flight.finally(() => {
      if (this.terminationFlight === flight) this.terminationFlight = undefined
    })
    return flight
  }

  forceTreeSync(deadlineAt: number): 'already-exited' | 'force-sent-unconfirmed' | 'deadline-exhausted' | 'failed' {
    if (performance.now() >= deadlineAt) return 'deadline-exhausted'
    const state = this.probeTreeSync()
    if (state === 'confirmed-exited') return 'already-exited'
    if (!this.rootPid) return 'already-exited'
    try {
      process.kill(-this.rootPid, 'SIGKILL')
      return 'force-sent-unconfirmed'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        this.observeTreeExit()
        return 'already-exited'
      }
      return 'failed'
    }
  }

  private async runTermination(
    _reason: TerminationReason,
    budget: TerminationBudget,
  ): Promise<ProcessTerminationResult> {
    const initial = this.probeTreeSync()
    if (initial === 'confirmed-exited') {
      const status = exitStatus(this.child)
      return {
        gracefulAttempted: false,
        forceAttempted: false,
        rootExited: this.child.exitCode !== null || this.child.signalCode !== null,
        treeConfirmedExited: true,
        ...status,
      }
    }
    if (!this.rootPid) {
      this.observeTreeExit()
      return {
        gracefulAttempted: false,
        forceAttempted: false,
        rootExited: this.child.exitCode !== null || this.child.signalCode !== null,
        treeConfirmedExited: true,
        ...exitStatus(this.child),
      }
    }

    let gracefulAttempted = false
    let forceAttempted = false
    try {
      gracefulAttempted = true
      process.kill(-this.rootPid, 'SIGTERM')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') {
        this.observeTreeExit()
        return {
          gracefulAttempted,
          forceAttempted,
          rootExited: this.child.exitCode !== null || this.child.signalCode !== null,
          treeConfirmedExited: true,
          ...exitStatus(this.child),
        }
      }
      if (code === 'EPERM') {
        return this.failure(
          gracefulAttempted,
          forceAttempted,
          `SIGTERM process-group permission denied: ${String(error)}`,
        )
      }
    }

    if (await this.confirmUntil(performance.now() + budget.gracefulMs)) {
      return this.confirmed(gracefulAttempted, forceAttempted)
    }

    try {
      forceAttempted = true
      process.kill(-this.rootPid, 'SIGKILL')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') {
        this.observeTreeExit()
        return this.confirmed(gracefulAttempted, forceAttempted)
      }
      return this.failure(gracefulAttempted, forceAttempted, `SIGKILL process-group failed: ${String(error)}`)
    }

    if (await this.confirmUntil(performance.now() + budget.forceMs + budget.confirmMs)) {
      return this.confirmed(gracefulAttempted, forceAttempted)
    }
    return this.failure(
      gracefulAttempted,
      forceAttempted,
      'Process group remained live after SIGKILL confirmation window',
    )
  }

  private async confirmUntil(deadline: number): Promise<boolean> {
    let waitMs = MIN_CONFIRM_DELAY_MS
    while (true) {
      const state = this.probeTreeSync()
      if (state === 'confirmed-exited') return true
      const remaining = deadline - performance.now()
      if (remaining <= 0) return false
      await delay(Math.min(waitMs, remaining))
      waitMs = Math.min(MAX_CONFIRM_DELAY_MS, waitMs * 2)
    }
  }

  private probeTreeSync(): 'live' | 'confirmed-exited' | 'unknown' {
    if (this.treeExit.settled) return 'confirmed-exited'
    if (!this.rootPid) return 'confirmed-exited'
    try {
      process.kill(-this.rootPid, 0)
      return 'live'
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') {
        this.observeTreeExit()
        this.frames.push({ kind: 'tree-exit' })
        return 'confirmed-exited'
      }
      return code === 'EPERM' ? 'live' : 'unknown'
    }
  }

  private confirmed(gracefulAttempted: boolean, forceAttempted: boolean): ProcessTerminationResult {
    return {
      gracefulAttempted,
      forceAttempted,
      rootExited: this.child.exitCode !== null || this.child.signalCode !== null,
      treeConfirmedExited: true,
      ...exitStatus(this.child),
    }
  }

  private failure(gracefulAttempted: boolean, forceAttempted: boolean, message: string): ProcessTerminationResult {
    return {
      gracefulAttempted,
      forceAttempted,
      rootExited: this.child.exitCode !== null || this.child.signalCode !== null,
      treeConfirmedExited: false,
      ...exitStatus(this.child),
      failure: { code: 'termination-unconfirmed', message },
    }
  }
}

class PosixSpawnAttempt implements ManagedSpawnAttempt {
  readonly ready: Promise<SpawnReadyResult>
  readonly handle: PosixManagedProcess
  private readonly readyState: Deferred<SpawnReadyResult>

  constructor(
    child: ChildProcessWithoutNullStreams,
    private readonly frames: ActivationFrameBuffer,
  ) {
    this.readyState = createDeferred<SpawnReadyResult>()
    this.ready = this.readyState.promise
    this.handle = new PosixManagedProcess(child, frames)

    child.stdout.on('data', (chunk: Buffer) => frames.push({ kind: 'output', stream: 'stdout', chunk }))
    child.stderr.on('data', (chunk: Buffer) => frames.push({ kind: 'output', stream: 'stderr', chunk }))
    child.stdout.once('end', () => frames.push({ kind: 'stream-end', stream: 'stdout' }))
    child.stderr.once('end', () => frames.push({ kind: 'stream-end', stream: 'stderr' }))
    child.once('spawn', () => {
      const rootPid = child.pid
      if (!rootPid) {
        this.readyState.reject(new Error('POSIX shell spawned without a process id'))
        return
      }
      this.readyState.resolve({ rootPid, treeKind: 'posix-process-group' })
    })
    child.once('error', (error) => {
      this.readyState.reject(error)
      this.handle.observeRootExit({})
    })
    child.once('exit', (exitCode, signal) => {
      const status = { exitCode: exitCode ?? undefined, signal: signal ?? undefined }
      this.handle.observeRootExit(status)
      frames.push({ kind: 'root-exit', ...status })
      void this.handle.probeTree()
    })
  }

  activate(listener: (frame: ManagedProcessFrame) => void): void {
    this.frames.activate(listener)
  }

  discardBufferedFrames(): ManagedProcessFrame[] {
    return this.frames.discard()
  }

  cancelBeforeReady(
    reason: TerminationReason | 'turn-abort-before-ready',
    budget: TerminationBudget = { gracefulMs: 1_000, forceMs: 1_000, confirmMs: 250 },
  ): Promise<ProcessTerminationResult> {
    const mappedReason = reason === 'turn-abort-before-ready' ? 'spawn-failure-cleanup' : reason
    return this.handle.terminateTree(mappedReason, budget)
  }
}

export class PosixProcessGroupProvider implements ManagedShellProvider {
  constructor(private readonly executable = process.env.SHELL ?? '/bin/bash') {}

  spawnManaged(command: string, options: ManagedShellSpawnOptions): ManagedSpawnAttempt {
    const frames = new ActivationFrameBuffer(options.outputCapture)
    const child = spawn(this.executable, ['-c', command], {
      cwd: options.cwd,
      env: { ...(options.env ?? process.env), PYTHONIOENCODING: 'utf-8' },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    return new PosixSpawnAttempt(child, frames)
  }
}
