import { ShellSessionEventHub } from '../src/tools/shell-session/event-hub.js'
import { ActivationFrameBuffer } from '../src/tools/shell-session/providers/activation-frames.js'
import type { ShellSessionSummary } from '../src/tools/shell-session/types.js'
import { AsyncMutex, VersionedAsyncSignal } from '../src/tools/shell-session/wait-notifier.js'

function summary(shellId = 'bg_manager_1'): ShellSessionSummary {
  return {
    managerInstanceId: 'manager',
    ownerSessionId: 'owner',
    shellId,
    originToolCallId: 'call-1',
    command: 'node task.js',
    effectiveCwd: 'C:\\project',
    tty: false,
    status: 'running',
    yielded: true,
    spawnOutcome: 'ready',
    cleanupResidual: false,
    spawnRequestedAt: 1,
    startedAt: 2,
    rootExited: false,
    treeConfirmedExited: false,
    outputFinalized: false,
    timedOut: false,
    recentOutput: '',
    omittedBytes: 0,
    uiOmittedBytes: 0,
  }
}

describe('VersionedAsyncSignal', () => {
  it('wakes every current waiter with the next generation', async () => {
    const signal = new VersionedAsyncSignal('initial')
    const first = signal.waitAfter(0)
    const second = signal.waitAfter(0)

    signal.notify('ready')

    await expect(first).resolves.toEqual({ generation: 1, value: 'ready' })
    await expect(second).resolves.toEqual({ generation: 1, value: 'ready' })
  })

  it('returns immediately when the observed generation is stale', async () => {
    const signal = new VersionedAsyncSignal('initial')
    signal.notify('changed')
    await expect(signal.waitAfter(0)).resolves.toEqual({ generation: 1, value: 'changed' })
  })

  it('removes disposable race losers instead of accumulating waiters', async () => {
    const output = new VersionedAsyncSignal('initial')
    const lifecycle = new VersionedAsyncSignal('initial')

    for (let index = 0; index < 100; index++) {
      const outputWake = output.waitAfterDisposable(output.generation)
      const lifecycleWake = lifecycle.waitAfterDisposable(lifecycle.generation)
      output.notify(`output-${index}`)
      await outputWake.promise
      outputWake.dispose()
      lifecycleWake.dispose()
      await lifecycleWake.promise
    }

    expect(output.pendingWaiterCount).toBe(0)
    expect(lifecycle.pendingWaiterCount).toBe(0)
  })
})

describe('AsyncMutex', () => {
  it('serializes whole asynchronous operations', async () => {
    const mutex = new AsyncMutex()
    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = mutex.runExclusive(async () => {
      order.push('first-start')
      await firstGate
      order.push('first-end')
    })
    const second = mutex.runExclusive(async () => {
      order.push('second')
    })

    await Promise.resolve()
    expect(order).toEqual(['first-start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })
})

describe('ActivationFrameBuffer', () => {
  it('retains a byte-bounded head and tail without dropping ordered control frames', () => {
    const buffer = new ActivationFrameBuffer()
    const frames: Array<{ kind: string; chunk?: Uint8Array }> = []
    buffer.push({ kind: 'output', stream: 'stdout', chunk: Buffer.from(`head-${'a'.repeat(600 * 1024)}`) })
    buffer.push({ kind: 'root-exit', exitCode: 0 })
    buffer.push({ kind: 'output', stream: 'stdout', chunk: Buffer.from(`${'b'.repeat(600 * 1024)}-tail`) })

    buffer.activate((frame) => frames.push(frame))

    const output = Buffer.concat(
      frames.filter((frame) => frame.kind === 'output').map((frame) => frame.chunk!),
    ).toString('utf8')
    expect(output).toContain('head-')
    expect(output).toContain('-tail')
    expect(output).toMatch(/bytes omitted before shell activation/)
    expect(frames.filter((frame) => frame.kind === 'root-exit')).toHaveLength(1)
    expect(frames.findIndex((frame) => frame.kind === 'root-exit')).toBeGreaterThan(0)
    expect(
      frames
        .filter((frame) => frame.kind === 'output')
        .reduce((total, frame) => total + (frame.chunk?.byteLength ?? 0), 0),
    ).toBeLessThan(1024 * 1024 + 128)
  })

  it('normalizes split UTF-8 input before applying activation truncation', () => {
    const buffer = new ActivationFrameBuffer()
    const bytes = Buffer.from('中文', 'utf8')
    const output: Buffer[] = []
    buffer.push({ kind: 'output', stream: 'stdout', chunk: bytes.subarray(0, 2) })
    buffer.push({ kind: 'output', stream: 'stdout', chunk: bytes.subarray(2) })
    buffer.activate((frame) => {
      if (frame.kind === 'output') output.push(Buffer.from(frame.chunk))
    })

    expect(Buffer.concat(output).toString('utf8')).toBe('中文')
  })
})

describe('ShellSessionEventHub', () => {
  it('delivers replay snapshot before later events in one ordered stream', async () => {
    const events: Array<{ kind: string; seq: number }> = []
    const hub = new ShellSessionEventHub('owner', 'manager', () => [summary()])
    hub.subscribe((event) => events.push(event), { replayCurrent: true })
    hub.publish({
      kind: 'yielded',
      shellId: 'bg_manager_1',
      yieldAfterMs: 10_000,
      reason: 'deadline',
    })

    await hub.drain()

    expect(events.map((event) => event.kind)).toEqual(['snapshot', 'yielded'])
    expect(events[0]!.seq).toBe(0)
    expect(events[1]!.seq).toBe(1)
  })

  it('isolates listener failures and stops delivery after unsubscribe', async () => {
    const received: string[] = []
    const hub = new ShellSessionEventHub('owner', 'manager', () => [])
    hub.subscribe(() => {
      throw new Error('listener failed')
    })
    const unsubscribe = hub.subscribe((event) => received.push(event.kind))
    hub.publish({ kind: 'wait-started', shellId: 'bg_manager_1', toolCallId: 'call-2', chars: '' })
    await hub.drain()
    unsubscribe()
    hub.publish({ kind: 'wait-finished', shellId: 'bg_manager_1', toolCallId: 'call-2', chars: '', running: true })
    await hub.drain()

    expect(received).toEqual(['wait-started'])
  })

  it('sanitizes output and bounds pending output without dropping control events', async () => {
    const events: Array<{ kind: string; seq: number; chunk?: string; omittedBytesBefore?: number }> = []
    const hub = new ShellSessionEventHub('owner', 'manager', () => [])
    hub.subscribe((event) => events.push(event))

    hub.publish({ kind: 'output', shellId: 'bg_manager_1', stream: 'stdout', chunk: '\u001B]0;owned\u0007ok' })
    for (let index = 0; index < 48; index++) {
      hub.publish({ kind: 'output', shellId: 'bg_manager_1', stream: 'stdout', chunk: 'x'.repeat(8192) })
    }
    const exited = hub.publish({
      kind: 'exited',
      shellId: 'bg_manager_1',
      exitCode: 0,
      durationMs: 10,
      wasYielded: true,
      timedOut: false,
      terminationConfirmed: true,
      spawnOutcome: 'ready',
      cleanupResidual: false,
      rootExited: true,
      treeConfirmedExited: true,
      recentOutput: 'ok',
      uiOmittedBytes: 0,
    })

    expect(hub.pendingOutputByteLength).toBeLessThanOrEqual(256 * 1024)
    expect(hub.pendingOutputEventCount).toBeLessThanOrEqual(16)
    expect(hub.omittedBytesFor('bg_manager_1')).toBeGreaterThan(0)

    await hub.drain()

    expect(events.at(-1)?.kind).toBe('exited')
    expect(events.at(-1)?.seq).toBe(exited.seq)
    expect(events.filter((event) => event.kind === 'output').length).toBeLessThanOrEqual(16)
    expect(events.some((event) => event.chunk?.includes('\u001B'))).toBe(false)
    expect(events.some((event) => (event.omittedBytesBefore ?? 0) > 0)).toBe(true)
  })

  it('splits output events at UTF-8 boundaries and never exceeds 8 KiB per event', async () => {
    const chunks: string[] = []
    const hub = new ShellSessionEventHub('owner', 'manager', () => [])
    hub.subscribe((event) => {
      if (event.kind === 'output') chunks.push(event.chunk)
    })
    const output = '中'.repeat(4000)
    hub.publish({ kind: 'output', shellId: 'bg_manager_1', stream: 'stdout', chunk: output })
    await hub.drain()

    expect(chunks.join('')).toBe(output)
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 8 * 1024)).toBe(true)
    expect(chunks.join('')).not.toContain('\uFFFD')
  })
})
