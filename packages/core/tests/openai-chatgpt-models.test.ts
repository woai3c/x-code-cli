import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getContextWindow, getMaxOutputTokens } from '../src/agent/context-window.js'
import {
  initializeOpenAIAuthContext,
  resetOpenAIAuthContextForTesting,
} from '../src/auth/openai-chatgpt/auth-resolver.js'
import { writeOpenAIChatGPTCredentials } from '../src/auth/openai-chatgpt/credential-store.js'
import { setOpenAIChatGPTTokenManagerForTesting } from '../src/auth/openai-chatgpt/token-manager.js'
import { OpenAIChatGPTAuthError } from '../src/auth/openai-chatgpt/types.js'
import { modelSupportsVision } from '../src/providers/capabilities.js'
import {
  getOpenAIChatGPTModelCatalogState,
  getOpenAIChatGPTReasoningTiers,
  getOpenAIChatGPTRuntimeModel,
  getProviderModels,
  refreshOpenAIChatGPTModels,
  refreshOpenAIChatGPTModelsAfterNotFound,
  resetOpenAIChatGPTModelsForTesting,
} from '../src/providers/openai-chatgpt-models.js'
import { getReasoningLevel } from '../src/providers/thinking.js'

describe('OpenAI ChatGPT model catalog', () => {
  let testHome: string

  beforeEach(async () => {
    testHome = path.join(os.tmpdir(), `x-code-chatgpt-models-${crypto.randomUUID()}`)
    process.env.X_CODE_HOME = testHome
    delete process.env.OPENAI_API_KEY
    resetOpenAIAuthContextForTesting()
    resetOpenAIChatGPTModelsForTesting()
    setOpenAIChatGPTTokenManagerForTesting(undefined)
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
    setOpenAIChatGPTTokenManagerForTesting(undefined)
    delete process.env.X_CODE_HOME
    fs.rmSync(testHome, { recursive: true, force: true })
  })

  it('uses the authenticated server catalog for the existing openai provider id', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, _init) =>
        new Response(
          JSON.stringify({
            models: [
              {
                slug: 'gpt-test-subscription',
                display_name: 'GPT Test Subscription',
                description: 'test model',
                input_modalities: ['text', 'image'],
                context_window: 321000,
                default_reasoning_level: 'ultra',
                supports_reasoning_summary_parameter: false,
                supported_reasoning_levels: [
                  { effort: 'low', description: 'Fast' },
                  { effort: 'max', description: 'Deep' },
                  { effort: 'ultra', description: 'Deepest' },
                ],
                visibility: 'list',
                priority: 1,
              },
              { slug: 'hidden-model', visibility: 'hide', priority: 0 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )

    await refreshOpenAIChatGPTModels('test', { fetch: fetchMock, force: true })
    expect(getProviderModels().openai.map((model) => model.id)).toEqual(['openai:gpt-test-subscription'])
    expect(getOpenAIChatGPTRuntimeModel('openai:gpt-test-subscription')).toMatchObject({
      vision: true,
      contextWindow: 321000,
      defaultReasoningLevel: 'ultra',
      supportsReasoningSummaryParameter: false,
    })
    expect(getOpenAIChatGPTReasoningTiers('openai:gpt-test-subscription')).toEqual([
      { label: 'Low', value: 'low', description: 'Fast' },
      { label: 'Max', value: 'max', description: 'Deep' },
      { label: 'Ultra', value: 'ultra', description: 'Deepest' },
    ])
    expect(getReasoningLevel('openai:gpt-test-subscription', false, 'max')).toBe('max')
    expect(getReasoningLevel('openai:gpt-test-subscription', false, 'ultra')).toBe('ultra')
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer oauth-access')
    expect(headers.get('chatgpt-account-id')).toBe('account-1')
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('client_version=0.144.0')
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('client_version=test')
  })

  it('invalidates a fresh cache created for an older Codex compatibility version', async () => {
    const target = path.join(testHome, 'cache', 'openai-chatgpt-models.json')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(
      target,
      JSON.stringify({
        accountKey: createHash('sha256').update('account-1').digest('hex'),
        codexCompatibilityVersion: '0.5.2',
        fetchedAt: Date.now(),
        models: [
          {
            id: 'openai:stale-model',
            label: 'Stale model',
            description: 'must be refreshed',
            vision: true,
          },
        ],
      }),
    )
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ models: [{ slug: 'current-model', visibility: 'list' }] }),
    )

    const models = await refreshOpenAIChatGPTModels('test', { fetch: fetchMock })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(models.map((model) => model.id)).toEqual(['openai:current-model'])
  })

  it('isolates the disk and memory catalog by signed-in ChatGPT account', async () => {
    const accountAFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ models: [{ slug: 'account-a-model', visibility: 'list' }] }),
    )
    await refreshOpenAIChatGPTModels('test', { fetch: accountAFetch, force: true })
    expect(getProviderModels().openai.map((model) => model.id)).toEqual(['openai:account-a-model'])

    await writeOpenAIChatGPTCredentials({
      version: 1,
      accessToken: 'oauth-access-b',
      refreshToken: 'oauth-refresh-b',
      expiresAt: Date.now() + 60 * 60 * 1000,
      accountId: 'account-2',
    })
    const accountBFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ models: [{ slug: 'account-b-model', visibility: 'list' }] }),
    )
    await refreshOpenAIChatGPTModels('test', { fetch: accountBFetch })

    expect(accountBFetch).toHaveBeenCalledOnce()
    expect(getProviderModels().openai.map((model) => model.id)).toEqual(['openai:account-b-model'])
  })

  it('uses a fresh same-account disk cache without a network request', async () => {
    await refreshOpenAIChatGPTModels('test', {
      fetch: async () => Response.json({ models: [{ slug: 'cached-model', visibility: 'list' }] }),
      force: true,
    })
    resetOpenAIChatGPTModelsForTesting()
    const offlineFetch = vi.fn<typeof fetch>()

    const models = await refreshOpenAIChatGPTModels('test', { fetch: offlineFetch })
    expect(models.map((model) => model.id)).toEqual(['openai:cached-model'])
    expect(offlineFetch).not.toHaveBeenCalled()
  })

  it('coalesces concurrent background refreshes into one model request', async () => {
    let finishRequest: (() => void) | undefined
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((resolve) => {
          finishRequest = () => resolve(Response.json({ models: [{ slug: 'preloaded-model', visibility: 'list' }] }))
        }),
    )

    const first = refreshOpenAIChatGPTModels('test', { fetch: fetchMock })
    const second = refreshOpenAIChatGPTModels('test', { fetch: fetchMock })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    finishRequest!()

    const [firstModels, secondModels] = await Promise.all([first, second])
    expect(firstModels).toEqual(secondModels)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('coalesces concurrent forced refreshes instead of letting stale responses race', async () => {
    let finishRequest: (() => void) | undefined
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((resolve) => {
          finishRequest = () => resolve(Response.json({ models: [{ slug: 'forced-model', visibility: 'list' }] }))
        }),
    )

    const first = refreshOpenAIChatGPTModels('test', { fetch: fetchMock, force: true })
    const second = refreshOpenAIChatGPTModels('test', { fetch: fetchMock, force: true })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    finishRequest!()

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.arrayContaining([expect.objectContaining({ id: 'openai:forced-model' })]),
      expect.arrayContaining([expect.objectContaining({ id: 'openai:forced-model' })]),
    ])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('does not collapse a forced refresh into an in-flight background refresh', async () => {
    let finishBackgroundRequest: (() => void) | undefined
    const refreshFetch = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((resolve) => {
          if (refreshFetch.mock.calls.length === 1) {
            finishBackgroundRequest = () =>
              resolve(Response.json({ models: [{ slug: 'background-model', visibility: 'list' }] }))
            return
          }
          resolve(Response.json({ models: [{ slug: 'forced-model', visibility: 'list' }] }))
        }),
    )
    const background = refreshOpenAIChatGPTModels('test', { fetch: refreshFetch })
    await vi.waitFor(() => expect(refreshFetch).toHaveBeenCalledOnce())
    const forced = refreshOpenAIChatGPTModels('test', { fetch: refreshFetch, force: true })
    finishBackgroundRequest!()

    expect((await background).map((model) => model.id)).toEqual(['openai:background-model'])
    expect((await forced).map((model) => model.id)).toEqual(['openai:forced-model'])
    expect(refreshFetch).toHaveBeenCalledTimes(2)
  })

  it('lets one caller cancel its wait without aborting the shared catalog refresh', async () => {
    let finishRequest: (() => void) | undefined
    let requestSignal: AbortSignal | null | undefined
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((resolve) => {
          requestSignal = init?.signal
          finishRequest = () => resolve(Response.json({ models: [{ slug: 'shared-model', visibility: 'list' }] }))
        }),
    )
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = refreshOpenAIChatGPTModels('test', { fetch: fetchMock, signal: firstController.signal })
    const second = refreshOpenAIChatGPTModels('test', { fetch: fetchMock, signal: secondController.signal })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())

    firstController.abort(new Error('first catalog caller aborted'))
    await expect(first).rejects.toThrow('first catalog caller aborted')
    expect(requestSignal?.aborted).not.toBe(true)

    finishRequest!()
    await expect(second).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'openai:shared-model' })]),
    )
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('records unverified fallback state and retries after a refresh failure', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(Response.json({ models: [{ slug: 'recovered-model', visibility: 'list' }] }))

    const fallback = await refreshOpenAIChatGPTModels('test', { fetch: fetchMock })
    expect(fallback.some((model) => model.id === 'openai:gpt-5.6-sol')).toBe(true)
    expect(getOpenAIChatGPTModelCatalogState()).toMatchObject({ source: 'fallback', error: 'offline' })

    const recovered = await refreshOpenAIChatGPTModels('test', { fetch: fetchMock })
    expect(recovered.map((model) => model.id)).toEqual(['openai:recovered-model'])
    expect(getOpenAIChatGPTModelCatalogState()).toMatchObject({ source: 'remote' })
    expect(getOpenAIChatGPTModelCatalogState()?.error).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('preserves an authentication failure code for an actionable catalog status', async () => {
    await refreshOpenAIChatGPTModels('test', {
      fetch: async () => {
        throw new OpenAIChatGPTAuthError('login-required', 'sign in again')
      },
    })

    expect(getOpenAIChatGPTModelCatalogState()).toMatchObject({
      source: 'fallback',
      error: 'sign in again',
      errorCode: 'login-required',
    })
  })

  it('discards an old account refresh that completes after a new account catalog', async () => {
    initializeOpenAIAuthContext()
    let finishAccountA: (() => void) | undefined
    const accountAFetch = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((resolve) => {
          finishAccountA = () => resolve(Response.json({ models: [{ slug: 'account-a-model', visibility: 'list' }] }))
        }),
    )
    const accountARefresh = refreshOpenAIChatGPTModels('test', { fetch: accountAFetch })
    await vi.waitFor(() => expect(accountAFetch).toHaveBeenCalledOnce())

    await writeOpenAIChatGPTCredentials({
      version: 1,
      accessToken: 'oauth-access-b',
      refreshToken: 'oauth-refresh-b',
      expiresAt: Date.now() + 60 * 60 * 1000,
      accountId: 'account-2',
    })
    initializeOpenAIAuthContext()
    const accountBFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ models: [{ slug: 'account-b-model', visibility: 'list' }] }),
    )
    await refreshOpenAIChatGPTModels('test', { fetch: accountBFetch })
    expect(getProviderModels().openai.map((model) => model.id)).toEqual(['openai:account-b-model'])

    finishAccountA!()
    await accountARefresh

    expect(accountBFetch).toHaveBeenCalledOnce()
    expect(getProviderModels().openai.map((model) => model.id)).toEqual(['openai:account-b-model'])
    const diskCache = JSON.parse(
      fs.readFileSync(path.join(testHome, 'cache', 'openai-chatgpt-models.json'), 'utf-8'),
    ) as { accountKey: string; models: Array<{ id: string }> }
    expect(diskCache.accountKey).toBe(createHash('sha256').update('account-2').digest('hex'))
    expect(diskCache.models.map((model) => model.id)).toEqual(['openai:account-b-model'])
  })

  it.each([
    ['non-array reasoning levels', { supportedReasoningLevels: 'high' }],
    ['invalid reasoning level', { supportedReasoningLevels: [{ effort: 42 }] }],
    ['invalid reasoning description', { supportedReasoningLevels: [{ effort: 'high', description: 42 }] }],
    ['invalid default reasoning level', { defaultReasoningLevel: 42 }],
    ['invalid summary support flag', { supportsReasoningSummaryParameter: 'false' }],
    ['non-positive context window', { contextWindow: -1 }],
    ['non-positive output limit', { maxOutputTokens: 0 }],
  ])('rejects a fresh disk cache with %s', async (_label, invalidFields) => {
    const target = path.join(testHome, 'cache', 'openai-chatgpt-models.json')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(
      target,
      JSON.stringify({
        accountKey: createHash('sha256').update('account-1').digest('hex'),
        codexCompatibilityVersion: '0.144.0',
        fetchedAt: Date.now(),
        models: [
          {
            id: 'openai:invalid-cached-model',
            label: 'Invalid cached model',
            description: 'must not be loaded',
            vision: false,
            ...invalidFields,
          },
        ],
      }),
    )
    resetOpenAIChatGPTModelsForTesting()
    const offlineFetch = vi.fn<typeof fetch>(async () => {
      throw new Error('offline')
    })

    const models = await refreshOpenAIChatGPTModels('test', { fetch: offlineFetch })
    expect(offlineFetch).toHaveBeenCalledOnce()
    expect(models.some((model) => model.id === 'openai:invalid-cached-model')).toBe(false)
    expect(models.some((model) => model.id === 'openai:gpt-5.6-sol')).toBe(true)
  })

  it('forces one authenticated catalog refresh after a model 404', async () => {
    await refreshOpenAIChatGPTModels('test', {
      fetch: async () => Response.json({ models: [{ slug: 'before-404', visibility: 'list' }] }),
      force: true,
    })
    const refreshFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ models: [{ slug: 'after-404', visibility: 'list' }] }),
    )
    vi.stubGlobal('fetch', refreshFetch)

    await refreshOpenAIChatGPTModelsAfterNotFound()
    expect(refreshFetch).toHaveBeenCalledOnce()
    expect(getProviderModels().openai.map((model) => model.id)).toEqual(['openai:after-404'])
  })

  it('falls back safely when the remote catalog schema is invalid', async () => {
    const models = await refreshOpenAIChatGPTModels('test', {
      fetch: async () => Response.json({ models: { unexpected: true } }),
      force: true,
    })

    expect(models.some((model) => model.id === 'openai:gpt-5.6-sol')).toBe(true)
    expect(getOpenAIChatGPTModelCatalogState()).toMatchObject({
      source: 'fallback',
      error: 'ChatGPT model catalog response is invalid.',
    })
  })

  it('sanitizes malformed optional fields without discarding a valid remote model', async () => {
    await refreshOpenAIChatGPTModels('test', {
      fetch: async () =>
        Response.json({
          models: [
            {
              slug: 'schema-tolerant',
              display_name: 42,
              context_window: -1,
              max_context_window: 196000,
              max_output_tokens: Number.MAX_SAFE_INTEGER + 1,
              input_modalities: ['text', 42],
              supported_reasoning_levels: [null, { effort: 42 }, { effort: 'high', description: 42 }],
              visibility: 'list',
            },
          ],
        }),
      force: true,
    })

    expect(getOpenAIChatGPTRuntimeModel('openai:schema-tolerant')).toMatchObject({
      label: 'schema-tolerant',
      contextWindow: 196000,
      vision: true,
      supportedReasoningLevels: [{ effort: 'high' }],
    })
    expect(getOpenAIChatGPTRuntimeModel('openai:schema-tolerant')).not.toHaveProperty('maxOutputTokens')
  })

  it('treats an authenticated empty catalog as no model entitlement', async () => {
    await refreshOpenAIChatGPTModels('test', {
      fetch: async () => Response.json({ models: [] }),
      force: true,
    })
    expect(getProviderModels().openai).toEqual([])
  })

  it('uses Codex-compatible subscription capabilities when remote metadata is absent', async () => {
    await refreshOpenAIChatGPTModels('test', {
      fetch: async () => Response.json({ models: [{ slug: 'metadata-light', visibility: 'list' }] }),
      force: true,
    })

    expect(getContextWindow('openai:metadata-light')).toBe(128000)
    expect(getMaxOutputTokens('openai:metadata-light')).toBe(16384)
    expect(getOpenAIChatGPTRuntimeModel('openai:metadata-light')).toMatchObject({
      supportsReasoningSummaryParameter: true,
    })
    expect(getOpenAIChatGPTReasoningTiers('openai:metadata-light')).toEqual([])
    expect(getReasoningLevel('openai:metadata-light', true)).toBeUndefined()
    expect(modelSupportsVision('openai:metadata-light')).toBe(true)
  })

  it('honors an explicit text-only modality from the authenticated model catalog', async () => {
    await refreshOpenAIChatGPTModels('test', {
      fetch: async () =>
        Response.json({
          models: [{ slug: 'text-only', visibility: 'list', input_modalities: ['text'] }],
        }),
      force: true,
    })

    expect(modelSupportsVision('openai:text-only')).toBe(false)
  })

  it('keeps ChatGPT reasoning choices inside the authenticated model tiers', async () => {
    await refreshOpenAIChatGPTModels('test', {
      fetch: async () =>
        Response.json({
          models: [
            {
              slug: 'low-only',
              visibility: 'list',
              default_reasoning_level: 'low',
              supported_reasoning_levels: [{ effort: 'low' }],
            },
          ],
        }),
      force: true,
    })

    expect(getReasoningLevel('openai:low-only', true)).toBe('low')
    expect(getReasoningLevel('openai:low-only', false, 'ultra')).toBe('low')
  })

  it('does not infer Platform reasoning tiers for an unknown subscription model', async () => {
    await refreshOpenAIChatGPTModels('test', {
      fetch: async () => Response.json({ models: [{ slug: 'known-model', visibility: 'list' }] }),
      force: true,
    })

    expect(getOpenAIChatGPTReasoningTiers('openai:not-entitled')).toEqual([])
    expect(getReasoningLevel('openai:not-entitled', true, 'high')).toBeUndefined()
  })
})
