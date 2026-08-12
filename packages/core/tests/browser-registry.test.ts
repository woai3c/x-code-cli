import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getBrowserMcp, shutdownBrowserMcp } from '../src/agent/browser/registry.js'

const { connectOneServerMock } = vi.hoisted(() => ({ connectOneServerMock: vi.fn() }))

vi.mock('../src/mcp/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/mcp/registry.js')>()
  return { ...actual, connectOneServer: connectOneServerMock }
})

function connectionResult(options: { failed?: boolean; vision?: boolean } = {}) {
  const close = vi.fn(async () => undefined)
  const onClose = vi.fn()
  const tools = [
    { name: 'browser_tabs', description: '', inputSchema: {} },
    { name: 'browser_take_screenshot', description: '', inputSchema: {} },
    ...(options.vision === false ? [] : [{ name: 'browser_mouse_click_xy', description: '', inputSchema: {} }]),
  ]
  return {
    close,
    result: {
      server: {
        name: 'browser',
        client: { close, onClose },
        status: options.failed
          ? { kind: 'failed' as const, error: 'startup aborted' }
          : { kind: 'connected' as const, toolCount: tools.length, resourceCount: 0 },
      },
      tools: options.failed ? [] : tools,
      resources: [],
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('managed browser connection lifecycle', () => {
  beforeEach(async () => {
    await shutdownBrowserMcp()
    connectOneServerMock.mockReset()
  })

  afterEach(async () => {
    await shutdownBrowserMcp()
  })

  it('reuses one stable vision-capable connection across callers', async () => {
    connectOneServerMock.mockResolvedValue(connectionResult().result)

    const first = await getBrowserMcp()
    const second = await getBrowserMcp()

    expect(first).toBe(second)
    expect(first.vision).toBe(true)
    expect(connectOneServerMock).toHaveBeenCalledTimes(1)
  })

  it('aborts a cold start when its last caller is cancelled and permits a clean retry', async () => {
    let startupSignal: AbortSignal | undefined
    connectOneServerMock.mockImplementationOnce(
      (_name, _config, _oauth, _hooks, signal: AbortSignal | undefined) =>
        new Promise((resolve) => {
          startupSignal = signal
          signal?.addEventListener('abort', () => resolve(connectionResult({ failed: true }).result), { once: true })
        }),
    )
    const caller = new AbortController()
    const pending = getBrowserMcp(caller.signal)

    caller.abort(new DOMException('cancelled by test', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(startupSignal?.aborted).toBe(true)

    connectOneServerMock.mockResolvedValueOnce(connectionResult().result)
    await expect(getBrowserMcp()).resolves.toMatchObject({ ok: true })
    expect(connectOneServerMock).toHaveBeenCalledTimes(2)
  })

  it('closes a connection that finishes after shutdown instead of caching it', async () => {
    const late = deferred<ReturnType<typeof connectionResult>['result']>()
    const firstConnection = connectionResult()
    connectOneServerMock.mockReturnValueOnce(late.promise)

    const pending = getBrowserMcp()
    const closing = shutdownBrowserMcp()
    late.resolve(firstConnection.result)

    await expect(pending).resolves.toMatchObject({ ok: false })
    await closing
    expect(firstConnection.close).toHaveBeenCalledTimes(1)

    connectOneServerMock.mockResolvedValueOnce(connectionResult().result)
    await expect(getBrowserMcp()).resolves.toMatchObject({ ok: true })
    expect(connectOneServerMock).toHaveBeenCalledTimes(2)
  })
})
