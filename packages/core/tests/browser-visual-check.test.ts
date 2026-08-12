import { beforeEach, describe, expect, it, vi } from 'vitest'

import { normalizeLocalBrowserUrl, runBrowserVisualCheck } from '../src/agent/browser/visual-check.js'

const { getBrowserMcpMock } = vi.hoisted(() => ({ getBrowserMcpMock: vi.fn() }))

vi.mock('../src/agent/browser/registry.js', () => ({
  getBrowserMcp: getBrowserMcpMock,
}))

function mcpResult(text = 'ok', images?: Array<{ data: string; mediaType: string }>) {
  return { text, images, isError: false }
}

function browserWith(callTool: ReturnType<typeof vi.fn>) {
  const rawNames = [
    'browser_tabs',
    'browser_evaluate',
    'browser_resize',
    'browser_wait_for',
    'browser_take_screenshot',
    'browser_console_messages',
  ]
  return {
    ok: true,
    registry: {
      list: () =>
        rawNames.map((rawName) => ({
          rawName,
          callableName: `browser__${rawName}`,
          serverName: 'browser',
          description: '',
          inputSchema: {},
        })),
      callTool,
    },
    permissions: {},
    toolCount: rawNames.length,
    vision: true,
  }
}

const LISTED_TABS = '### Open tabs\n- 0: (current) [Existing](https://example.test/)'
const OPENED_TABS =
  '### Open tabs\n- 0: [Existing](https://example.test/)\n- 1: (current) [Local](http://localhost:5173/dashboard)'

function evaluatedUrl(url: string): string {
  return `### Result\n"__X_CODE_VISUAL_URL__:${url}"`
}

describe('normalizeLocalBrowserUrl', () => {
  it('accepts local dev-server URLs and fills in the HTTP scheme', () => {
    expect(normalizeLocalBrowserUrl('localhost:5173/settings')).toBe('http://localhost:5173/settings')
    expect(normalizeLocalBrowserUrl('https://127.0.0.1:3000/')).toBe('https://127.0.0.1:3000/')
    expect(normalizeLocalBrowserUrl('http://[::1]:8080/')).toBe('http://[::1]:8080/')
  })

  it('rejects external sites, local files, and embedded credentials', () => {
    expect(() => normalizeLocalBrowserUrl('https://example.com')).toThrow(/localhost or loopback/)
    expect(() => normalizeLocalBrowserUrl('file:///tmp/app.html')).toThrow(/localhost or loopback/)
    expect(() => normalizeLocalBrowserUrl('http://user:pass@localhost:3000')).toThrow(/Credentials/)
  })
})

describe('runBrowserVisualCheck', () => {
  beforeEach(() => {
    getBrowserMcpMock.mockReset()
  })

  it('keeps intermediate page snapshots out of the result and forwards the abort signal', async () => {
    const image = { data: 'JPEG_BASE64', mediaType: 'image/jpeg' }
    const hugeSnapshot = 'ACCESSIBILITY TREE '.repeat(1_000)
    const callTool = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name.endsWith('browser_tabs')) {
        if (input.action === 'list') return mcpResult(LISTED_TABS)
        if (input.action === 'new') return mcpResult(OPENED_TABS)
        return mcpResult('tab restored')
      }
      if (name.endsWith('browser_evaluate')) return mcpResult(evaluatedUrl('http://localhost:5173/dashboard'))
      if (name.endsWith('browser_take_screenshot')) return mcpResult('screenshot metadata', [image])
      if (name.endsWith('browser_console_messages')) return mcpResult('Error: failed to load /missing.svg')
      return mcpResult(hugeSnapshot)
    })
    getBrowserMcpMock.mockResolvedValue(browserWith(callTool))
    const controller = new AbortController()

    const result = await runBrowserVisualCheck(
      {
        url: 'localhost:5173/dashboard',
        waitMs: 750,
        viewport: { width: 1_024, height: 768 },
      },
      { abortSignal: controller.signal },
    )

    expect(getBrowserMcpMock).toHaveBeenCalledWith(controller.signal)
    expect(callTool.mock.calls.map(([name]) => name)).toEqual([
      'browser__browser_tabs',
      'browser__browser_tabs',
      'browser__browser_resize',
      'browser__browser_wait_for',
      'browser__browser_evaluate',
      'browser__browser_take_screenshot',
      'browser__browser_console_messages',
      'browser__browser_evaluate',
      'browser__browser_tabs',
      'browser__browser_tabs',
      'browser__browser_tabs',
    ])
    expect(callTool).toHaveBeenNthCalledWith(
      2,
      'browser__browser_tabs',
      {
        action: 'new',
        url: 'http://localhost:5173/dashboard',
      },
      controller.signal,
    )
    expect(callTool).toHaveBeenNthCalledWith(4, 'browser__browser_wait_for', { time: 0.75 }, controller.signal)
    expect(callTool).toHaveBeenNthCalledWith(
      6,
      'browser__browser_take_screenshot',
      { type: 'jpeg', scale: 'css' },
      controller.signal,
    )
    expect(callTool.mock.calls[9]?.slice(0, 2)).toEqual(['browser__browser_tabs', { action: 'close', index: 1 }])
    expect(callTool.mock.calls[10]?.slice(0, 2)).toEqual(['browser__browser_tabs', { action: 'select', index: 0 }])
    expect(result.images).toEqual([image])
    expect(result.text).toContain('Error: failed to load /missing.svg')
    expect(result.text).toContain('isolated temporary tab')
    expect(result.text).not.toContain('ACCESSIBILITY TREE')
  })

  it('fails clearly when the browser cannot return an inline screenshot', async () => {
    const callTool = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name.endsWith('browser_tabs')) {
        if (input.action === 'list') return mcpResult(LISTED_TABS)
        if (input.action === 'new') return mcpResult(OPENED_TABS)
      }
      if (name.endsWith('browser_evaluate')) return mcpResult(evaluatedUrl('http://localhost:3000/'))
      return mcpResult('ok')
    })
    getBrowserMcpMock.mockResolvedValue(browserWith(callTool))

    await expect(runBrowserVisualCheck({ url: 'http://localhost:3000', waitMs: 0 }, {})).rejects.toThrow(
      /no inline image/,
    )
    expect(callTool.mock.calls.some(([, input]) => input.action === 'close')).toBe(true)
    expect(callTool.mock.calls.some(([, input]) => input.action === 'select')).toBe(true)
  })

  it('rejects a final external redirect before returning the screenshot and restores the original tab', async () => {
    const callTool = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name.endsWith('browser_tabs')) {
        if (input.action === 'list') return mcpResult(LISTED_TABS)
        if (input.action === 'new') return mcpResult(OPENED_TABS)
      }
      if (name.endsWith('browser_evaluate')) return mcpResult(evaluatedUrl('https://accounts.example.test/private'))
      if (name.endsWith('browser_take_screenshot')) {
        return mcpResult('should not run', [{ data: 'PRIVATE', mediaType: 'image/jpeg' }])
      }
      return mcpResult('ok')
    })
    getBrowserMcpMock.mockResolvedValue(browserWith(callTool))

    await expect(runBrowserVisualCheck({ url: 'http://localhost:3000', waitMs: 0 }, {})).rejects.toThrow(
      /redirected outside/,
    )
    expect(callTool.mock.calls.some(([name]) => name.endsWith('browser_take_screenshot'))).toBe(false)
    expect(callTool.mock.calls.some(([, input]) => input.action === 'close')).toBe(true)
    expect(callTool.mock.calls.some(([, input]) => input.action === 'select')).toBe(true)
  })

  it('discards an already-captured image when a delayed redirect leaves loopback', async () => {
    let urlChecks = 0
    const callTool = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name.endsWith('browser_tabs')) {
        if (input.action === 'list') return mcpResult(LISTED_TABS)
        if (input.action === 'new') return mcpResult(OPENED_TABS)
      }
      if (name.endsWith('browser_evaluate')) {
        urlChecks++
        return mcpResult(
          evaluatedUrl(urlChecks === 1 ? 'http://localhost:3000/' : 'https://accounts.example.test/private'),
        )
      }
      if (name.endsWith('browser_take_screenshot')) {
        return mcpResult('captured', [{ data: 'PRIVATE', mediaType: 'image/jpeg' }])
      }
      return mcpResult('ok')
    })
    getBrowserMcpMock.mockResolvedValue(browserWith(callTool))

    await expect(runBrowserVisualCheck({ url: 'http://localhost:3000', waitMs: 0 }, {})).rejects.toThrow(
      /redirected outside/,
    )
    expect(callTool.mock.calls.filter(([name]) => name.endsWith('browser_take_screenshot'))).toHaveLength(1)
    expect(callTool.mock.calls.some(([, input]) => input.action === 'close')).toBe(true)
  })
})
