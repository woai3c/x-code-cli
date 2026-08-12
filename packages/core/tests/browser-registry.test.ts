import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getBrowserMcp, shutdownBrowserMcp } from '../src/agent/browser/registry.js'

const { acquireBrowserProfileLeaseMock, connectOneServerMock, loadUserConfigMock } = vi.hoisted(() => ({
  acquireBrowserProfileLeaseMock: vi.fn(),
  connectOneServerMock: vi.fn(),
  loadUserConfigMock: vi.fn(),
}))

vi.mock('../src/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/index.js')>()
  return { ...actual, loadUserConfig: loadUserConfigMock }
})

vi.mock('../src/mcp/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/mcp/registry.js')>()
  return { ...actual, connectOneServer: connectOneServerMock }
})

vi.mock('../src/agent/browser/profile-lease.js', () => ({
  acquireBrowserProfileLease: acquireBrowserProfileLeaseMock,
}))

function connectionResult(options: { closedBeforeListener?: boolean; failed?: boolean; vision?: boolean } = {}) {
  const close = vi.fn(async () => undefined)
  let closeHandler: (() => void | Promise<void>) | undefined
  const onClose = vi.fn((handler: () => void | Promise<void>) => {
    if (options.closedBeforeListener) {
      void handler()
      return false
    }
    closeHandler = handler
    return true
  })
  const callTool = vi.fn(async (_name: string, args: { code?: string }) => {
    const marker = /__X_CODE_VISUAL_TAB_(?:PREPARED|OWNED)__:owner-1/.exec(args.code ?? '')?.[0]
    if (marker) return { text: `### Result\n${JSON.stringify(marker)}`, isError: false }
    const cleanup = '__X_CODE_VISUAL_TAB_CLEANUP__:owner-1:' + JSON.stringify({ closed: true, originalIndex: 1 })
    return { text: `### Result\n${JSON.stringify(cleanup)}`, isError: false }
  })
  const tools = [
    { name: 'browser_tabs', description: '', inputSchema: {} },
    { name: 'browser_take_screenshot', description: '', inputSchema: {} },
    { name: 'browser_run_code_unsafe', description: '', inputSchema: {} },
    ...(options.vision === false ? [] : [{ name: 'browser_mouse_click_xy', description: '', inputSchema: {} }]),
  ]
  return {
    close,
    disconnect: async () => closeHandler?.(),
    result: {
      server: {
        name: 'browser',
        client: { callTool, close, onClose },
        stderrTail: undefined as string | undefined,
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
  let releaseProfile: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    await shutdownBrowserMcp()
    connectOneServerMock.mockReset()
    loadUserConfigMock.mockReset()
    acquireBrowserProfileLeaseMock.mockReset()
    loadUserConfigMock.mockReturnValue({})
    releaseProfile = vi.fn(async () => undefined)
    acquireBrowserProfileLeaseMock.mockResolvedValue({ release: releaseProfile })
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
    expect(acquireBrowserProfileLeaseMock).toHaveBeenCalledTimes(1)
    expect(releaseProfile).not.toHaveBeenCalled()
  })

  it('keeps raw Playwright code private while exposing fixed Page lifecycle helpers', async () => {
    const connection = connectionResult()
    connectOneServerMock.mockResolvedValue(connection.result)

    const browser = await getBrowserMcp()
    expect(browser.registry.list().some((tool) => tool.rawName === 'browser_run_code_unsafe')).toBe(false)
    await expect(browser.prepareVisualCheck('owner-1')).resolves.toBe(true)
    await expect(browser.markVisualCheckTab('owner-1', 'http://localhost:5173/')).resolves.toBe(true)
    await expect(browser.finishVisualCheck('owner-1')).resolves.toEqual({ closed: true, originalTabIndex: 1 })
    expect(connection.result.server.client.callTool).toHaveBeenNthCalledWith(
      1,
      'browser_run_code_unsafe',
      { code: expect.stringMatching(/context\[originalKey\] = page/) },
      undefined,
    )
    expect(connection.result.server.client.callTool).toHaveBeenNthCalledWith(
      2,
      'browser_run_code_unsafe',
      {
        code: expect.stringMatching(
          /page === original[\s\S]*context\[Symbol\.for[\s\S]*page\[Symbol\.for[\s\S]*page\.goto\("http:\/\/localhost:5173\/"[\s\S]*loopback\.test\(page\.url\(\)\)/,
        ),
      },
      undefined,
    )
    expect(connection.result.server.client.callTool).toHaveBeenNthCalledWith(
      3,
      'browser_run_code_unsafe',
      { code: expect.stringMatching(/temporary\.close\(\)/) },
      undefined,
    )
    expect(connection.result.server.client.callTool).toHaveBeenNthCalledWith(
      3,
      'browser_run_code_unsafe',
      { code: expect.stringMatching(/pages\.indexOf\(original\)/) },
      undefined,
    )
  })

  it('sanitizes startup stderr before returning it to the model', async () => {
    const connection = connectionResult({ failed: true })
    connection.result.server.status = {
      kind: 'failed',
      error: '\u001b[31mstartup failed\u001b[0m Authorization: Bearer secret-token',
    }
    connection.result.server.stderrTail = 'https://localhost/fail?access_token=private-value'
    connectOneServerMock.mockResolvedValue(connection.result)

    const browser = await getBrowserMcp()

    expect(browser.ok).toBe(false)
    expect(browser.error).not.toContain('\u001b')
    expect(browser.error).not.toContain('secret-token')
    expect(browser.error).not.toContain('private-value')
    expect(browser.error).toContain('[REDACTED]')
  })

  it('sanitizes an exception thrown before the browser server returns', async () => {
    connectOneServerMock.mockRejectedValueOnce(
      new Error('\u001b[31mspawn failed\u001b[0m https://localhost/?api_key=private-value'),
    )

    const browser = await getBrowserMcp()

    expect(browser.ok).toBe(false)
    expect(browser.error).not.toContain('\u001b')
    expect(browser.error).not.toContain('private-value')
    expect(browser.error).toContain('[REDACTED]')
  })

  it('holds the default profile lease for the connection lifetime and releases it on shutdown', async () => {
    connectOneServerMock.mockResolvedValue(connectionResult().result)

    await expect(getBrowserMcp()).resolves.toMatchObject({ ok: true })
    expect(releaseProfile).not.toHaveBeenCalled()

    await shutdownBrowserMcp()
    expect(releaseProfile).toHaveBeenCalledTimes(1)
  })

  it('invalidates the cache and reconnects when the live browser connection drops', async () => {
    const firstConnection = connectionResult()
    const secondConnection = connectionResult()
    connectOneServerMock.mockResolvedValueOnce(firstConnection.result).mockResolvedValueOnce(secondConnection.result)

    const first = await getBrowserMcp()
    await firstConnection.disconnect()
    const second = await getBrowserMcp()

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(second).not.toBe(first)
    expect(connectOneServerMock).toHaveBeenCalledTimes(2)
    expect(releaseProfile).toHaveBeenCalledTimes(1)
  })

  it('does not cache a connection that closed before the lifecycle listener attached', async () => {
    const staleConnection = connectionResult({ closedBeforeListener: true })
    const freshConnection = connectionResult()
    connectOneServerMock.mockResolvedValueOnce(staleConnection.result).mockResolvedValueOnce(freshConnection.result)

    await expect(getBrowserMcp()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/closed during startup/),
    })
    await expect(getBrowserMcp()).resolves.toMatchObject({ ok: true })

    expect(staleConnection.close).toHaveBeenCalledTimes(1)
    expect(connectOneServerMock).toHaveBeenCalledTimes(2)
    expect(acquireBrowserProfileLeaseMock).toHaveBeenCalledTimes(2)
  })

  it('fails before spawning when another xc process owns the persistent profile', async () => {
    acquireBrowserProfileLeaseMock.mockRejectedValueOnce(new Error('managed browser profile is already in use'))

    await expect(getBrowserMcp()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/already in use/),
    })
    expect(connectOneServerMock).not.toHaveBeenCalled()
  })

  it('does not impose the default profile lease on a custom browser server command', async () => {
    loadUserConfigMock.mockReturnValue({ browser: { command: 'custom-browser-mcp', args: ['--stdio'] } })
    connectOneServerMock.mockResolvedValue(connectionResult().result)

    await expect(getBrowserMcp()).resolves.toMatchObject({ ok: true })
    expect(acquireBrowserProfileLeaseMock).not.toHaveBeenCalled()
    expect(connectOneServerMock.mock.calls[0]?.[1]).toMatchObject({
      command: 'custom-browser-mcp',
      args: ['--stdio'],
    })
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
