import { createLoopState } from '../src/agent/loop-state.js'
import { createStreamAttemptControl, waitForStreamRetry } from '../src/agent/stream-retry.js'
import { streamChunksToUI } from '../src/agent/turn-stream.js'
import type { AgentCallbacks, AgentOptions } from '../src/types/index.js'

describe('stream retry timing', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not treat an event-loop delay shorter than the idle limit as a disconnect', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const control = createStreamAttemptControl(undefined, 300_000)

    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'))
    await vi.advanceTimersByTimeAsync(1000)

    expect(control.didIdleTimeout()).toBe(false)
    expect(control.signal?.aborted).toBe(false)
    control.dispose()
  })

  it('detects elapsed wall-clock idle after timers resume', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const control = createStreamAttemptControl(undefined, 300_000)

    vi.setSystemTime(new Date('2026-01-01T06:00:00Z'))
    await vi.advanceTimersByTimeAsync(1000)

    expect(control.didIdleTimeout()).toBe(true)
    expect(control.signal?.aborted).toBe(true)
    control.dispose()
  })

  it('cancels reconnect backoff immediately', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const waiting = waitForStreamRetry(30_000, controller.signal)

    controller.abort()

    await expect(waiting).resolves.toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the idle watchdog active after a tool event', async () => {
    vi.useFakeTimers()
    const control = createStreamAttemptControl(undefined, 100)
    const stream = (async function* () {
      yield { type: 'tool-call', toolCallId: 'tc-1', toolName: 'readFile', input: { filePath: 'a' } }
      await new Promise<never>((_resolve, reject) => {
        control.signal?.addEventListener('abort', () => reject(control.signal?.reason), { once: true })
      })
    })()
    const callbacks = {
      onTextDelta: vi.fn(),
      onToolCall: vi.fn(),
      onToolProgress: vi.fn(),
      onToolResult: vi.fn(),
    } as unknown as AgentCallbacks
    const consuming = streamChunksToUI(
      { stream } as never,
      callbacks,
      createLoopState(),
      {} as AgentOptions,
      { visibleText: '', toolActivity: false, receivedData: false, suppressedReplay: false },
      control,
      '',
      false,
    )
    const outcome = consuming.then(
      () => null,
      (error: unknown) => error,
    )

    await vi.advanceTimersByTimeAsync(100)

    await expect(outcome).resolves.toEqual(expect.objectContaining({ message: expect.stringMatching(/timed out/i) }))
    expect(control.didIdleTimeout()).toBe(true)
    control.dispose()
  })
})
