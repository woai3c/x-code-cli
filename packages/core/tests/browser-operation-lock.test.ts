import { describe, expect, it } from 'vitest'

import { withBrowserOperation } from '../src/agent/browser/operation-lock.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('browser operation lock', () => {
  it('serializes complete browser transactions in FIFO order', async () => {
    const firstCanFinish = deferred()
    const events: string[] = []

    const first = withBrowserOperation(undefined, async () => {
      events.push('first:start')
      await firstCanFinish.promise
      events.push('first:end')
    })
    const second = withBrowserOperation(undefined, async () => {
      events.push('second:start')
      events.push('second:end')
    })

    await Promise.resolve()
    expect(events).toEqual(['first:start'])
    firstCanFinish.resolve()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('removes an aborted waiter without blocking the next transaction', async () => {
    const firstCanFinish = deferred()
    const controller = new AbortController()
    const first = withBrowserOperation(undefined, () => firstCanFinish.promise)
    const aborted = withBrowserOperation(controller.signal, async () => undefined)
    const third = withBrowserOperation(undefined, async () => 'third')

    controller.abort(new DOMException('cancelled', 'AbortError'))
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    firstCanFinish.resolve()
    await first
    await expect(third).resolves.toBe('third')
  })
})
