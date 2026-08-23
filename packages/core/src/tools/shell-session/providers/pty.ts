import type { IDisposable, IPty } from 'node-pty'

import { chmodSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants as osConstants } from 'node:os'
import path from 'node:path'

import type {
  ManagedExitStatus,
  ManagedProcess,
  ManagedProcessFrame,
  ManagedShellProvider,
  ManagedShellSpawnOptions,
  ManagedSpawnAttempt,
  SpawnReadyResult,
} from '../provider.js'
import { createDeferred } from '../session.js'
import type { ProcessTerminationResult, TerminationBudget, TerminationReason } from '../types.js'
import { ActivationFrameBuffer } from './activation-frames.js'
import type { WindowsSupervisorArtifact } from './windows-job.js'
import { resolveWindowsSupervisorArtifact } from './windows-job.js'
import { defaultWindowsPowerShellExecutable, powerShellWrapper } from './windows-powershell.js'
import { WindowsPtySpawnAttempt } from './windows-pty.js'
import { quoteWindowsCommandArgument } from './windows-supervisor-protocol.js'

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const MIN_CONFIRM_DELAY_MS = 25
const MAX_CONFIRM_DELAY_MS = 100

type NodePtyModule = typeof import('node-pty')
type TreeProbe = 'live' | 'confirmed-exited' | 'unknown'

const require = createRequire(import.meta.url)
let loadedNodePty: NodePtyModule | undefined

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function ensurePosixSpawnHelperExecutable(): void {
  if (process.platform === 'win32') return
  const packageRoot = path.dirname(require.resolve('node-pty/package.json'))
  const helper = path.join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  try {
    const mode = statSync(helper).mode
    if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o111)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function loadNodePty(): NodePtyModule {
  if (loadedNodePty) return loadedNodePty
  // pnpm's content-addressed copy can lose the executable bit from node-pty's
  // macOS spawn helper even when the tarball metadata is correct.
  ensurePosixSpawnHelperExecutable()
  loadedNodePty = require('node-pty') as NodePtyModule
  return loadedNodePty
}

function stringEnvironment(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const values = Object.fromEntries(
    Object.entries(env ?? process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  // The cloned environment bypasses node-pty's identity-based sanitization.
  for (const key of ['TMUX', 'TMUX_PANE', 'STY', 'WINDOW', 'WINDOWID', 'TERMCAP', 'COLUMNS', 'LINES'])
    delete values[key]
  values.TERM ??= 'xterm-256color'
  values.COLORTERM ??= 'truecolor'
  values.PYTHONIOENCODING = 'utf-8'
  return values
}

function signalName(signal: number | undefined): string | undefined {
  if (signal === undefined || signal === 0) return undefined
  return Object.entries(osConstants.signals).find(([, value]) => value === signal)?.[0] ?? `signal-${signal}`
}

function validateSize(cols: number, rows: number): void {
  if (!Number.isSafeInteger(cols) || cols <= 0 || !Number.isSafeInteger(rows) || rows <= 0) {
    throw new RangeError('PTY cols and rows must be positive safe integers')
  }
}

class PosixPtyManagedProcess implements ManagedProcess {
  readonly rootPid: number
  private readonly rootExit = createDeferred<ManagedExitStatus>()
  private readonly treeExit = createDeferred<void>()
  private currentExitStatus: ManagedExitStatus = {}
  private terminationFlight?: Promise<ProcessTerminationResult>
  private treeExitFramePublished = false

  constructor(
    private readonly terminal: IPty,
    private readonly frames: ActivationFrameBuffer,
  ) {
    this.rootPid = terminal.pid
  }

  async write(chars: string): Promise<void> {
    if (this.treeExit.settled) throw new Error('PTY has already exited')
    this.terminal.write(chars)
    await nextImmediate()
  }

  async resize(cols: number, rows: number): Promise<void> {
    validateSize(cols, rows)
    if (this.treeExit.settled) throw new Error('PTY has already exited')
    this.terminal.resize(cols, rows)
    await nextImmediate()
  }

  observeRootExit(status: ManagedExitStatus): void {
    this.currentExitStatus = status
    this.rootExit.resolve(status)
  }

  observeTreeExit(publishFrame = true): void {
    if (!this.treeExit.settled) this.treeExit.resolve()
    if (publishFrame && !this.treeExitFramePublished) {
      this.treeExitFramePublished = true
      this.frames.push({ kind: 'tree-exit' })
    }
  }

  confirmTreeAfterTerminalClose(): void {
    this.probeTreeSync(false)
  }

  publishConfirmedTreeExit(): void {
    if (this.treeExit.settled) this.observeTreeExit()
  }

  waitForRootExit(): Promise<ManagedExitStatus> {
    return this.rootExit.promise
  }

  waitForTreeExit(): Promise<void> {
    return this.treeExit.promise
  }

  async probeTree(): Promise<TreeProbe> {
    return this.probeTreeSync()
  }

  terminateTree(reason: TerminationReason, budget: TerminationBudget): Promise<ProcessTerminationResult> {
    if (this.terminationFlight) return this.terminationFlight
    const flight = this.runPosixTermination(reason, budget)
    this.terminationFlight = flight
    void flight.then(
      () => {
        if (this.terminationFlight === flight) this.terminationFlight = undefined
      },
      () => {
        if (this.terminationFlight === flight) this.terminationFlight = undefined
      },
    )
    return flight
  }

  forceTreeSync(deadlineAt: number): 'already-exited' | 'force-sent-unconfirmed' | 'deadline-exhausted' | 'failed' {
    if (this.treeExit.settled) return 'already-exited'
    if (performance.now() >= deadlineAt) return 'deadline-exhausted'
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

  private async runPosixTermination(
    _reason: TerminationReason,
    budget: TerminationBudget,
  ): Promise<ProcessTerminationResult> {
    if (this.probeTreeSync() === 'confirmed-exited') return this.confirmed(false, false)
    let gracefulAttempted = false
    let forceAttempted = false
    try {
      gracefulAttempted = true
      process.kill(-this.rootPid, 'SIGTERM')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') {
        this.observeTreeExit()
        return this.confirmed(gracefulAttempted, forceAttempted)
      }
      if (code === 'EPERM') {
        return this.failure(gracefulAttempted, forceAttempted, `SIGTERM PTY process-group denied: ${String(error)}`)
      }
    }
    if (await this.confirmUntil(performance.now() + budget.gracefulMs)) {
      return this.confirmed(gracefulAttempted, forceAttempted)
    }

    try {
      forceAttempted = true
      process.kill(-this.rootPid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        this.observeTreeExit()
        return this.confirmed(gracefulAttempted, forceAttempted)
      }
      return this.failure(gracefulAttempted, forceAttempted, `SIGKILL PTY process-group failed: ${String(error)}`)
    }
    if (await this.confirmUntil(performance.now() + budget.forceMs + budget.confirmMs)) {
      return this.confirmed(gracefulAttempted, forceAttempted)
    }
    return this.failure(
      gracefulAttempted,
      forceAttempted,
      'PTY process group remained live after SIGKILL confirmation window',
    )
  }

  private async confirmUntil(deadline: number): Promise<boolean> {
    let waitMs = MIN_CONFIRM_DELAY_MS
    while (true) {
      if (this.probeTreeSync() === 'confirmed-exited') return true
      const remaining = deadline - performance.now()
      if (remaining <= 0) return false
      await delay(Math.min(waitMs, remaining))
      waitMs = Math.min(MAX_CONFIRM_DELAY_MS, waitMs * 2)
    }
  }

  private probeTreeSync(publishFrame = true): TreeProbe {
    if (this.treeExit.settled) return 'confirmed-exited'
    try {
      process.kill(-this.rootPid, 0)
      return 'live'
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') {
        this.observeTreeExit(publishFrame)
        return 'confirmed-exited'
      }
      return code === 'EPERM' ? 'live' : 'unknown'
    }
  }

  private confirmed(gracefulAttempted: boolean, forceAttempted: boolean): ProcessTerminationResult {
    return {
      gracefulAttempted,
      forceAttempted,
      rootExited: this.rootExit.settled,
      treeConfirmedExited: true,
      ...this.currentExitStatus,
    }
  }

  private failure(gracefulAttempted: boolean, forceAttempted: boolean, message: string): ProcessTerminationResult {
    return {
      gracefulAttempted,
      forceAttempted,
      rootExited: this.rootExit.settled,
      treeConfirmedExited: false,
      ...this.currentExitStatus,
      failure: { code: 'termination-unconfirmed', message },
    }
  }
}

class PosixPtySpawnAttempt implements ManagedSpawnAttempt {
  readonly handle: PosixPtyManagedProcess
  readonly ready: Promise<SpawnReadyResult>
  private readonly dataDisposable: IDisposable
  private exitDisposable?: IDisposable

  constructor(
    terminal: IPty,
    private readonly frames: ActivationFrameBuffer,
  ) {
    this.handle = new PosixPtyManagedProcess(terminal, frames)
    this.ready = Promise.resolve({
      rootPid: terminal.pid,
      treeKind: 'posix-pty-process-group',
    })
    this.dataDisposable = terminal.onData((data) => {
      frames.push({ kind: 'output', stream: 'stdout', chunk: Buffer.from(data, 'utf8') })
    })
    this.exitDisposable = terminal.onExit((event) => {
      const status: ManagedExitStatus = {
        exitCode: event.exitCode,
        signal: signalName(event.signal),
      }
      this.handle.observeRootExit(status)
      this.handle.confirmTreeAfterTerminalClose()
      frames.push({ kind: 'stream-end', stream: 'stdout' })
      frames.push({ kind: 'stream-end', stream: 'stderr' })
      frames.push({ kind: 'root-exit', ...status })
      this.handle.publishConfirmedTreeExit()
      this.dataDisposable.dispose()
      this.exitDisposable?.dispose()
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
    return this.handle.terminateTree(reason === 'turn-abort-before-ready' ? 'spawn-failure-cleanup' : reason, budget)
  }
}

export interface PtyShellProviderOptions {
  executable?: string
  nodePty?: NodePtyModule
  platform?: NodeJS.Platform
  windowsArtifact?: Promise<WindowsSupervisorArtifact> | WindowsSupervisorArtifact
}

export class PtyShellProvider implements ManagedShellProvider {
  private readonly platform: NodeJS.Platform
  private windowsArtifact?: Promise<WindowsSupervisorArtifact>

  constructor(private readonly options: PtyShellProviderOptions = {}) {
    this.platform = options.platform ?? process.platform
    if (options.windowsArtifact) this.windowsArtifact = Promise.resolve(options.windowsArtifact)
  }

  spawnManaged(command: string, options: ManagedShellSpawnOptions): ManagedSpawnAttempt {
    if (!options.tty) throw new Error('PtyShellProvider requires tty: true')
    const cols = options.cols ?? DEFAULT_COLS
    const rows = options.rows ?? DEFAULT_ROWS
    validateSize(cols, rows)
    const isWindows = this.platform === 'win32'
    const executable =
      this.options.executable ?? (isWindows ? defaultWindowsPowerShellExecutable() : (process.env.SHELL ?? '/bin/bash'))
    const args = isWindows
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powerShellWrapper(command)]
      : ['-c', command]
    const nodePty = this.options.nodePty ?? loadNodePty()
    const env = stringEnvironment(options.env)
    if (isWindows) {
      this.windowsArtifact ??= resolveWindowsSupervisorArtifact()
      return new WindowsPtySpawnAttempt({
        artifact: this.windowsArtifact,
        nodePty,
        application: executable,
        commandLine: [executable, ...args].map(quoteWindowsCommandArgument).join(' '),
        cwd: options.cwd,
        env,
        cols,
        rows,
        outputCapture: options.outputCapture,
      })
    }

    const frames = new ActivationFrameBuffer(options.outputCapture)
    const terminal = nodePty.spawn(executable, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: options.cwd,
      env,
    })
    if (!Number.isSafeInteger(terminal.pid) || terminal.pid <= 0) {
      terminal.kill()
      throw new Error('PTY shell spawned without a process id')
    }
    return new PosixPtySpawnAttempt(terminal, frames)
  }
}
