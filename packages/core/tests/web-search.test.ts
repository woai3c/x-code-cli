import { afterEach, describe, expect, it, vi } from 'vitest'

import { webSearch } from '../src/tools/web-search.js'

const execute = (input: { query: string; maxResults?: number }, abortSignal?: AbortSignal) =>
  webSearch.execute!(input, { toolCallId: 'test', messages: [], abortSignal } as any)

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('webSearch', () => {
  it('calls the Tavily REST API without loading its SDK', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key')
    vi.stubEnv('BRAVE_API_KEY', '')
    const mockFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        Response.json({
          results: [{ title: 'Result', url: 'https://example.com/result', content: 'Summary' }],
        }),
      ),
    )
    vi.stubGlobal('fetch', mockFetch)

    const result = (await execute({ query: 'small bundle', maxResults: 3 })) as string

    expect(result).toContain('Result')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.tavily.com/search')
    expect(init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
    })
    expect(JSON.parse(init!.body as string)).toEqual({ query: 'small bundle', max_results: 3 })
    expect(init!.signal).toBeInstanceOf(AbortSignal)
  })

  it('propagates cancellation to the Tavily request', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key')
    vi.stubEnv('BRAVE_API_KEY', '')
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
          }),
      ),
    )

    const pending = execute({ query: 'slow search' }, controller.signal)
    controller.abort()

    await expect(pending).resolves.toMatch(/abort/i)
  })
})
