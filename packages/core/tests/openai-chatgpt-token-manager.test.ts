import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { classifyApiError } from '../src/agent/api-errors.js'
import {
  getOpenAIAuthSnapshot,
  initializeOpenAIAuthContext,
  refreshOpenAIAuthSnapshot,
  resetOpenAIAuthContextForTesting,
} from '../src/auth/openai-chatgpt/auth-resolver.js'
import {
  readOpenAIChatGPTCredentials,
  writeOpenAIChatGPTCredentials,
} from '../src/auth/openai-chatgpt/credential-store.js'
import { OpenAIChatGPTTokenManager } from '../src/auth/openai-chatgpt/token-manager.js'

function jwt(payload: Record<string, unknown>): string {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`
}

describe('OpenAIChatGPTTokenManager', () => {
  let testHome: string

  beforeEach(async () => {
    testHome = path.join(os.tmpdir(), `x-code-chatgpt-token-${crypto.randomUUID()}`)
    process.env.X_CODE_HOME = testHome
    resetOpenAIAuthContextForTesting()
    await writeOpenAIChatGPTCredentials({
      version: 1,
      accessToken: 'expired-access',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() - 1,
      accountId: 'account-1',
      authRevision: 'stable-login-revision',
    })
  })

  afterEach(() => {
    resetOpenAIAuthContextForTesting()
    delete process.env.X_CODE_HOME
    fs.rmSync(testHome, { recursive: true, force: true })
  })

  it('singleflights refresh and persists rotated tokens', async () => {
    const refresh = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
            refresh_token: 'rotated-refresh',
            id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' } }),
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    const manager = new OpenAIChatGPTTokenManager({ fetch: refresh as typeof fetch })
    const [left, right] = await Promise.all([manager.getRequestAuth(), manager.getRequestAuth()])

    expect(left.accessToken).toBe(right.accessToken)
    expect(refresh).toHaveBeenCalledOnce()
    expect(await readOpenAIChatGPTCredentials()).toMatchObject({
      accessToken: left.accessToken,
      refreshToken: 'rotated-refresh',
      accountId: 'account-1',
      authRevision: 'stable-login-revision',
    })
  })

  it('upgrades a legacy credential revision without looking like an account switch', async () => {
    await writeOpenAIChatGPTCredentials({
      version: 1,
      accessToken: 'expired-access',
      refreshToken: 'legacy-refresh',
      expiresAt: Date.now() - 1,
      accountId: 'account-1',
    })
    resetOpenAIAuthContextForTesting()
    initializeOpenAIAuthContext()
    const before = getOpenAIAuthSnapshot()
    const manager = new OpenAIChatGPTTokenManager({
      fetch: async () =>
        Response.json({
          access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: 'rotated-refresh',
          id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' } }),
        }),
    })

    await manager.getRequestAuth()
    const after = await refreshOpenAIAuthSnapshot()

    expect(after.revision).toBe(before.revision)
    expect((await readOpenAIChatGPTCredentials()).authRevision).toBe(before.revision.slice('chatgpt:'.length))
  })

  it('lets the first caller cancel only its own wait for a shared refresh', async () => {
    let finishRefresh: (() => void) | undefined
    let refreshSignal: AbortSignal | null | undefined
    const refresh = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((resolve) => {
          refreshSignal = init?.signal
          finishRefresh = () =>
            resolve(
              Response.json({
                access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
                refresh_token: 'rotated-refresh',
                id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' } }),
              }),
            )
        }),
    )
    const manager = new OpenAIChatGPTTokenManager({ fetch: refresh })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = manager.getRequestAuth(firstController.signal)
    const second = manager.getRequestAuth(secondController.signal)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())

    firstController.abort(new Error('first caller aborted'))
    await expect(first).rejects.toThrow('first caller aborted')
    expect(refreshSignal?.aborted).not.toBe(true)

    finishRefresh!()
    await expect(second).resolves.toMatchObject({ accountId: 'account-1' })
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('lets a later caller cancel without interrupting the refresh owner', async () => {
    let finishRefresh: (() => void) | undefined
    const refresh = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((resolve) => {
          finishRefresh = () =>
            resolve(
              Response.json({
                access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
                refresh_token: 'rotated-refresh',
                id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' } }),
              }),
            )
        }),
    )
    const manager = new OpenAIChatGPTTokenManager({ fetch: refresh })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = manager.getRequestAuth(firstController.signal)
    const second = manager.getRequestAuth(secondController.signal)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())

    secondController.abort(new Error('second caller aborted'))
    await expect(second).rejects.toThrow('second caller aborted')

    finishRefresh!()
    await expect(first).resolves.toMatchObject({ accountId: 'account-1' })
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('rejects a refreshed token for a different ChatGPT account', async () => {
    const manager = new OpenAIChatGPTTokenManager({
      fetch: async () =>
        new Response(
          JSON.stringify({
            access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
            refresh_token: 'rotated-refresh',
            id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'different-account' } }),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    })

    await expect(manager.getRequestAuth()).rejects.toThrow('does not match')
    expect((await readOpenAIChatGPTCredentials()).accessToken).toBe('expired-access')
  })

  it('re-reads rotated credentials after cross-manager lock contention', async () => {
    let finishRefresh: (() => void) | undefined
    const firstFetch = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((resolve) => {
          finishRefresh = () =>
            resolve(
              Response.json({
                access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
                refresh_token: 'rotated-by-first-manager',
                id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' } }),
                expires_in: 3600,
              }),
            )
        }),
    )
    const secondFetch = vi.fn<typeof fetch>()
    const first = new OpenAIChatGPTTokenManager({ fetch: firstFetch })
    const second = new OpenAIChatGPTTokenManager({ fetch: secondFetch })

    const firstRequest = first.getRequestAuth()
    while (!finishRefresh) await new Promise((resolve) => setTimeout(resolve, 1))
    const secondRequest = second.getRequestAuth()
    finishRefresh()

    const [firstAuth, secondAuth] = await Promise.all([firstRequest, secondRequest])
    expect(secondAuth.accessToken).toBe(firstAuth.accessToken)
    expect(firstFetch).toHaveBeenCalledOnce()
    expect(secondFetch).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid_grant', 400, { error: 'invalid_grant' }],
    [
      'expired refresh token description',
      400,
      { error: 'bad_request', error_description: 'The refresh token has expired' },
    ],
    [
      'reused refresh token description',
      400,
      { error: 'bad_request', error_description: 'Refresh token has already been used' },
    ],
    ['nested expired code', 400, { error: { code: 'refresh_token_expired' } }],
    ['nested reused code', 400, { error: { code: 'refresh_token_reused' } }],
    ['top-level invalidated code', 400, { code: 'refresh_token_invalidated' }],
    ['bodyless HTTP 401', 401, undefined],
  ])('classifies %s failures as requiring a new ChatGPT login', async (_label, status, responseBody) => {
    const manager = new OpenAIChatGPTTokenManager({
      fetch: async () =>
        responseBody === undefined ? new Response(null, { status }) : Response.json(responseBody, { status }),
    })

    const error = await manager.getRequestAuth().catch((err: unknown) => err)
    expect(error).toMatchObject({ name: 'OpenAIChatGPTAuthError', code: 'login-required' })
    expect(classifyApiError(error)).toEqual({
      message:
        'ChatGPT sign-in expired or was revoked. Run `xc login` again, or `xc logout` to return to OpenAI API key authentication.',
      retryable: false,
    })
  })

  it('does not treat temporary refresh service failures as requiring login', async () => {
    const manager = new OpenAIChatGPTTokenManager({
      fetch: async () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 }),
    })

    const error = await manager.getRequestAuth().catch((err: unknown) => err)
    expect(error).toMatchObject({ name: 'OpenAIChatGPTAuthError', code: 'oauth-failed' })
    expect(classifyApiError(error).message).toContain('service unavailable')
  })
})
