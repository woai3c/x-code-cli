import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  getOpenAIAuthStatus,
  hasOpenAIChatGPTCredentials,
  resetOpenAIAuthContextForTesting,
  writeOpenAIChatGPTCredentials,
} from '@x-code-cli/core'

import { OpenAIChatGPTTokenManager } from '../../core/src/auth/openai-chatgpt/token-manager.js'
import { runAuthCli, shouldEnterProductAfterAuth } from '../src/auth-cli.js'

describe('ChatGPT auth CLI', () => {
  let testHome: string

  beforeEach(() => {
    testHome = path.join(os.tmpdir(), `x-code-chatgpt-cli-${crypto.randomUUID()}`)
    process.env.X_CODE_HOME = testHome
    delete process.env.OPENAI_API_KEY
    resetOpenAIAuthContextForTesting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetOpenAIAuthContextForTesting()
    delete process.env.X_CODE_HOME
    delete process.env.OPENAI_API_KEY
    fs.rmSync(testHome, { recursive: true, force: true })
  })

  it('reports ChatGPT as active and the API key as inactive when both exist', async () => {
    process.env.OPENAI_API_KEY = 'platform-key'
    await writeOpenAIChatGPTCredentials({
      version: 1,
      accessToken: 'oauth-access',
      refreshToken: 'oauth-refresh',
      expiresAt: Date.now() + 60_000,
      accountId: 'account-1234567890',
      email: 'sensitive-user@example.com',
      planType: 'plus',
    })
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    expect(await runAuthCli(['login', 'status'])).toBe(0)
    const text = output.mock.calls.flat().join('\n')
    expect(text).toContain('ChatGPT subscription')
    expect(text).toContain('configured but inactive')
    expect(text).toContain('se***@example.com')
    expect(text).not.toContain('sensitive-user@example.com')
    expect(text).not.toContain('account-1234567890')
  })

  it('removes ChatGPT credentials and reactivates OPENAI_API_KEY on logout', async () => {
    process.env.OPENAI_API_KEY = 'platform-key'
    await writeOpenAIChatGPTCredentials({
      version: 1,
      accessToken: 'oauth-access',
      refreshToken: 'oauth-refresh',
      expiresAt: Date.now() + 60_000,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 200 })),
    )
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    expect(await runAuthCli(['logout'])).toBe(0)
    expect(hasOpenAIChatGPTCredentials()).toBe(false)
    expect(output.mock.calls.flat().join('\n')).toContain('OPENAI_API_KEY is now active')
  })

  it('prevents a concurrent refresh from restoring credentials during logout', async () => {
    await writeOpenAIChatGPTCredentials({
      version: 1,
      accessToken: 'expired-access',
      refreshToken: 'latest-refresh',
      expiresAt: Date.now() - 1,
    })
    let finishRevoke: (() => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Promise<Response>((resolve) => {
            finishRevoke = () => resolve(new Response('', { status: 200 }))
          }),
      ),
    )
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const logout = runAuthCli(['logout'])
    while (!finishRevoke) await new Promise((resolve) => setTimeout(resolve, 1))

    const refreshFetch = vi.fn<typeof fetch>()
    const refresh = new OpenAIChatGPTTokenManager({ fetch: refreshFetch }).getRequestAuth()
    finishRevoke()

    await expect(logout).resolves.toBe(0)
    await expect(refresh).rejects.toMatchObject({ code: 'login-required' })
    expect(refreshFetch).not.toHaveBeenCalled()
    expect(hasOpenAIChatGPTCredentials()).toBe(false)
  })

  it('completes device login and stores the returned subscription credentials', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async (input) => {
          const url = String(input)
          if (url.endsWith('/api/accounts/deviceauth/usercode')) {
            return Response.json({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: 1 })
          }
          if (url.endsWith('/api/accounts/deviceauth/token')) {
            return Response.json({ authorization_code: 'code', code_verifier: 'verifier' })
          }
          return Response.json({ access_token: 'oauth-access', refresh_token: 'oauth-refresh', expires_in: 3600 })
        }),
      )
      const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      const login = runAuthCli(['login', '--device-auth'])
      await vi.advanceTimersByTimeAsync(1_000)

      await expect(login).resolves.toBe(0)
      expect(hasOpenAIChatGPTCredentials()).toBe(true)
      expect(getOpenAIAuthStatus().mode).toBe('chatgpt')
      expect(output.mock.calls.flat().join('\n')).toContain('ABCD-EFGH')
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes login status before ordinary provider and TTY startup checks', () => {
    const result = spawnSync(process.execPath, [path.resolve('packages/cli/dist/cli.js'), 'login', 'status'], {
      cwd: path.resolve('.'),
      env: { ...process.env, X_CODE_HOME: testHome },
      encoding: 'utf-8',
      timeout: 10_000,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('OpenAI authentication: none')
    expect(result.stdout).not.toContain('No API key')
  })

  it('continues into the interactive product only after a successful login', () => {
    expect(shouldEnterProductAfterAuth(['login'], 0, true, true)).toBe(true)
    expect(shouldEnterProductAfterAuth(['login', '--device-auth'], 0, true, true)).toBe(true)
    expect(shouldEnterProductAfterAuth(['login', 'status'], 0, true, true)).toBe(false)
    expect(shouldEnterProductAfterAuth(['logout'], 0, true, true)).toBe(false)
    expect(shouldEnterProductAfterAuth(['login'], 1, true, true)).toBe(false)
    expect(shouldEnterProductAfterAuth(['login'], 0, false, true)).toBe(false)
  })
})
