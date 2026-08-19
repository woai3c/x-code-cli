import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveWebSearchProvider, setWebSearchModelProvider, webSearch } from '../src/tools/web-search.js'

const execute = (input: { query: string; maxResults?: number }, abortSignal?: AbortSignal) =>
  webSearch.execute!(input, { toolCallId: 'test', messages: [], abortSignal } as any)

const SEARCH_KEYS = [
  'TAVILY_API_KEY',
  'BRAVE_API_KEY',
  'EXA_API_KEY',
  'PERPLEXITY_API_KEY',
  'FIRECRAWL_API_KEY',
  'DEEPSEEK_API_KEY',
  'X_CODE_WEB_SEARCH_PROVIDER',
  'DEEPSEEK_SEARCH_BASE_URL',
] as const

function clearSearchEnv() {
  for (const key of SEARCH_KEYS) vi.stubEnv(key, '')
}

function stubFetchJson(body: unknown) {
  const mockFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(Response.json(body)),
  )
  vi.stubGlobal('fetch', mockFetch)
  return mockFetch
}

afterEach(() => {
  setWebSearchModelProvider(undefined)
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('webSearch', () => {
  it('calls the Tavily REST API without loading its SDK', async () => {
    clearSearchEnv()
    vi.stubEnv('TAVILY_API_KEY', 'test-key')
    const mockFetch = stubFetchJson({
      results: [{ title: 'Result', url: 'https://example.com/result', content: 'Summary' }],
    })

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
    clearSearchEnv()
    vi.stubEnv('TAVILY_API_KEY', 'test-key')
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

  it('prefers Tavily over other keyed providers', async () => {
    clearSearchEnv()
    vi.stubEnv('TAVILY_API_KEY', 'tavily-key')
    vi.stubEnv('BRAVE_API_KEY', 'brave-key')
    vi.stubEnv('EXA_API_KEY', 'exa-key')
    const mockFetch = stubFetchJson({ results: [] })

    await execute({ query: 'priority' })

    expect(String(mockFetch.mock.calls[0]![0])).toBe('https://api.tavily.com/search')
  })

  it('calls the Exa API with highlights enabled', async () => {
    clearSearchEnv()
    vi.stubEnv('EXA_API_KEY', 'exa-key')
    const mockFetch = stubFetchJson({
      results: [
        { url: 'https://example.com/a', title: 'A', highlights: ['snippet a'] },
        { url: 'https://example.com/b', title: 'B' },
      ],
    })

    const result = (await execute({ query: 'exa query', maxResults: 7 })) as string

    const [url, init] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.exa.ai/search')
    expect(init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer exa-key' }),
    })
    expect(JSON.parse(init!.body as string)).toEqual({
      query: 'exa query',
      type: 'auto',
      numResults: 7,
      contents: { highlights: { highlightsPerUrl: 1 } },
    })
    expect(result).toContain('snippet a')
    expect(result).toContain('https://example.com/b')
  })

  it('maps Perplexity sonar answers plus structured sources', async () => {
    clearSearchEnv()
    vi.stubEnv('PERPLEXITY_API_KEY', 'pplx-key')
    const mockFetch = stubFetchJson({
      choices: [{ message: { content: 'Synthesized answer.' } }],
      search_results: [{ url: 'https://example.com/s', title: 'S', snippet: 'snip' }],
    })

    const result = (await execute({ query: 'sonar query' })) as string

    const [url, init] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.perplexity.ai/chat/completions')
    expect(JSON.parse(init!.body as string)).toMatchObject({ model: 'sonar' })
    expect(result).toContain('Synthesized answer.')
    expect(result).toContain('https://example.com/s')
  })

  it('falls back to URL-only Perplexity citations', async () => {
    clearSearchEnv()
    vi.stubEnv('PERPLEXITY_API_KEY', 'pplx-key')
    stubFetchJson({
      choices: [{ message: { content: 'Answer.' } }],
      citations: ['https://example.com/cited'],
    })

    const result = (await execute({ query: 'q' })) as string
    expect(result).toContain('https://example.com/cited')
  })

  it('calls the Firecrawl v2 search API', async () => {
    clearSearchEnv()
    vi.stubEnv('FIRECRAWL_API_KEY', 'fc-key')
    const mockFetch = stubFetchJson({
      success: true,
      data: { web: [{ url: 'https://example.com/f', title: 'F', description: 'desc' }] },
    })

    const result = (await execute({ query: 'fc query', maxResults: 4 })) as string

    const [url, init] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.firecrawl.dev/v2/search')
    expect(init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer fc-key' }),
    })
    expect(JSON.parse(init!.body as string)).toEqual({ query: 'fc query', limit: 4 })
    expect(result).toContain('desc')
  })

  it('uses DeepSeek built-in search for deepseek models without a search key', async () => {
    clearSearchEnv()
    vi.stubEnv('DEEPSEEK_API_KEY', 'ds-key')
    setWebSearchModelProvider('deepseek')
    const mockFetch = stubFetchJson({
      content: [
        {
          type: 'text',
          text: 'Here are the results.',
          citations: [{ url: 'https://example.com/d', cited_text: 'cited snippet' }],
        },
        {
          type: 'web_search_tool_result',
          content: [
            { type: 'web_search_result', url: 'https://example.com/d', title: 'D', page_age: '2026-01-01' },
            { type: 'web_search_result', url: 'https://example.com/d', title: 'D dup' },
          ],
        },
      ],
    })

    const result = (await execute({ query: 'deepseek query' })) as string

    const [url, init] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.deepseek.com/anthropic/v1/messages')
    expect(init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'x-api-key': 'ds-key',
        Authorization: 'Bearer ds-key',
        'anthropic-version': '2023-06-01',
      }),
    })
    const body = JSON.parse(init!.body as string)
    expect(body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }])
    // Deduped by URL, snippet stitched from the text-block citation.
    expect(result).toContain('cited snippet')
    expect(result.match(/https:\/\/example\.com\/d/g)).toHaveLength(1)
  })

  it('does not use DeepSeek search for non-deepseek models', async () => {
    clearSearchEnv()
    vi.stubEnv('DEEPSEEK_API_KEY', 'ds-key')
    setWebSearchModelProvider('anthropic')

    const result = (await execute({ query: 'q' })) as string
    expect(result).toMatch(/requires a search API key/)
  })

  it('honors the X_CODE_WEB_SEARCH_PROVIDER override', async () => {
    clearSearchEnv()
    vi.stubEnv('TAVILY_API_KEY', 'tavily-key')
    vi.stubEnv('EXA_API_KEY', 'exa-key')
    vi.stubEnv('X_CODE_WEB_SEARCH_PROVIDER', 'exa')
    const mockFetch = stubFetchJson({ results: [] })

    await execute({ query: 'forced' })
    expect(String(mockFetch.mock.calls[0]![0])).toBe('https://api.exa.ai/search')
  })

  it('reports an unknown override provider', async () => {
    clearSearchEnv()
    vi.stubEnv('X_CODE_WEB_SEARCH_PROVIDER', 'nope')

    const result = (await execute({ query: 'q' })) as string
    expect(result).toMatch(/Unknown web search provider "nope"/)
  })

  it('reports a forced provider whose key is missing', async () => {
    clearSearchEnv()
    vi.stubEnv('TAVILY_API_KEY', 'tavily-key')
    vi.stubEnv('X_CODE_WEB_SEARCH_PROVIDER', 'exa')

    const result = (await execute({ query: 'q' })) as string
    expect(result).toMatch(/EXA_API_KEY is missing/)
  })

  it('prefers per-request tool context over the module-level provider', async () => {
    clearSearchEnv()
    vi.stubEnv('DEEPSEEK_API_KEY', 'ds-key')
    setWebSearchModelProvider('anthropic')
    const mockFetch = stubFetchJson({
      content: [
        {
          type: 'web_search_tool_result',
          content: [{ type: 'web_search_result', url: 'https://example.com/ctx', title: 'Ctx' }],
        },
      ],
    })

    const result = (await webSearch.execute!({ query: 'ctx wins' }, {
      toolCallId: 'test',
      messages: [],
      context: { modelProvider: 'deepseek' },
    } as any)) as string

    expect(String(mockFetch.mock.calls[0]![0])).toBe('https://api.deepseek.com/anthropic/v1/messages')
    expect(result).toContain('https://example.com/ctx')
  })

  it('includes the provider error body in failure messages', async () => {
    clearSearchEnv()
    vi.stubEnv('TAVILY_API_KEY', 'bad-key')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'Invalid API key' }), {
            status: 401,
            statusText: 'Unauthorized',
          }),
        ),
      ),
    )

    const result = (await execute({ query: 'q' })) as string
    expect(result).toMatch(/HTTP 401/)
    expect(result).toMatch(/Invalid API key/)
  })

  it('caps results at maxResults for providers without server-side limits', async () => {
    clearSearchEnv()
    vi.stubEnv('PERPLEXITY_API_KEY', 'pplx-key')
    stubFetchJson({
      search_results: Array.from({ length: 10 }, (_, i) => ({
        url: `https://example.com/${i}`,
        title: `R${i}`,
        snippet: 's',
      })),
    })

    const result = (await execute({ query: 'q', maxResults: 3 })) as string
    expect(result).toContain('https://example.com/2')
    expect(result).not.toContain('https://example.com/3')
  })

  it('errors when DeepSeek returns no search result block', async () => {
    clearSearchEnv()
    vi.stubEnv('DEEPSEEK_API_KEY', 'ds-key')
    setWebSearchModelProvider('deepseek')
    stubFetchJson({ content: [{ type: 'text', text: 'I cannot search right now.' }] })

    const result = (await execute({ query: 'q' })) as string
    expect(result).toMatch(/no web_search_tool_result block/)
  })
})

describe('resolveWebSearchProvider', () => {
  it('returns null without keys', () => {
    clearSearchEnv()
    expect(resolveWebSearchProvider('anthropic')).toBeNull()
  })

  it('resolves deepseek only for deepseek models with a key', () => {
    clearSearchEnv()
    vi.stubEnv('DEEPSEEK_API_KEY', 'ds-key')
    expect(resolveWebSearchProvider('deepseek')).toEqual({ id: 'deepseek', label: 'DeepSeek built-in search' })
    expect(resolveWebSearchProvider('openai')).toBeNull()
  })

  it('prefers keyed providers over the deepseek fallback', () => {
    clearSearchEnv()
    vi.stubEnv('DEEPSEEK_API_KEY', 'ds-key')
    vi.stubEnv('FIRECRAWL_API_KEY', 'fc-key')
    expect(resolveWebSearchProvider('deepseek')).toEqual({ id: 'firecrawl', label: 'Firecrawl' })
  })
})
