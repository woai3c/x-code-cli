import { emptyHookBus } from '../src/hooks/bus.js'
import { UnifiedShellSessionManager } from '../src/tools/shell-session/manager.js'
import type {
  ManagedProcess,
  ManagedProcessFrame,
  ManagedShellProvider,
  ManagedShellSpawnOptions,
  ManagedSpawnAttempt,
  SpawnReadyResult,
} from '../src/tools/shell-session/provider.js'
import type {
  ProcessTerminationResult,
  ShellHookOrigin,
  StartShellRequest,
  TerminationBudget,
  TerminationReason,
  WaitPolicy,
} from '../src/tools/shell-session/types.js'

const MANAGER_ID = '0123456789abcdef0123456789abcdef'
const CONFIRMED_TERMINATION: ProcessTerminationResult = {
  gracefulAttempted: true,
  forceAttempted: false,
  rootExited: true,
  treeConfirmedExited: true,
  exitCode: 0,
}

class FakeProcess implements ManagedProcess {
  rootPid = 1234
  terminationCalls: Array<{ reason: TerminationReason; budget: TerminationBudget }> = []
  terminationResult: ProcessTerminationResult = CONFIRMED_TERMINATION
  writes: string[] = []
  resizes: Array<{ cols: number; rows: number }> = []
  writeHandler?: (chars: string) => Promise<void>
  terminationHandler?: (reason: TerminationReason, budget: TerminationBudget) => Promise<ProcessTerminationResult>

  async write(chars: string): Promise<void> {
    this.writes.push(chars)
    await this.writeHandler?.(chars)
  }

  async resize(cols: number, rows: number): Promise<void> {
    this.resizes.push({ cols, rows })
  }

  async waitForRootExit() {
    return { exitCode: 0 }
  }

  async waitForTreeExit() {}

  async probeTree(): Promise<'live' | 'confirmed-exited' | 'unknown'> {
    return this.terminationResult.treeConfirmedExited ? 'confirmed-exited' : 'live'
  }

  async terminateTree(reason: TerminationReason, budget: TerminationBudget): Promise<ProcessTerminationResult> {
    this.terminationCalls.push({ reason, budget })
    if (this.terminationHandler) return this.terminationHandler(reason, budget)
    return this.terminationResult
  }

  forceTreeSync(): 'already-exited' | 'force-sent-unconfirmed' | 'deadline-exhausted' | 'failed' {
    return 'force-sent-unconfirmed'
  }
}

class FakeAttempt implements ManagedSpawnAttempt {
  readonly handle = new FakeProcess()
  readonly ready: Promise<SpawnReadyResult>
  cancelResult: ProcessTerminationResult = CONFIRMED_TERMINATION
  cancelReasons: Array<TerminationReason | 'turn-abort-before-ready'> = []
  private frames: ManagedProcessFrame[]
  private listener?: (frame: ManagedProcessFrame) => void
  private activated = false

  constructor(options: { frames?: ManagedProcessFrame[]; ready?: Promise<SpawnReadyResult> } = {}) {
    this.frames = options.frames?.slice() ?? []
    this.ready = options.ready ?? Promise.resolve({ rootPid: 1234, treeKind: 'windows-job-object' })
  }

  activate(listener: (frame: ManagedProcessFrame) => void): void {
    if (this.activated) return
    this.activated = true
    this.listener = listener
    const frames = this.frames
    this.frames = []
    for (const frame of frames) listener(frame)
  }

  discardBufferedFrames(): ManagedProcessFrame[] {
    const frames = this.frames
    this.frames = []
    return frames
  }

  async cancelBeforeReady(reason: TerminationReason | 'turn-abort-before-ready'): Promise<ProcessTerminationResult> {
    this.cancelReasons.push(reason)
    return this.cancelResult
  }

  emit(frame: ManagedProcessFrame): void {
    if (this.activated) this.listener?.(frame)
    else this.frames.push(frame)
  }
}

class FakeProvider implements ManagedShellProvider {
  readonly attempts: FakeAttempt[] = []
  readonly spawnOptions: ManagedShellSpawnOptions[] = []
  nextAttempt?: FakeAttempt
  syncError?: Error

  spawnManaged(_command: string, options: ManagedShellSpawnOptions): ManagedSpawnAttempt {
    if (this.syncError) throw this.syncError
    const attempt = this.nextAttempt ?? new FakeAttempt()
    this.nextAttempt = undefined
    this.attempts.push(attempt)
    this.spawnOptions.push(options)
    return attempt
  }
}

function origin(toolCallId: string): ShellHookOrigin {
  const hookBus = emptyHookBus()
  const snapshot = hookBus.captureToolSnapshot('shell')
  return {
    toolCallId,
    toolName: 'shell',
    effectiveArgs: { command: 'node task.js' },
    effectiveCwd: process.cwd(),
    modelId: 'test-model',
    authority: { source: 'user', peerTainted: false },
    authorityApprovedOnce: false,
    preToolUse: 'not-configured',
    hookRegistryGeneration: snapshot.generation,
    hookSnapshot: snapshot,
  }
}

function startRequest(policy: WaitPolicy, signal?: AbortSignal, tty = false): StartShellRequest {
  return {
    originToolCallId: 'call-shell',
    hookOrigin: origin('call-shell'),
    turnAbortSignal: signal,
    prepared: {
      command: 'node task.js',
      effectiveCwd: process.cwd(),
      projectCwd: process.cwd(),
      initialWait: policy,
      tty,
      maxOutputBytes: 1024,
      hookInput: { command: 'node task.js' },
    },
  }
}

function manager(
  provider: FakeProvider,
  options: { maxActiveSessions?: number; trailingOutputGraceMs?: number; completedRetentionMs?: number } = {},
) {
  return new UnifiedShellSessionManager({
    ownerSessionId: 'owner',
    projectCwd: process.cwd(),
    managerInstanceId: MANAGER_ID,
    provider,
    completedRetentionMs: options.completedRetentionMs ?? 60_000,
    trailingOutputGraceMs: options.trailingOutputGraceMs ?? 5,
    maxActiveSessions: options.maxActiveSessions,
  })
}

async function flushEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for shell manager state')
}

describe('UnifiedShellSessionManager', () => {
  it('returns a terminal lease without a shell id when a command exits inside the initial wait', async () => {
    const provider = new FakeProvider()
    provider.nextAttempt = new FakeAttempt({
      frames: [
        { kind: 'output', stream: 'stdout', chunk: Buffer.from('done\n') },
        { kind: 'stream-end', stream: 'stdout' },
        { kind: 'stream-end', stream: 'stderr' },
        { kind: 'root-exit', exitCode: 0 },
        { kind: 'tree-exit' },
      ],
    })
    const shellManager = manager(provider)
    const kinds: string[] = []
    shellManager.subscribe((event) => kinds.push(event.kind))

    const observation = await shellManager.start(startRequest({ kind: 'timed', ms: 1_000 }))

    expect(observation.kind).toBe('terminal')
    expect(observation.result.shellId).toBeUndefined()
    expect(observation.result.output).toBe('done\n')
    expect(observation.result.exitCode).toBe(0)
    expect(observation.result.treeConfirmedExited).toBe(true)
    if (observation.kind === 'terminal') observation.lease.ack()
    await flushEvents()
    expect(kinds).toEqual(['started', 'output', 'root-exited', 'exited'])
    expect(shellManager.list()).toEqual([])
  })

  it('automatically yields a live command and uses an opaque manager-scoped id', async () => {
    const provider = new FakeProvider()
    const attempt = new FakeAttempt()
    provider.nextAttempt = attempt
    const shellManager = manager(provider)
    const events: Array<{ kind: string; reason?: string }> = []
    shellManager.subscribe((event) => events.push(event))

    const observation = await shellManager.start(startRequest({ kind: 'timed', ms: 10 }))
    await flushEvents()

    expect(observation.kind).toBe('running')
    expect(observation.result.shellId).toBe(`bg_${MANAGER_ID}_1`)
    expect(observation.result.running).toBe(true)
    expect(events.some((event) => event.kind === 'yielded' && event.reason === 'deadline')).toBe(true)

    attempt.emit({ kind: 'output', stream: 'stdout', chunk: Buffer.from('incremental') })
    const read = await shellManager.interact({
      shellId: observation.result.shellId!,
      toolCallId: 'call-read',
      chars: '',
      wait: { kind: 'immediate' },
      maxOutputBytes: 1024,
    })
    expect(read.kind).toBe('running')
    expect(read.result.output).toBe('incremental')
  })

  it('writes and resizes PTY sessions under an interaction and emits transport events for immediate input', async () => {
    const provider = new FakeProvider()
    const attempt = new FakeAttempt()
    provider.nextAttempt = attempt
    const shellManager = manager(provider)
    const events: Array<{ kind: string; chars?: string; cols?: number; rows?: number }> = []
    shellManager.subscribe((event) => events.push(event))
    const started = await shellManager.start(startRequest({ kind: 'immediate' }, undefined, true))

    const interaction = await shellManager.interact({
      shellId: started.result.shellId!,
      toolCallId: 'call-input',
      chars: 'hello\n',
      resize: { cols: 120, rows: 40 },
      wait: { kind: 'immediate' },
      maxOutputBytes: 1024,
    })

    expect(interaction.kind).toBe('running')
    expect(provider.spawnOptions[0]?.tty).toBe(true)
    expect(attempt.handle.resizes).toEqual([{ cols: 120, rows: 40 }])
    expect(attempt.handle.writes).toEqual(['hello\n'])
    await flushEvents()
    expect(events.filter((event) => event.kind === 'wait-started')).toEqual([
      expect.objectContaining({ chars: 'hello\n', cols: 120, rows: 40 }),
    ])
    expect(events.filter((event) => event.kind === 'wait-finished')).toEqual([
      expect.objectContaining({ chars: 'hello\n', cols: 120, rows: 40 }),
    ])
  })

  it('keeps non-TTY stdin closed while mapping Ctrl+C to managed tree termination', async () => {
    const provider = new FakeProvider()
    const shellManager = manager(provider)
    const started = await shellManager.start(startRequest({ kind: 'immediate' }))
    const shellId = started.result.shellId!

    await expect(
      shellManager.interact({
        shellId,
        toolCallId: 'call-input',
        chars: 'hello\n',
        wait: { kind: 'immediate' },
        maxOutputBytes: 1024,
      }),
    ).rejects.toThrow(/stdin is unavailable/)

    const stopped = await shellManager.interact({
      shellId,
      toolCallId: 'call-interrupt',
      chars: '\u0003',
      wait: { kind: 'immediate' },
      maxOutputBytes: 1024,
    })
    expect(stopped.kind).toBe('terminal')
    expect(provider.attempts[0]!.handle.terminationCalls[0]?.reason).toBe('kill-tool')
    if (stopped.kind === 'terminal') stopped.lease.ack()
  })

  it('keeps the process alive when the initial wait is aborted', async () => {
    const provider = new FakeProvider()
    const attempt = new FakeAttempt()
    provider.nextAttempt = attempt
    const shellManager = manager(provider)
    const controller = new AbortController()
    const started = shellManager.start(startRequest({ kind: 'timed', ms: 5_000 }, controller.signal))
    await flushEvents()

    controller.abort()
    const observation = await started

    expect(observation.kind).toBe('running')
    expect(observation.result.waitInterrupted).toBe(true)
    expect(observation.result.shellId).toBeDefined()
    expect(attempt.handle.terminationCalls).toHaveLength(0)
    expect(shellManager.list()[0]?.yielded).toBe(true)
  })

  it('wakes a timed interaction on composite completion and orders wait-finished before exited', async () => {
    const provider = new FakeProvider()
    const attempt = new FakeAttempt()
    provider.nextAttempt = attempt
    const shellManager = manager(provider)
    const events: string[] = []
    shellManager.subscribe((event) => events.push(event.kind))
    const started = await shellManager.start(startRequest({ kind: 'immediate' }))
    const shellId = started.result.shellId!

    const waiting = shellManager.interact({
      shellId,
      toolCallId: 'call-wait',
      chars: '',
      wait: { kind: 'timed', ms: 5_000 },
      maxOutputBytes: 1024,
    })
    await flushEvents()
    attempt.emit({ kind: 'output', stream: 'stdout', chunk: Buffer.from('final') })
    attempt.emit({ kind: 'stream-end', stream: 'stdout' })
    attempt.emit({ kind: 'stream-end', stream: 'stderr' })
    attempt.emit({ kind: 'root-exit', exitCode: 0 })
    attempt.emit({ kind: 'tree-exit' })

    const observation = await waiting
    expect(observation.kind).toBe('terminal')
    expect(observation.result.output).toBe('final')
    await flushEvents()
    expect(events.indexOf('wait-started')).toBeGreaterThan(-1)
    expect(events.indexOf('wait-finished')).toBeLessThan(events.indexOf('exited'))
    if (observation.kind === 'terminal') observation.lease.ack()
  })

  it('lets trailing output finalization complete after the tree exits before stream EOF', async () => {
    const provider = new FakeProvider()
    const attempt = new FakeAttempt()
    provider.nextAttempt = attempt
    const shellManager = manager(provider, { trailingOutputGraceMs: 5 })
    const pending = shellManager.start(startRequest({ kind: 'timed', ms: 1_000 }))
    await flushEvents()

    attempt.emit({ kind: 'output', stream: 'stdout', chunk: Buffer.from('trailing') })
    attempt.emit({ kind: 'root-exit', exitCode: 0 })

    const observation = await Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('trailing finalization stalled')), 250)),
    ])
    expect(observation.kind).toBe('terminal')
    expect(observation.result.output).toBe('trailing')
    expect(observation.result.treeConfirmedExited).toBe(true)
    if (observation.kind === 'terminal') observation.lease.ack()
  })

  it('does not publish started or expose an id when spawn cleanup is confirmed', async () => {
    const provider = new FakeProvider()
    provider.nextAttempt = new FakeAttempt({ ready: Promise.reject(new Error('ENOENT')) })
    const shellManager = manager(provider)
    const events: string[] = []
    shellManager.subscribe((event) => events.push(event.kind))

    const observation = await shellManager.start(startRequest({ kind: 'timed', ms: 100 }))

    expect(observation.kind).toBe('terminal')
    expect(observation.result.isError).toBe(true)
    expect(observation.result.shellId).toBeUndefined()
    await flushEvents()
    expect(events).toEqual([])
    if (observation.kind === 'terminal') observation.lease.ack()
    expect(shellManager.list()).toEqual([])
  })

  it('promotes unconfirmed spawn cleanup to a manageable residual session', async () => {
    const provider = new FakeProvider()
    const attempt = new FakeAttempt({ ready: Promise.reject(new Error('spawn failed')) })
    attempt.cancelResult = {
      gracefulAttempted: true,
      forceAttempted: true,
      rootExited: false,
      treeConfirmedExited: false,
      failure: { code: 'termination-unconfirmed', message: 'tree still live' },
    }
    provider.nextAttempt = attempt
    const shellManager = manager(provider)
    const events: string[] = []
    shellManager.subscribe((event) => events.push(event.kind))

    const observation = await shellManager.start(startRequest({ kind: 'timed', ms: 100 }))

    expect(observation.kind).toBe('running')
    expect(observation.result.cleanupResidual).toBe(true)
    expect(observation.result.shellId).toBe(`bg_${MANAGER_ID}_1`)
    await flushEvents()
    expect(events).toEqual(['residual-registered', 'termination-failed'])
    expect(shellManager.list()[0]?.status).toBe('termination-failed')
  })

  it('does not start trailing output finalization while the managed tree is live', async () => {
    const provider = new FakeProvider()
    const attempt = new FakeAttempt()
    attempt.handle.terminationResult = {
      gracefulAttempted: true,
      forceAttempted: true,
      rootExited: true,
      treeConfirmedExited: false,
      failure: { code: 'termination-unconfirmed', message: 'tree still live' },
    }
    provider.nextAttempt = attempt
    const shellManager = manager(provider, { trailingOutputGraceMs: 5 })
    const started = await shellManager.start(startRequest({ kind: 'immediate' }))

    attempt.emit({ kind: 'root-exit', exitCode: 0 })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const current = shellManager.list().find((session) => session.shellId === started.result.shellId)
    expect(current?.treeConfirmedExited).toBe(false)
    expect(current?.outputFinalized).toBe(false)
    expect(current?.status).toBe('termination-failed')
  })

  it('rejects new sessions when every capacity slot is live', async () => {
    const provider = new FakeProvider()
    const shellManager = manager(provider, { maxActiveSessions: 2 })
    await shellManager.start(startRequest({ kind: 'immediate' }))
    await shellManager.start(startRequest({ kind: 'immediate' }))

    await expect(shellManager.start(startRequest({ kind: 'immediate' }))).rejects.toThrow(/2-session limit/)
  })

  it('creates a different runtime generation for the same logical owner', () => {
    const first = new UnifiedShellSessionManager({
      ownerSessionId: 'same-owner',
      projectCwd: process.cwd(),
      provider: new FakeProvider(),
      idFactory: () => '11111111-1111-4111-8111-111111111111',
    })
    const second = new UnifiedShellSessionManager({
      ownerSessionId: 'same-owner',
      projectCwd: process.cwd(),
      provider: new FakeProvider(),
      idFactory: () => '22222222-2222-4222-8222-222222222222',
    })
    expect(first.managerInstanceId).not.toBe(second.managerInstanceId)
  })

  it('rejects unknown ids from another manager generation', async () => {
    const shellManager = manager(new FakeProvider())
    await expect(
      shellManager.interact({
        shellId: 'bg_old_1',
        toolCallId: 'call-read',
        chars: '',
        wait: { kind: 'immediate' },
        maxOutputBytes: 1024,
      }),
    ).rejects.toThrow(/do not survive \/clear, \/resume, or CLI restart/)
  })

  it('lets dispose win the ready-to-activation race without publishing started', async () => {
    let resolveReady!: (value: SpawnReadyResult) => void
    const ready = new Promise<SpawnReadyResult>((resolve) => {
      resolveReady = resolve
    })
    const provider = new FakeProvider()
    provider.nextAttempt = new FakeAttempt({ ready })
    const shellManager = manager(provider, { trailingOutputGraceMs: 0 })
    const events: string[] = []
    shellManager.subscribe((event) => events.push(event.kind))

    const starting = shellManager.start(startRequest({ kind: 'timed', ms: 1_000 }))
    resolveReady({ rootPid: 1234, treeKind: 'windows-job-object' })
    const disposing = shellManager.dispose('clear')

    const observation = await starting
    const disposed = await disposing
    await flushEvents()

    expect(observation.kind).toBe('terminal')
    expect(events).not.toContain('started')
    expect(disposed.results.every((result) => result.treeConfirmedExited)).toBe(true)
    if (observation.kind === 'terminal') observation.lease.ack()
  })

  it('restarts terminal retention after a final observation lease is released', async () => {
    vi.useFakeTimers()
    try {
      const provider = new FakeProvider()
      provider.nextAttempt = new FakeAttempt({
        frames: [
          { kind: 'stream-end', stream: 'stdout' },
          { kind: 'stream-end', stream: 'stderr' },
          { kind: 'root-exit', exitCode: 0 },
          { kind: 'tree-exit' },
        ],
      })
      const shellManager = manager(provider, { completedRetentionMs: 100 })
      const observation = await shellManager.start(startRequest({ kind: 'timed', ms: 1_000 }))
      expect(observation.kind).toBe('terminal')
      if (observation.kind !== 'terminal') return

      await vi.advanceTimersByTimeAsync(150)
      expect(shellManager.list()).toHaveLength(1)
      observation.lease.release()
      await vi.advanceTimersByTimeAsync(99)
      expect(shellManager.list()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(shellManager.list()).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('abandons a claimed final observation and clears retention during successful dispose', async () => {
    vi.useFakeTimers()
    try {
      const provider = new FakeProvider()
      provider.nextAttempt = new FakeAttempt({
        frames: [
          { kind: 'stream-end', stream: 'stdout' },
          { kind: 'stream-end', stream: 'stderr' },
          { kind: 'root-exit', exitCode: 0 },
          { kind: 'tree-exit' },
        ],
      })
      const shellManager = manager(provider, { completedRetentionMs: 100 })
      const observation = await shellManager.start(startRequest({ kind: 'timed', ms: 1_000 }))
      expect(observation.kind).toBe('terminal')

      await shellManager.dispose('clear')
      await vi.advanceTimersByTimeAsync(100)

      expect(shellManager.list()).toHaveLength(1)
      if (observation.kind === 'terminal') {
        expect(() => observation.lease.ack()).not.toThrow()
        expect(() => observation.lease.release()).not.toThrow()
      }
      expect(shellManager.list()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('wakes an observer waiting behind a final claim when the manager is disposed', async () => {
    const provider = new FakeProvider()
    const attempt = new FakeAttempt()
    provider.nextAttempt = attempt
    const shellManager = manager(provider)
    const started = await shellManager.start(startRequest({ kind: 'immediate' }))
    const shellId = started.result.shellId!
    attempt.emit({ kind: 'stream-end', stream: 'stdout' })
    attempt.emit({ kind: 'stream-end', stream: 'stderr' })
    attempt.emit({ kind: 'root-exit', exitCode: 0 })
    attempt.emit({ kind: 'tree-exit' })

    const claimed = await shellManager.interact({
      shellId,
      toolCallId: 'call-first-observer',
      chars: '',
      wait: { kind: 'immediate' },
      maxOutputBytes: 1024,
    })
    expect(claimed.kind).toBe('terminal')
    const waiting = shellManager.interact({
      shellId,
      toolCallId: 'call-second-observer',
      chars: '',
      wait: { kind: 'immediate' },
      maxOutputBytes: 1024,
    })

    await shellManager.dispose('clear')

    await expect(waiting).rejects.toThrow(/already observed|no longer available/)
    if (claimed.kind === 'terminal') claimed.lease.ack()
  })

  it('enforces a hard timeout without requiring an output reader', async () => {
    const provider = new FakeProvider()
    const shellManager = manager(provider)
    const request = startRequest({ kind: 'immediate' })
    request.prepared.hardTimeoutMs = 10

    const started = await shellManager.start(request)
    expect(started.kind).toBe('running')
    await waitUntil(() => shellManager.list()[0]?.status === 'exited')

    const summary = shellManager.list()[0]
    expect(summary?.timedOut).toBe(true)
    expect(summary?.status).toBe('exited')
    expect(provider.attempts[0]!.handle.terminationCalls[0]?.reason).toBe('hard-timeout')
  })

  it('wakes a timed observer when manager draining starts', async () => {
    const provider = new FakeProvider()
    const shellManager = manager(provider)
    const started = await shellManager.start(startRequest({ kind: 'immediate' }))
    const waiting = shellManager.interact({
      shellId: started.result.shellId!,
      toolCallId: 'call-wait-during-drain',
      chars: '',
      wait: { kind: 'timed', ms: 5_000 },
      maxOutputBytes: 1024,
    })
    await flushEvents()

    const disposing = shellManager.dispose('clear')
    const observation = await Promise.race([
      waiting,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('manager draining did not wake wait')), 250)),
    ])

    expect(observation.kind).toBe('running')
    expect(observation.result.waitInterrupted).toBe(true)
    expect(observation.result.isError).toBe(true)
    expect((await disposing).results.every((result) => result.treeConfirmedExited)).toBe(true)
  })

  it('allows different sessions to make progress concurrently', async () => {
    const provider = new FakeProvider()
    const firstAttempt = new FakeAttempt()
    const secondAttempt = new FakeAttempt()
    provider.nextAttempt = firstAttempt
    const shellManager = manager(provider)
    const firstStarted = await shellManager.start(startRequest({ kind: 'immediate' }, undefined, true))
    provider.nextAttempt = secondAttempt
    const secondStarted = await shellManager.start(startRequest({ kind: 'immediate' }, undefined, true))

    let releaseFirstWrite!: () => void
    firstAttempt.handle.writeHandler = () =>
      new Promise<void>((resolve) => {
        releaseFirstWrite = resolve
      })

    const firstWait = shellManager.interact({
      shellId: firstStarted.result.shellId!,
      toolCallId: 'call-first-session',
      chars: 'first input',
      wait: { kind: 'immediate' },
      maxOutputBytes: 1024,
    })
    const secondWait = shellManager.interact({
      shellId: secondStarted.result.shellId!,
      toolCallId: 'call-second-session',
      chars: 'second input',
      wait: { kind: 'immediate' },
      maxOutputBytes: 1024,
    })

    await Promise.race([
      secondWait,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('second session was globally blocked')), 250),
      ),
    ])
    expect(secondAttempt.handle.writes).toEqual(['second input'])

    releaseFirstWrite()
    await firstWait
    expect(firstAttempt.handle.writes).toEqual(['first input'])
    await shellManager.dispose('manager-dispose')
  })

  it('terminates sessions in parallel and retries only an unconfirmed residual', async () => {
    const provider = new FakeProvider()
    const firstAttempt = new FakeAttempt()
    const secondAttempt = new FakeAttempt()
    provider.nextAttempt = firstAttempt
    const shellManager = manager(provider)
    await shellManager.start(startRequest({ kind: 'immediate' }))
    provider.nextAttempt = secondAttempt
    await shellManager.start(startRequest({ kind: 'immediate' }))

    let resolveFirst!: (result: ProcessTerminationResult) => void
    let resolveSecond!: (result: ProcessTerminationResult) => void
    firstAttempt.handle.terminationHandler = () =>
      new Promise<ProcessTerminationResult>((resolve) => {
        resolveFirst = resolve
      })
    secondAttempt.handle.terminationHandler = () =>
      new Promise<ProcessTerminationResult>((resolve) => {
        resolveSecond = resolve
      })

    const terminating = shellManager.terminateAll('stop-command')
    await waitUntil(() =>
      [firstAttempt, secondAttempt].every((attempt) => attempt.handle.terminationCalls.length === 1),
    )
    resolveFirst(CONFIRMED_TERMINATION)
    resolveSecond({
      gracefulAttempted: true,
      forceAttempted: true,
      rootExited: false,
      treeConfirmedExited: false,
      failure: { code: 'termination-unconfirmed', message: 'tree still live' },
    })

    const firstPass = await terminating
    expect(firstPass.requested).toBe(2)
    expect(firstPass.confirmed).toBe(1)
    expect(firstPass.results.filter((result) => !result.treeConfirmedExited)).toHaveLength(1)

    secondAttempt.handle.terminationHandler = undefined
    secondAttempt.handle.terminationResult = CONFIRMED_TERMINATION
    const retry = await shellManager.terminateAll('stop-command')

    expect(retry.requested).toBe(1)
    expect(retry.confirmed).toBe(1)
    expect(secondAttempt.handle.terminationCalls).toHaveLength(2)
  })
})
