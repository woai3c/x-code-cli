import type { IDisposable, IPty } from 'node-pty'

import { randomBytes } from 'node:crypto'
import { type Server, type Socket, createServer } from 'node:net'

import type {
  ManagedExitStatus,
  ManagedProcess,
  ManagedProcessFrame,
  ManagedSpawnAttempt,
  SpawnReadyResult,
} from '../provider.js'
import { createDeferred } from '../session.js'
import type { ProcessTerminationResult, TerminationBudget, TerminationReason } from '../types.js'
import { ActivationFrameBuffer } from './activation-frames.js'
import type { WindowsSupervisorArtifact } from './windows-job.js'
import {
  WindowsSupervisorFrameDecoder,
  WindowsSupervisorFrameKind,
  encodeWindowsSupervisorFrame,
  encodeWindowsSupervisorLaunch,
} from './windows-supervisor-protocol.js'

type NodePtyModule = typeof import('node-pty')

export interface WindowsPtySpawnOptions {
  artifact: Promise<WindowsSupervisorArtifact>
  nodePty: NodePtyModule
  application: string
  commandLine: string
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

const MIN_CONTROL_WAIT_MS = 25

function timeoutWake(ms: number): { promise: Promise<false>; dispose(): void } {
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

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function closeServer(server: Server | undefined): void {
  if (!server) return
  try {
    server.close()
  } catch {
    // Closing a server whose listen failed is already complete.
  }
}

function listen(server: Server, pipeName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(pipeName)
  })
}

class WindowsPtyManagedProcess implements ManagedProcess {
  private readonly rootExit = createDeferred<ManagedExitStatus>()
  private readonly treeExit = createDeferred<void>()
  private readonly controlReady = createDeferred<void>()
  private currentRootPid?: number
  private currentExitStatus: ManagedExitStatus = {}
  private terminal?: IPty
  private control?: Socket
  private spawnState: 'pending' | 'attached' | 'absent' = 'pending'
  private terminalExited = false
  private protocolFailure?: string
  private terminationFlight?: Promise<ProcessTerminationResult>
  private fallbackKillRequested = false

  constructor(private readonly cancelPendingSpawn: () => void) {}

  get rootPid(): number | undefined {
    return this.currentRootPid
  }

  get treeConfirmedExited(): boolean {
    return this.treeExit.settled
  }

  get terminalAttached(): boolean {
    return this.spawnState === 'attached'
  }

  attachTerminal(terminal: IPty): void {
    if (this.spawnState !== 'pending') throw new Error('Windows PTY supervisor attached after cancellation')
    this.terminal = terminal
    this.spawnState = 'attached'
  }

  attachControl(control: Socket): void {
    this.control = control
    this.controlReady.resolve()
  }

  markSpawnAbsent(): void {
    if (this.spawnState === 'pending') this.spawnState = 'absent'
  }

  setRootPid(rootPid: number): void {
    this.currentRootPid = rootPid
  }

  observeRootExit(exitCode: number): void {
    this.currentExitStatus = { exitCode }
    this.rootExit.resolve(this.currentExitStatus)
  }

  observeTreeExit(): void {
    this.treeExit.resolve()
  }

  observeProtocolFailure(message: string): void {
    this.protocolFailure = message
  }

  observeTerminalExit(): void {
    this.terminalExited = true
    if (!this.treeExit.settled) {
      this.protocolFailure ??= 'Windows PTY supervisor exited before reporting an empty Job Object'
    }
  }

  async write(chars: string): Promise<void> {
    if (this.rootExit.settled || this.treeExit.settled) throw new Error('PTY has already exited')
    if (!this.terminal) throw new Error('PTY is not ready')
    this.terminal.write(chars)
    await nextImmediate()
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (this.rootExit.settled || this.treeExit.settled) throw new Error('PTY has already exited')
    if (!this.terminal) throw new Error('PTY is not ready')
    this.terminal.resize(cols, rows)
    await nextImmediate()
  }

  waitForRootExit(): Promise<ManagedExitStatus> {
    return this.rootExit.promise
  }

  waitForTreeExit(): Promise<void> {
    return this.treeExit.promise
  }

  async probeTree(): Promise<'live' | 'confirmed-exited' | 'unknown'> {
    if (this.treeExit.settled || this.spawnState === 'absent') return 'confirmed-exited'
    if (this.spawnState === 'pending') return 'unknown'
    return this.terminalExited || this.protocolFailure ? 'unknown' : 'live'
  }

  terminateTree(reason: TerminationReason, budget: TerminationBudget): Promise<ProcessTerminationResult> {
    if (this.terminationFlight) return this.terminationFlight
    const flight = this.runTermination(reason, budget)
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
    if (this.treeExit.settled || this.spawnState === 'absent') return 'already-exited'
    if (performance.now() >= deadlineAt) return 'deadline-exhausted'
    if (this.spawnState === 'pending') {
      this.cancelPendingSpawn()
      this.markSpawnAbsent()
      return 'already-exited'
    }
    try {
      if (this.control && !this.control.destroyed && this.control.writable) {
        this.control.write(encodeWindowsSupervisorFrame(WindowsSupervisorFrameKind.force))
      } else {
        this.requestFallbackKill()
      }
      return 'force-sent-unconfirmed'
    } catch {
      return 'failed'
    }
  }

  private async runTermination(
    _reason: TerminationReason,
    budget: TerminationBudget,
  ): Promise<ProcessTerminationResult> {
    if (this.treeExit.settled || this.spawnState === 'absent') return this.confirmed(false, false)
    if (this.spawnState === 'pending') {
      this.cancelPendingSpawn()
      this.markSpawnAbsent()
      return this.confirmed(false, false)
    }

    await this.waitForControl(Math.min(Math.max(MIN_CONTROL_WAIT_MS, budget.gracefulMs), 250))
    const gracefulAttempted = await this.writeControl(WindowsSupervisorFrameKind.graceful)
    let forceAttempted = false
    if (await this.waitForTree(budget.gracefulMs)) return this.confirmed(gracefulAttempted, forceAttempted)

    forceAttempted = await this.writeControl(WindowsSupervisorFrameKind.force)
    if (!forceAttempted && !this.terminalExited) {
      try {
        this.requestFallbackKill()
        forceAttempted = true
      } catch (error) {
        return this.failure(gracefulAttempted, forceAttempted, `ConPTY supervisor close failed: ${String(error)}`)
      }
    }
    if (await this.waitForTree(budget.forceMs + budget.confirmMs)) {
      return this.confirmed(gracefulAttempted, forceAttempted)
    }
    return this.failure(
      gracefulAttempted,
      forceAttempted,
      this.protocolFailure ?? 'Windows PTY Job Object did not report active-process-zero before the deadline',
    )
  }

  private async waitForControl(ms: number): Promise<boolean> {
    if (this.controlReady.settled) return true
    if (this.terminalExited || ms <= 0) return false
    const timeout = timeoutWake(ms)
    try {
      return await Promise.race([this.controlReady.promise.then(() => true), timeout.promise])
    } finally {
      timeout.dispose()
    }
  }

  private writeControl(
    kind: typeof WindowsSupervisorFrameKind.graceful | typeof WindowsSupervisorFrameKind.force,
  ): Promise<boolean> {
    const control = this.control
    if (!control || control.destroyed || !control.writable) return Promise.resolve(false)
    return new Promise((resolve) => {
      control.write(encodeWindowsSupervisorFrame(kind), (error) => {
        if (error) {
          this.protocolFailure = `Could not write Windows PTY supervisor termination frame: ${String(error)}`
          resolve(false)
        } else {
          resolve(true)
        }
      })
    })
  }

  private async waitForTree(ms: number): Promise<boolean> {
    if (this.treeExit.settled) return true
    const timeout = timeoutWake(ms)
    try {
      return await Promise.race([this.treeExit.promise.then(() => true), timeout.promise])
    } finally {
      timeout.dispose()
    }
  }

  private requestFallbackKill(): void {
    if (this.fallbackKillRequested) return
    if (!this.terminal) throw new Error('PTY supervisor is unavailable')
    this.terminal.kill()
    this.fallbackKillRequested = true
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

export class WindowsPtySpawnAttempt implements ManagedSpawnAttempt {
  readonly handle: WindowsPtyManagedProcess
  readonly ready: Promise<SpawnReadyResult>
  private readonly readyState = createDeferred<SpawnReadyResult>()
  private readonly frames = new ActivationFrameBuffer()
  private readonly pipePrefix = `\\\\.\\pipe\\x-code-pty-${process.pid}-${randomBytes(16).toString('hex')}`
  private readonly decoder = new WindowsSupervisorFrameDecoder()
  private eventServer?: Server
  private controlServer?: Server
  private events?: Socket
  private control?: Socket
  private launchSent = false
  private terminal?: IPty
  private dataDisposable?: IDisposable
  private exitDisposable?: IDisposable
  private cancelled = false

  constructor(private readonly options: WindowsPtySpawnOptions) {
    this.handle = new WindowsPtyManagedProcess(() => this.cancelPendingSpawn())
    this.ready = this.readyState.promise
    void this.initialize()
  }

  activate(listener: (frame: ManagedProcessFrame) => void): void {
    this.frames.activate(listener)
  }

  discardBufferedFrames(): ManagedProcessFrame[] {
    return this.frames.discard()
  }

  async cancelBeforeReady(
    reason: TerminationReason | 'turn-abort-before-ready',
    budget: TerminationBudget = { gracefulMs: 1_000, forceMs: 1_000, confirmMs: 250 },
  ): Promise<ProcessTerminationResult> {
    this.cancelled = true
    this.readyState.reject(new Error('Windows PTY start was cancelled before supervisor ready'))
    if (!this.handle.terminalAttached) {
      this.cancelPendingSpawn()
      this.handle.markSpawnAbsent()
      return {
        gracefulAttempted: false,
        forceAttempted: false,
        rootExited: false,
        treeConfirmedExited: true,
      }
    }
    return this.handle.terminateTree(reason === 'turn-abort-before-ready' ? 'spawn-failure-cleanup' : reason, budget)
  }

  private cancelPendingSpawn(): void {
    this.cancelled = true
    closeServer(this.eventServer)
    closeServer(this.controlServer)
  }

  private async initialize(): Promise<void> {
    try {
      const artifact = await this.options.artifact
      if (this.cancelled) {
        this.handle.markSpawnAbsent()
        return
      }

      this.eventServer = createServer((events) => this.acceptEvents(events))
      this.controlServer = createServer((control) => this.acceptControl(control))
      await Promise.all([
        listen(this.eventServer, `${this.pipePrefix}-events`),
        listen(this.controlServer, `${this.pipePrefix}-control`),
      ])
      if (this.cancelled) {
        closeServer(this.eventServer)
        closeServer(this.controlServer)
        this.handle.markSpawnAbsent()
        return
      }

      const terminal = this.options.nodePty.spawn(
        artifact.executablePath,
        ['--pty', `${this.pipePrefix}-events`, `${this.pipePrefix}-control`],
        {
          name: 'xterm-256color',
          cols: this.options.cols,
          rows: this.options.rows,
          cwd: this.options.cwd,
          env: this.options.env,
          useConpty: true,
          useConptyDll: true,
        },
      )
      if (!Number.isSafeInteger(terminal.pid) || terminal.pid <= 0) {
        terminal.kill()
        throw new Error('Windows PTY supervisor spawned without a process id')
      }
      this.terminal = terminal
      this.handle.attachTerminal(terminal)
      this.dataDisposable = terminal.onData((data) => {
        this.frames.push({ kind: 'output', stream: 'stdout', chunk: Buffer.from(data, 'utf8') })
      })
      this.exitDisposable = terminal.onExit(() => this.onTerminalExit())
    } catch (error) {
      closeServer(this.eventServer)
      closeServer(this.controlServer)
      if (!this.handle.terminalAttached) this.handle.markSpawnAbsent()
      this.readyState.reject(error)
    }
  }

  private acceptEvents(events: Socket): void {
    if (this.events) {
      events.destroy()
      return
    }
    this.events = events
    closeServer(this.eventServer)
    events.on('data', (chunk: Buffer) => {
      try {
        for (const frame of this.decoder.push(chunk)) this.onProtocolFrame(frame.kind, frame.payload)
      } catch (error) {
        this.failProtocol(error)
      }
    })
    events.once('end', () => {
      try {
        this.decoder.end()
      } catch (error) {
        this.failProtocol(error)
      }
    })
    events.once('error', (error) => this.failProtocol(error))
    events.once('close', () => {
      if (!this.readyState.settled) {
        this.readyState.reject(new Error('Windows PTY supervisor event pipe closed before ready'))
      } else if (!this.handle.treeConfirmedExited) {
        this.failProtocol(new Error('Windows PTY supervisor event pipe closed before reporting an empty Job Object'))
      }
    })
    this.maybeSendLaunch()
  }

  private acceptControl(control: Socket): void {
    if (this.control) {
      control.destroy()
      return
    }
    this.control = control
    closeServer(this.controlServer)
    this.handle.attachControl(control)
    control.once('error', (error) => this.failProtocol(error))
    control.once('close', () => {
      if (!this.readyState.settled) {
        this.readyState.reject(new Error('Windows PTY supervisor control pipe closed before ready'))
      }
    })
    this.maybeSendLaunch()
  }

  private maybeSendLaunch(): void {
    if (this.launchSent || !this.events || !this.control) return
    this.launchSent = true
    this.control.write(
      encodeWindowsSupervisorLaunch({
        cwd: this.options.cwd,
        application: this.options.application,
        commandLine: this.options.commandLine,
      }),
      (error) => {
        if (error) this.failProtocol(error)
      },
    )
  }

  private onProtocolFrame(kind: number, payload: Buffer): void {
    if (kind === WindowsSupervisorFrameKind.ready) {
      if (payload.length !== 4) return this.failProtocol(new Error('ready frame has an invalid payload'))
      const rootPid = payload.readUInt32LE()
      this.handle.setRootPid(rootPid)
      this.readyState.resolve({ rootPid, treeKind: 'windows-conpty' })
      return
    }
    if (kind === WindowsSupervisorFrameKind.rootExit) {
      if (payload.length !== 4) return this.failProtocol(new Error('root-exit frame has an invalid payload'))
      const exitCode = payload.readUInt32LE()
      this.handle.observeRootExit(exitCode)
      this.frames.push({ kind: 'root-exit', exitCode })
      return
    }
    if (kind === WindowsSupervisorFrameKind.treeEmpty) {
      if (payload.length !== 0) return this.failProtocol(new Error('tree-empty frame has an invalid payload'))
      this.handle.observeTreeExit()
      this.frames.push({ kind: 'tree-exit' })
      return
    }
    if (kind === WindowsSupervisorFrameKind.spawnError) {
      const message = payload.toString('utf8') || 'Windows PTY supervisor failed to start the command'
      this.handle.observeProtocolFailure(message)
      this.readyState.reject(new Error(message))
      return
    }
    if (kind === WindowsSupervisorFrameKind.terminationError) {
      const message = payload.toString('utf8') || 'Windows PTY Job Object termination failed'
      this.handle.observeProtocolFailure(message)
      this.frames.push({ kind: 'failure', message })
      return
    }
    this.failProtocol(new Error(`unexpected Windows PTY supervisor frame kind ${kind}`))
  }

  private onTerminalExit(): void {
    this.handle.observeTerminalExit()
    this.frames.push({ kind: 'stream-end', stream: 'stdout' })
    this.frames.push({ kind: 'stream-end', stream: 'stderr' })
    if (!this.readyState.settled) {
      this.readyState.reject(new Error('Windows PTY supervisor exited before ready'))
    }
    this.dataDisposable?.dispose()
    this.exitDisposable?.dispose()
    // The Job notification pipe is independent from ConPTY. Let it drain so a
    // queued ACTIVE_PROCESS_ZERO frame cannot be lost behind terminal onExit.
    this.control?.destroy()
    closeServer(this.eventServer)
    closeServer(this.controlServer)
  }

  private failProtocol(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.handle.observeProtocolFailure(message)
    this.readyState.reject(new Error(message))
    this.frames.push({ kind: 'failure', message })
  }
}
