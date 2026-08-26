import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resetOpenAIAuthContextForTesting } from '../src/auth/openai-chatgpt/auth-resolver.js'
import { writeOpenAIChatGPTCredentials } from '../src/auth/openai-chatgpt/credential-store.js'
import { OpenAIChatGPTTokenManager } from '../src/auth/openai-chatgpt/token-manager.js'
import { OPENAI_SESSION_ID_HEADER } from '../src/providers/cache-control.js'
import {
  OPENAI_CHATGPT_AUTH_RESPONSE_HEADER,
  OPENAI_CHATGPT_USAGE_LIMIT_HEADER,
  createOpenAIChatGPTFetch,
  transformOpenAIChatGPTRequestBody,
} from '../src/providers/openai-chatgpt-fetch.js'
import {
  getProviderModels,
  refreshOpenAIChatGPTModels,
  resetOpenAIChatGPTModelsForTesting,
} from '../src/providers/openai-chatgpt-models.js'

function sseResponse(events: unknown[], headers: Record<string, string> = {}): Response {
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream', ...headers },
  })
}

describe('OpenAI ChatGPT provider fetch', () => {
  let testHome: string

  beforeEach(async () => {
    testHome = path.join(os.tmpdir(), `x-code-chatgpt-provider-${crypto.randomUUID()}`)
    process.env.X_CODE_HOME = testHome
    process.env.OPENAI_API_KEY = 'platform-key-must-never-leak'
    resetOpenAIAuthContextForTesting()
    resetOpenAIChatGPTModelsForTesting()
    await writeOpenAIChatGPTCredentials({
      version: 1,
      accessToken: 'oauth-access',
      refreshToken: 'oauth-refresh',
      expiresAt: Date.now() + 60 * 60 * 1000,
      accountId: 'account-1',
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetOpenAIAuthContextForTesting()
    resetOpenAIChatGPTModelsForTesting()
    delete process.env.X_CODE_HOME
    delete process.env.OPENAI_API_KEY
    fs.rmSync(testHome, { recursive: true, force: true })
  })

  it('moves instructions, removes max output tokens, and loosens strict schemas', () => {
    const transformed = transformOpenAIChatGPTRequestBody(
      JSON.stringify({
        input: [
          { role: 'developer', content: 'stable system prompt' },
          { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        ],
        max_output_tokens: 16384,
        prompt_cache_key: 'session-1',
        store: true,
        reasoning: { effort: 'medium', summary: 'detailed' },
        tools: [{ type: 'function', name: 'read', strict: true }],
        text: { format: { type: 'json_schema', strict: true, schema: { type: 'object' } } },
      }),
    )
    const body = JSON.parse(transformed.body) as Record<string, any>
    expect(body.instructions).toBe('stable system prompt')
    expect(body.input).toHaveLength(1)
    expect(body.max_output_tokens).toBeUndefined()
    expect(body.store).toBe(false)
    expect(body.reasoning.summary).toBe('auto')
    expect(body.tools[0].strict).toBe(false)
    expect(body.text.format.strict).toBe(false)
    expect(body.include).toContain('reasoning.encrypted_content')
  })

  it('strips cache controls unsupported by ChatGPT while preserving the accepted cache key', () => {
    const transformed = transformOpenAIChatGPTRequestBody(
      JSON.stringify({
        input: [
          {
            role: 'developer',
            content: [
              {
                type: 'input_text',
                text: 'stable system prompt',
                prompt_cache_breakpoint: { mode: 'explicit' },
              },
            ],
          },
          { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        ],
        prompt_cache_key: 'stable-cache-key',
        prompt_cache_options: { mode: 'implicit', ttl: '30m' },
      }),
    )
    const body = JSON.parse(transformed.body) as Record<string, any>

    expect(body.instructions).toBe('stable system prompt')
    expect(body.input).toHaveLength(1)
    expect(body.input[0].role).toBe('user')
    expect(body.prompt_cache_key).toBe('stable-cache-key')
    expect(body.prompt_cache_options).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('prompt_cache_breakpoint')
  })

  it('preserves none reasoning only when the authenticated model catalog supports it', async () => {
    await refreshOpenAIChatGPTModels('test', {
      fetch: async () =>
        Response.json({
          models: [
            {
              slug: 'supports-none',
              visibility: 'list',
              supported_reasoning_levels: [{ effort: 'none' }, { effort: 'low' }],
            },
          ],
        }),
      force: true,
    })

    const supported = JSON.parse(
      transformOpenAIChatGPTRequestBody(
        JSON.stringify({ model: 'supports-none', input: [], reasoning: { effort: 'none', summary: 'detailed' } }),
      ).body as string,
    ) as Record<string, any>
    const unsupported = JSON.parse(
      transformOpenAIChatGPTRequestBody(
        JSON.stringify({ model: 'not-in-catalog', input: [], reasoning: { effort: 'none' } }),
      ).body as string,
    ) as Record<string, any>

    expect(supported.reasoning).toEqual({ effort: 'none', summary: 'auto' })
    expect(unsupported.reasoning).toBeUndefined()
  })

  it('omits reasoning summary when the authenticated model catalog rejects that parameter', async () => {
    await refreshOpenAIChatGPTModels('test', {
      fetch: async () =>
        Response.json({
          models: [
            {
              slug: 'summary-disabled',
              visibility: 'list',
              supports_reasoning_summary_parameter: false,
              supported_reasoning_levels: [{ effort: 'low' }],
            },
          ],
        }),
      force: true,
    })

    const body = JSON.parse(
      transformOpenAIChatGPTRequestBody(
        JSON.stringify({
          model: 'summary-disabled',
          input: [],
          reasoning: { effort: 'low', summary: 'detailed' },
        }),
      ).body as string,
    ) as Record<string, any>

    expect(body.reasoning).toEqual({ effort: 'low' })
  })

  it('rewrites only to the ChatGPT backend and never sends OPENAI_API_KEY', async () => {
    const transport = vi.fn<typeof fetch>(async (_input, _init) => new Response('ok', { status: 200 }))
    const chatGPTFetch = createOpenAIChatGPTFetch({
      tokenManager: new OpenAIChatGPTTokenManager(),
      fetch: transport,
      userAgent: 'x-code-cli/test',
    })

    await chatGPTFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        [OPENAI_SESSION_ID_HEADER]: 'session-1',
      },
      body: JSON.stringify({ input: [], prompt_cache_key: 'stable-cache-key' }),
    })

    expect(transport).toHaveBeenCalledOnce()
    const [url, init] = transport.mock.calls[0]!
    const headers = new Headers(init?.headers)
    expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(headers.get('authorization')).toBe('Bearer oauth-access')
    expect(headers.get('chatgpt-account-id')).toBe('account-1')
    expect(headers.get('originator')).toBe('x-code-cli')
    expect(headers.get('session-id')).toBe('session-1')
    expect(headers.get(OPENAI_SESSION_ID_HEADER)).toBeNull()
    expect(JSON.parse(String(init?.body)).prompt_cache_key).toBe('stable-cache-key')
    expect(JSON.stringify(init)).not.toContain('platform-key-must-never-leak')
  })

  it('never derives the ChatGPT session header from the prompt cache key', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response('ok'))
    const chatGPTFetch = createOpenAIChatGPTFetch({
      tokenManager: new OpenAIChatGPTTokenManager(),
      fetch: transport,
    })

    await chatGPTFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ input: [], prompt_cache_key: 'stable-cache-key' }),
    })

    expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get('session-id')).toBeNull()
  })

  it('rejects unexpected endpoints instead of falling through to Platform API', async () => {
    const transport = vi.fn<typeof fetch>(async (_input, _init) => new Response('ok'))
    const chatGPTFetch = createOpenAIChatGPTFetch({
      tokenManager: new OpenAIChatGPTTokenManager(),
      fetch: transport,
    })
    await expect(chatGPTFetch('https://api.openai.com/v1/chat/completions')).rejects.toThrow('unexpected')
    expect(transport).not.toHaveBeenCalled()
  })

  it('refreshes and replays once on 401 without falling back to OPENAI_API_KEY', async () => {
    const tokenFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'refreshed-oauth-access',
            refresh_token: 'refreshed-oauth-refresh',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const chatGPTFetch = createOpenAIChatGPTFetch({
      tokenManager: new OpenAIChatGPTTokenManager({ fetch: tokenFetch }),
      fetch: transport,
    })

    expect(
      (
        await chatGPTFetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          body: JSON.stringify({ input: [] }),
        })
      ).status,
    ).toBe(200)
    expect(tokenFetch).toHaveBeenCalledOnce()
    expect(transport).toHaveBeenCalledTimes(2)
    const retryHeaders = new Headers(transport.mock.calls[1]?.[1]?.headers)
    expect(retryHeaders.get('authorization')).toBe('Bearer refreshed-oauth-access')
    expect(JSON.stringify(transport.mock.calls)).not.toContain('platform-key-must-never-leak')
  })

  it('returns the second 401 after exactly one recovery attempt with a reliable ChatGPT marker', async () => {
    const tokenFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
    )
    const transport = vi.fn<typeof fetch>(async () => new Response('unauthorized', { status: 401 }))
    const chatGPTFetch = createOpenAIChatGPTFetch({
      tokenManager: new OpenAIChatGPTTokenManager({ fetch: tokenFetch }),
      fetch: transport,
    })

    const response = await chatGPTFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ input: [] }),
    })
    expect(response.status).toBe(401)
    expect(response.headers.get(OPENAI_CHATGPT_AUTH_RESPONSE_HEADER)).toBe('chatgpt')
    expect(transport).toHaveBeenCalledTimes(2)
    expect(tokenFetch).toHaveBeenCalledOnce()
  })

  it('refreshes and replays once when a 200 SSE response reports authentication failure', async () => {
    const tokenFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
    )
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sseResponse([
          {
            type: 'response.failed',
            response: { error: { code: 'authentication_error', message: 'authentication failed' } },
          },
        ]),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const chatGPTFetch = createOpenAIChatGPTFetch({
      tokenManager: new OpenAIChatGPTTokenManager({ fetch: tokenFetch }),
      fetch: transport,
    })

    const response = await chatGPTFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ input: [] }),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(transport).toHaveBeenCalledTimes(2)
    expect(tokenFetch).toHaveBeenCalledOnce()
  })

  it('marks and rewrites a second SSE authentication failure without retrying again', async () => {
    const tokenFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
    )
    const failure = () =>
      sseResponse([
        {
          type: 'response.failed',
          response: { error: { code: 'authentication_error', message: 'authentication failed' } },
        },
      ])
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => failure())
    const chatGPTFetch = createOpenAIChatGPTFetch({
      tokenManager: new OpenAIChatGPTTokenManager({ fetch: tokenFetch }),
      fetch: transport,
    })

    const response = await chatGPTFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ input: [] }),
    })
    const body = await response.text()
    expect(response.headers.get(OPENAI_CHATGPT_AUTH_RESPONSE_HEADER)).toBe('chatgpt')
    expect(body).toContain('"code":"401"')
    expect(transport).toHaveBeenCalledTimes(2)
    expect(tokenFetch).toHaveBeenCalledOnce()
  })

  it('makes subscription usage limits non-retryable while preserving quota headers', async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      Response.json(
        { error: { type: 'usage_limit_reached', message: 'usage_limit_reached' } },
        {
          status: 429,
          headers: {
            'retry-after': '60',
            'x-codex-primary-used-percent': '100.0',
            'x-codex-primary-reset-at': '2000000000',
          },
        },
      ),
    )
    const chatGPTFetch = createOpenAIChatGPTFetch({
      tokenManager: new OpenAIChatGPTTokenManager(),
      fetch: transport,
    })

    const response = await chatGPTFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ input: [] }),
    })
    expect(response.status).toBe(402)
    expect(response.headers.get(OPENAI_CHATGPT_USAGE_LIMIT_HEADER)).toBe('true')
    expect(response.headers.get('retry-after')).toBe('60')
    expect(response.headers.get('x-codex-primary-used-percent')).toBe('100.0')
  })

  it('makes a numeric 429 SSE subscription limit non-retryable and marks its response', async () => {
    const chatGPTFetch = createOpenAIChatGPTFetch({
      tokenManager: new OpenAIChatGPTTokenManager(),
      fetch: async () =>
        sseResponse([
          {
            type: 'response.failed',
            response: {
              error: { code: 429, type: 'usage_limit_reached', message: 'Your subscription limit has been reached' },
            },
          },
        ]),
    })

    const response = await chatGPTFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ input: [] }),
    })
    expect(response.headers.get(OPENAI_CHATGPT_USAGE_LIMIT_HEADER)).toBe('true')
    expect(await response.text()).toContain('"code":"402"')
  })

  it('refreshes the authenticated model catalog after a 200 SSE model 404', async () => {
    await refreshOpenAIChatGPTModels('test', {
      fetch: async () => Response.json({ models: [{ slug: 'before-sse-404', visibility: 'list' }] }),
      force: true,
    })
    const catalogFetch = vi.fn<typeof fetch>(async () =>
      Response.json({
        models: [
          { slug: 'before-sse-404', visibility: 'list' },
          { slug: 'after-sse-404', visibility: 'list' },
        ],
      }),
    )
    vi.stubGlobal('fetch', catalogFetch)
    const chatGPTFetch = createOpenAIChatGPTFetch({
      tokenManager: new OpenAIChatGPTTokenManager(),
      fetch: async () =>
        sseResponse([
          {
            type: 'response.failed',
            response: { error: { code: 404, message: 'The requested model was not found' } },
          },
        ]),
    })

    const response = await chatGPTFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'before-sse-404', input: [] }),
    })
    expect(catalogFetch).toHaveBeenCalledOnce()
    expect(getProviderModels().openai.map((model) => model.id)).toEqual(['openai:after-sse-404'])
    expect(await response.text()).toContain('"code":"404"')
  })

  it('preserves temporary 429 and Retry-After for the SDK retry policy', async () => {
    const chatGPTFetch = createOpenAIChatGPTFetch({
      tokenManager: new OpenAIChatGPTTokenManager(),
      fetch: async () =>
        Response.json({ error: { message: 'temporarily busy' } }, { status: 429, headers: { 'retry-after': '2' } }),
    })

    const response = await chatGPTFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ input: [] }),
    })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('2')
    expect(response.headers.get(OPENAI_CHATGPT_USAGE_LIMIT_HEADER)).toBeNull()
  })

  it('threads the caller AbortSignal to the ChatGPT backend', async () => {
    const controller = new AbortController()
    const transport = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal)
      throw init?.signal?.reason
    })
    const chatGPTFetch = createOpenAIChatGPTFetch({
      tokenManager: new OpenAIChatGPTTokenManager(),
      fetch: transport,
    })
    controller.abort(new Error('test abort'))

    await expect(
      chatGPTFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: JSON.stringify({ input: [] }),
        signal: controller.signal,
      }),
    ).rejects.toThrow('test abort')
  })

  it('requires a new login when OAuth refresh is permanently invalid even if OPENAI_API_KEY exists', async () => {
    await writeOpenAIChatGPTCredentials({
      version: 1,
      accessToken: 'expired-oauth-access',
      refreshToken: 'expired-oauth-refresh',
      expiresAt: Date.now() - 1,
      accountId: 'account-1',
    })
    const tokenFetch = vi.fn<typeof fetch>(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }))
    const transport = vi.fn<typeof fetch>()
    const chatGPTFetch = createOpenAIChatGPTFetch({
      tokenManager: new OpenAIChatGPTTokenManager({ fetch: tokenFetch }),
      fetch: transport,
    })

    await expect(
      chatGPTFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: JSON.stringify({ input: [] }),
      }),
    ).rejects.toMatchObject({ code: 'login-required', message: expect.stringContaining('xc login') })
    expect(transport).not.toHaveBeenCalled()
    expect(JSON.stringify(tokenFetch.mock.calls)).not.toContain('platform-key-must-never-leak')
  })
})
