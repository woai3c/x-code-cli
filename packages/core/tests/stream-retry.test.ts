import { createStreamAttemptControl, waitForStreamRetry } from '../src/agent/stream-retry.js'

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
})
