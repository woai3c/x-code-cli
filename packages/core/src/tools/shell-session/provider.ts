import type { Readable, Writable } from 'node:stream'

import type { ProcessTerminationResult, TerminationBudget, TerminationReason } from './types.js'

export interface ManagedOutputCapture {
  append(text: string): void
}

export interface ManagedShellSpawnOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  buffer: false
  isolatedProcessTree: true
  tty: boolean
  cols?: number
  rows?: number
  outputCapture?: ManagedOutputCapture
}

export interface SpawnReadyResult {
  rootPid: number
  treeKind: 'posix-process-group' | 'windows-job-object' | 'posix-pty-process-group' | 'windows-conpty'
}

export interface ManagedExitStatus {
  exitCode?: number
  signal?: string
}

export type ManagedProcessFrame =
  | { kind: 'output'; stream: 'stdout' | 'stderr'; chunk: Uint8Array; fullOutputCaptured?: true }
  | { kind: 'stream-end'; stream: 'stdout' | 'stderr' }
  | ({ kind: 'root-exit' } & ManagedExitStatus)
  | { kind: 'tree-exit' }
  | { kind: 'failure'; message: string }

export interface ManagedProcess {
  readonly rootPid?: number
  readonly stdin?: Writable
  readonly stdout?: Readable
  readonly stderr?: Readable
  write?(chars: string): Promise<void>
  resize?(cols: number, rows: number): Promise<void>
  waitForRootExit(): Promise<ManagedExitStatus>
  waitForTreeExit(): Promise<void>
  probeTree(): Promise<'live' | 'confirmed-exited' | 'unknown'>
  terminateTree(reason: TerminationReason, budget: TerminationBudget): Promise<ProcessTerminationResult>
  forceTreeSync(deadlineAt: number): 'already-exited' | 'force-sent-unconfirmed' | 'deadline-exhausted' | 'failed'
}

export interface ManagedSpawnAttempt {
  readonly handle: ManagedProcess
  readonly ready: Promise<SpawnReadyResult>
  activate(listener: (frame: ManagedProcessFrame) => void): void
  discardBufferedFrames(): ManagedProcessFrame[]
  cancelBeforeReady(
    reason: TerminationReason | 'turn-abort-before-ready',
    budget?: TerminationBudget,
  ): Promise<ProcessTerminationResult>
}

export interface ManagedShellProvider {
  spawnManaged(command: string, options: ManagedShellSpawnOptions): ManagedSpawnAttempt
}
