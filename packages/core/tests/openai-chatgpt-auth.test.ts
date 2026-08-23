import { execFile } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  getOpenAIAuthContext,
  getOpenAIAuthSnapshot,
  getOpenAIAuthStatus,
  initializeOpenAIAuthContext,
  refreshOpenAIAuthContextIfChanged,
  refreshOpenAIAuthSnapshot,
  resetOpenAIAuthContextForTesting,
} from '../src/auth/openai-chatgpt/auth-resolver.js'
import {
  clearOpenAIChatGPTCredentials,
  openAIChatGPTCredentialPath,
  readOpenAIChatGPTCredentials,
  withOpenAIChatGPTCredentialLock,
  writeOpenAIChatGPTCredentials,
} from '../src/auth/openai-chatgpt/credential-store.js'
import {
  buildOpenAIChatGPTAuthorizeUrl,
  generateOpenAIChatGPTPkce,
  loginOpenAIChatGPTWithBrowser,
  loginOpenAIChatGPTWithDevice,
  openAIChatGPTCredentialsFromTokens,
} from '../src/auth/openai-chatgpt/oauth.js'
import type { OpenAIChatGPTCredentials } from '../src/auth/openai-chatgpt/types.js'

function jwt(payload: Record<string, unknown>): string {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`
}

function credentials(overrides: Partial<OpenAIChatGPTCredentials> = {}): OpenAIChatGPTCredentials {
  return {
    version: 1,
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 60 * 60 * 1000,
    accountId: 'account-1',
    ...overrides,
  }
}

const execFileAsync = promisify(execFile)

describe('OpenAI ChatGPT authentication', () => {
  let testHome: string

  beforeEach(() => {
    testHome = path.join(os.tmpdir(), `x-code-chatgpt-auth-${crypto.randomUUID()}`)
    process.env.X_CODE_HOME = testHome
    delete process.env.OPENAI_API_KEY
    resetOpenAIAuthContextForTesting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetOpenAIAuthContextForTesting()
    delete process.env.X_CODE_HOME
    delete process.env.OPENAI_API_KEY
    fs.rmSync(testHome, { recursive: true, force: true })
  })

  it('stores credentials atomically and round-trips the account metadata', async () => {
    const stored = credentials({ email: 'user@example.com', planType: 'plus' })
    await writeOpenAIChatGPTCredentials(stored)

    expect(await readOpenAIChatGPTCredentials()).toEqual(stored)
    expect(fs.statSync(openAIChatGPTCredentialPath()).isFile()).toBe(true)
    if (process.platform !== 'win32') expect(fs.statSync(openAIChatGPTCredentialPath()).mode & 0o777).toBe(0o600)
  })

  it('recovers a stale credential lock left by a dead process', async () => {
    const lock = `${openAIChatGPTCredentialPath()}.lock`
    fs.mkdirSync(path.dirname(lock), { recursive: true })
    fs.writeFileSync(lock, JSON.stringify({ owner: 'dead-owner', pid: 2_147_483_647, createdAt: 0 }))
    const stale = new Date(Date.now() - 3 * 60 * 1000)
    fs.utimesSync(lock, stale, stale)

    await expect(withOpenAIChatGPTCredentialLock(async () => 'acquired')).resolves.toBe('acquired')
    expect(JSON.parse(fs.readFileSync(lock, 'utf-8'))).toMatchObject({ protocol: 2 })
  })

  it('cancels finite lock contention through AbortSignal', async () => {
    let releaseAction: (() => void) | undefined
    const held = withOpenAIChatGPTCredentialLock(
      () =>
        new Promise<void>((resolve) => {
          releaseAction = resolve
        }),
    )
    while (!releaseAction) await new Promise((resolve) => setTimeout(resolve, 1))
    const controller = new AbortController()
    const waiting = withOpenAIChatGPTCredentialLock(async () => undefined, controller.signal)
    setTimeout(() => controller.abort(), 10)
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' })
    releaseAction()
    await held
  })

  it('makes ChatGPT win over OPENAI_API_KEY until logout', async () => {
    process.env.OPENAI_API_KEY = 'platform-key-must-stay-inactive'
    await writeOpenAIChatGPTCredentials(credentials())

    expect(getOpenAIAuthContext()).toEqual({ mode: 'chatgpt' })
    expect(getOpenAIAuthStatus()).toMatchObject({ mode: 'chatgpt', apiKeyConfigured: true, apiKeyActive: false })

    await clearOpenAIChatGPTCredentials()
    resetOpenAIAuthContextForTesting()
    expect(getOpenAIAuthContext()).toEqual({ mode: 'api-key', apiKey: 'platform-key-must-stay-inactive' })
  })

  it('detects an out-of-process ChatGPT login from its persisted revision', async () => {
    process.env.OPENAI_API_KEY = 'platform-key-must-stay-inactive'
    expect(initializeOpenAIAuthContext()).toEqual({ mode: 'api-key', apiKey: 'platform-key-must-stay-inactive' })
    await execFileAsync(process.execPath, [
      '-e',
      "const fs=require('node:fs');const path=require('node:path');fs.mkdirSync(path.dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],process.argv[2])",
      openAIChatGPTCredentialPath(),
      JSON.stringify(credentials({ authRevision: 'external-login' })),
    ])

    expect(getOpenAIAuthContext()).toEqual({ mode: 'api-key', apiKey: 'platform-key-must-stay-inactive' })
    await expect(refreshOpenAIAuthContextIfChanged()).resolves.toMatchObject({
      changed: true,
      previous: { mode: 'api-key' },
      current: { mode: 'chatgpt' },
    })
    expect(getOpenAIAuthContext()).toEqual({ mode: 'chatgpt' })
  })

  it('does not let an older asynchronous auth observation overwrite a newer one', async () => {
    await writeOpenAIChatGPTCredentials(credentials({ authRevision: 'account-a' }))
    initializeOpenAIAuthContext()
    let releaseOlderRead: ((value: string) => void) | undefined
    const olderRead = new Promise<string>((resolve) => {
      releaseOlderRead = resolve
    })
    vi.spyOn(fsPromises, 'readFile')
      .mockImplementationOnce(async () => olderRead)
      .mockResolvedValueOnce(JSON.stringify(credentials({ authRevision: 'account-b' })))

    const olderRefresh = refreshOpenAIAuthSnapshot()
    const newerRefresh = refreshOpenAIAuthSnapshot()
    await expect(newerRefresh).resolves.toMatchObject({ revision: 'chatgpt:account-b' })
    releaseOlderRead!(JSON.stringify(credentials({ authRevision: 'account-a' })))

    await expect(olderRefresh).resolves.toMatchObject({ revision: 'chatgpt:account-b' })
    expect(getOpenAIAuthSnapshot().revision).toBe('chatgpt:account-b')
  })

  it('does not fall back to the API key when stored ChatGPT credentials are corrupt', () => {
    process.env.OPENAI_API_KEY = 'platform-key-must-stay-inactive'
    fs.mkdirSync(path.dirname(openAIChatGPTCredentialPath()), { recursive: true })
    fs.writeFileSync(openAIChatGPTCredentialPath(), '{broken', 'utf-8')

    expect(getOpenAIAuthContext()).toEqual({ mode: 'chatgpt' })
    expect(getOpenAIAuthStatus()).toMatchObject({
      mode: 'chatgpt',
      apiKeyActive: false,
      credentialError: expect.stringContaining('invalid'),
    })
  })

  it('rejects credentials with invalid optional metadata types', async () => {
    fs.mkdirSync(path.dirname(openAIChatGPTCredentialPath()), { recursive: true })
    fs.writeFileSync(
      openAIChatGPTCredentialPath(),
      JSON.stringify({
        version: 1,
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 60_000,
        email: { unexpected: true },
        isFedRamp: 'false',
        authRevision: { unexpected: true },
      }),
    )
    await expect(readOpenAIChatGPTCredentials()).rejects.toMatchObject({ code: 'credentials-invalid' })
  })

  it.each([1e100, 8_640_000_000_000_001, Date.now() + 0.5])(
    'rejects credentials with an invalid expiration timestamp (%s)',
    async (expiresAt) => {
      await expect(writeOpenAIChatGPTCredentials(credentials({ expiresAt }))).rejects.toMatchObject({
        code: 'credentials-invalid',
      })

      fs.mkdirSync(path.dirname(openAIChatGPTCredentialPath()), { recursive: true })
      fs.writeFileSync(openAIChatGPTCredentialPath(), JSON.stringify(credentials({ expiresAt })))
      await expect(readOpenAIChatGPTCredentials()).rejects.toMatchObject({ code: 'credentials-invalid' })
    },
  )

  it('builds PKCE S256 authorization parameters', () => {
    const pkce = generateOpenAIChatGPTPkce()
    const url = new URL(buildOpenAIChatGPTAuthorizeUrl(pkce, 'state-value'))
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43)
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('state-value')
    expect(url.searchParams.get('originator')).toBe('x-code-cli')
  })

  it('extracts account and plan metadata from returned JWTs', () => {
    const item = openAIChatGPTCredentialsFromTokens({
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: 'refresh',
      id_token: jwt({
        email: 'user@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'workspace-1',
          chatgpt_plan_type: 'pro',
        },
      }),
    })
    expect(item).toMatchObject({ accountId: 'workspace-1', email: 'user@example.com', planType: 'pro' })
  })

  it('completes browser login through the loopback callback', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, _init) =>
        new Response(
          JSON.stringify({
            access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
            refresh_token: 'refresh',
            id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-browser' } }),
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )

    const result = await loginOpenAIChatGPTWithBrowser({
      fetch: fetchMock,
      timeoutMs: 5_000,
      openBrowser: async (authorizationUrl) => {
        const state = new URL(authorizationUrl).searchParams.get('state')
        const callback = `http://127.0.0.1:1455/auth/callback?code=test-code&state=${encodeURIComponent(state ?? '')}`
        expect((await fetch(callback)).status).toBe(200)
      },
    })

    expect(result.accountId).toBe('workspace-browser')
    expect(fetchMock).toHaveBeenCalledOnce()
    const tokenRequest = fetchMock.mock.calls[0]?.[1]
    expect(String(tokenRequest?.body)).toContain('code=test-code')
  })

  it('uses the registered fallback callback port when 1455 is occupied', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(1455, '127.0.0.1', resolve)
    })
    try {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }),
      )
      const result = await loginOpenAIChatGPTWithBrowser({
        fetch: fetchMock,
        timeoutMs: 5_000,
        openBrowser: async (authorizationUrl) => {
          const authorization = new URL(authorizationUrl)
          const redirectUri = authorization.searchParams.get('redirect_uri')
          expect(redirectUri).toBe('http://localhost:1457/auth/callback')
          const callback = new URL(redirectUri!)
          callback.searchParams.set('code', 'test-code')
          callback.searchParams.set('state', authorization.searchParams.get('state') ?? '')
          expect((await fetch(callback)).status).toBe(200)
        },
      })

      expect(result.accessToken).toBe('access')
      expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain(
        `redirect_uri=${encodeURIComponent('http://localhost:1457/auth/callback')}`,
      )
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('ignores a mismatched state callback and still accepts the legitimate callback', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }),
    )
    const result = await loginOpenAIChatGPTWithBrowser({
      fetch: fetchMock,
      timeoutMs: 5_000,
      openBrowser: async (authorizationUrl) => {
        expect((await fetch('http://127.0.0.1:1455/auth/callback?code=test-code&state=wrong')).status).toBe(400)
        const state = new URL(authorizationUrl).searchParams.get('state')
        const missingCode = `http://127.0.0.1:1455/auth/callback?state=${encodeURIComponent(state ?? '')}`
        expect((await fetch(missingCode)).status).toBe(400)
        const callback = `http://127.0.0.1:1455/auth/callback?code=test-code&state=${encodeURIComponent(state ?? '')}`
        expect((await fetch(callback)).status).toBe(200)
      },
    })

    expect(result.accessToken).toBe('access')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('validates state before accepting an OAuth error callback and redacts its description', async () => {
    await expect(
      loginOpenAIChatGPTWithBrowser({
        timeoutMs: 5_000,
        openBrowser: async (authorizationUrl) => {
          const callback = 'http://127.0.0.1:1455/auth/callback?error=access_denied&error_description=secret-local-text'
          const invalidResponse = await fetch(callback).catch((error: unknown) => {
            throw new Error('invalid-state callback request failed', { cause: error })
          })
          expect(invalidResponse.status).toBe(400)
          expect(await invalidResponse.text()).not.toContain('secret-local-text')
          const state = new URL(authorizationUrl).searchParams.get('state')
          const legitimateError = `http://127.0.0.1:1455/auth/callback?error=access_denied&state=${encodeURIComponent(state ?? '')}`
          const legitimateResponse = await fetch(legitimateError).catch((error: unknown) => {
            throw new Error('legitimate error callback request failed', { cause: error })
          })
          expect(legitimateResponse.status).toBe(400)
          await legitimateResponse.text()
        },
      }),
    ).rejects.toMatchObject({ code: 'oauth-failed', message: expect.not.stringContaining('secret-local-text') })
  })

  it('does not show browser success until credentials are persisted', async () => {
    let persistenceStarted: (() => void) | undefined
    let finishPersistence: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      persistenceStarted = resolve
    })
    const result = await loginOpenAIChatGPTWithBrowser({
      timeoutMs: 5_000,
      fetch: async () => Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }),
      onCredentials: async () => {
        persistenceStarted?.()
        await new Promise<void>((resolve) => {
          finishPersistence = resolve
        })
      },
      openBrowser: async (authorizationUrl) => {
        const state = new URL(authorizationUrl).searchParams.get('state')
        const callback = `http://127.0.0.1:1455/auth/callback?code=test-code&state=${encodeURIComponent(state ?? '')}`
        let callbackFinished = false
        const callbackResponse = fetch(callback).then((response) => {
          callbackFinished = true
          return response
        })
        await started
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(callbackFinished).toBe(false)
        finishPersistence?.()
        expect((await callbackResponse).status).toBe(200)
      },
    })

    expect(result.accessToken).toBe('access')
  })

  it('lets an accepted credential commit win over late cancellation', async () => {
    const controller = new AbortController()
    let persistenceStarted: (() => void) | undefined
    let finishPersistence: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      persistenceStarted = resolve
    })
    let persisted = false
    const result = await loginOpenAIChatGPTWithBrowser({
      signal: controller.signal,
      timeoutMs: 5_000,
      fetch: async () => Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }),
      onCredentials: async () => {
        persistenceStarted?.()
        await new Promise<void>((resolve) => {
          finishPersistence = resolve
        })
        persisted = true
      },
      openBrowser: async (authorizationUrl) => {
        const state = new URL(authorizationUrl).searchParams.get('state')
        const callback = `http://127.0.0.1:1455/auth/callback?code=test-code&state=${encodeURIComponent(state ?? '')}`
        const callbackResponse = fetch(callback)
        await started
        controller.abort()
        finishPersistence?.()
        expect((await callbackResponse).status).toBe(200)
      },
    })

    expect(result.accessToken).toBe('access')
    expect(persisted).toBe(true)
  })

  it('completes browser login when the callback disconnects after credentials are persisted', async () => {
    let persistenceStarted: (() => void) | undefined
    let finishPersistence: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      persistenceStarted = resolve
    })
    const login = loginOpenAIChatGPTWithBrowser({
      timeoutMs: 2_000,
      fetch: async () => Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }),
      onCredentials: async () => {
        persistenceStarted?.()
        await new Promise<void>((resolve) => {
          finishPersistence = resolve
        })
      },
      openBrowser: async (authorizationUrl) => {
        const state = new URL(authorizationUrl).searchParams.get('state')
        const socket = connect(1455, '127.0.0.1')
        await once(socket, 'connect')
        socket.write(
          `GET /auth/callback?code=test-code&state=${encodeURIComponent(state ?? '')} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
        )
        await started
        socket.destroy()
        finishPersistence?.()
      },
    })

    await expect(login).resolves.toMatchObject({ accessToken: 'access' })
  })

  it('applies the browser total timeout to a stalled token exchange', async () => {
    let exchangeStarted: (() => void) | undefined
    let exchangeSignal: AbortSignal | null | undefined
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          exchangeSignal = init?.signal
          exchangeStarted?.()
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }),
    )
    const started = new Promise<void>((resolve) => {
      exchangeStarted = resolve
    })
    const login = loginOpenAIChatGPTWithBrowser({
      fetch: fetchMock,
      timeoutMs: 500,
      openBrowser: async (authorizationUrl) => {
        const state = new URL(authorizationUrl).searchParams.get('state')
        const callback = `http://127.0.0.1:1455/auth/callback?code=test-code&state=${encodeURIComponent(state ?? '')}`
        expect((await fetch(callback)).status).toBe(400)
      },
    })
    await started

    await expect(login).rejects.toMatchObject({ code: 'timeout' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(exchangeSignal?.aborted).toBe(true)
  })

  it('force-closes half-open callback sockets when browser login finishes', async () => {
    let heldSocket: ReturnType<typeof connect> | undefined
    const login = loginOpenAIChatGPTWithBrowser({
      timeoutMs: 2_000,
      fetch: async () => Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }),
      openBrowser: async (authorizationUrl) => {
        heldSocket = connect(1455, '127.0.0.1')
        await once(heldSocket, 'connect')
        heldSocket.write('GET /held-open HTTP/1.1\r\nHost: localhost\r\n')
        const state = new URL(authorizationUrl).searchParams.get('state')
        const callback = `http://127.0.0.1:1455/auth/callback?code=test-code&state=${encodeURIComponent(state ?? '')}`
        expect((await fetch(callback)).status).toBe(200)
      },
    })

    await expect(login).resolves.toMatchObject({ accessToken: 'access' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(heldSocket?.destroyed).toBe(true)
  })

  it('completes device login and reuses the authorization-code exchange', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input)
        if (url.endsWith('/api/accounts/deviceauth/usercode')) {
          return new Response(JSON.stringify({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: '1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        if (url.endsWith('/api/accounts/deviceauth/token')) {
          return new Response(JSON.stringify({ authorization_code: 'device-code', code_verifier: 'device-verifier' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(
          JSON.stringify({
            access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
            refresh_token: 'device-refresh',
            id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-device' } }),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      })
      const onUserCode = vi.fn()
      const login = loginOpenAIChatGPTWithDevice({ fetch: fetchMock, onUserCode })
      await vi.advanceTimersByTimeAsync(1_000)

      await expect(login).resolves.toMatchObject({ accountId: 'workspace-device', refreshToken: 'device-refresh' })
      expect(onUserCode).toHaveBeenCalledWith('https://auth.openai.com/codex/device', 'ABCD-EFGH')
      expect(fetchMock).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('honors device slow_down responses before completing login', async () => {
    vi.useFakeTimers()
    try {
      let polls = 0
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input)
        if (url.endsWith('/api/accounts/deviceauth/usercode')) {
          return Response.json({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: 1 })
        }
        if (url.endsWith('/api/accounts/deviceauth/token')) {
          polls++
          return polls === 1
            ? Response.json({ error: 'slow_down' }, { status: 400 })
            : Response.json({ authorization_code: 'device-code', code_verifier: 'device-verifier' })
        }
        return Response.json({ access_token: jwt({}), refresh_token: 'device-refresh', expires_in: 3600 })
      })
      const login = loginOpenAIChatGPTWithDevice({ fetch: fetchMock, onUserCode: vi.fn() })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(polls).toBe(1)
      await vi.advanceTimersByTimeAsync(5_999)
      expect(polls).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      await expect(login).resolves.toMatchObject({ refreshToken: 'device-refresh' })
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['access_denied', 'expired_token'])('fails device login on %s', async (oauthError) => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input)
        if (url.endsWith('/api/accounts/deviceauth/usercode')) {
          return Response.json({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: 1 })
        }
        return Response.json({ error: oauthError }, { status: 403 })
      })
      const login = loginOpenAIChatGPTWithDevice({ fetch: fetchMock, onUserCode: vi.fn() })
      const rejection = expect(login).rejects.toThrow(oauthError)
      await vi.advanceTimersByTimeAsync(1_000)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops device polling at the configured total timeout', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        Response.json({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: 5 }),
      )
      const login = loginOpenAIChatGPTWithDevice({ fetch: fetchMock, onUserCode: vi.fn(), timeoutMs: 500 })
      const rejection = expect(login).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(500)
      await rejection
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies the device total timeout to the initial network request', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }),
    )
    await expect(
      loginOpenAIChatGPTWithDevice({ fetch: fetchMock, onUserCode: vi.fn(), timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'timeout' })
  })
})
