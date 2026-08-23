import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'

import { debugLog } from '../../utils.js'
import { OpenAIChatGPTAuthError } from './types.js'
import type { OpenAIChatGPTCredentials, OpenAIChatGPTJwtClaims, OpenAIChatGPTTokenResponse } from './types.js'

export const OPENAI_CHATGPT_OAUTH = {
  issuer: 'https://auth.openai.com',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  browserRedirectUri: 'http://localhost:1455/auth/callback',
  browserBindHost: '127.0.0.1',
  browserPort: 1455,
  browserFallbackPort: 1457,
  scopes: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
  responsesEndpoint: 'https://chatgpt.com/backend-api/codex/responses',
  modelsEndpoint: 'https://chatgpt.com/backend-api/codex/models',
} as const

const DEFAULT_BROWSER_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_DEVICE_TIMEOUT_MS = 15 * 60 * 1000

export interface OpenAIChatGPTOAuthOptions {
  fetch?: typeof fetch
  signal?: AbortSignal
  userAgent?: string
}

export interface OpenAIChatGPTBrowserLoginOptions extends OpenAIChatGPTOAuthOptions {
  onAuthorizationUrl?: (url: string) => void
  onCredentials?: (credentials: OpenAIChatGPTCredentials, signal: AbortSignal) => Promise<void>
  openBrowser?: (url: string) => Promise<void>
  timeoutMs?: number
}

export interface OpenAIChatGPTDeviceLoginOptions extends OpenAIChatGPTOAuthOptions {
  onUserCode: (verificationUrl: string, userCode: string) => void
  timeoutMs?: number
}

interface PkceCodes {
  verifier: string
  challenge: string
}

interface DeviceAuthorizationResponse {
  device_auth_id: string
  user_code: string
  interval?: string | number
}

interface DeviceTokenResponse {
  authorization_code: string
  code_verifier: string
}

function base64Url(buffer: Uint8Array): string {
  return Buffer.from(buffer).toString('base64url')
}

export function generateOpenAIChatGPTPkce(): PkceCodes {
  const verifier = base64Url(randomBytes(32))
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function parseOpenAIChatGPTJwtClaims(token: string): OpenAIChatGPTJwtClaims | undefined {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) return undefined
  try {
    const value = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as OpenAIChatGPTJwtClaims) : undefined
  } catch {
    return undefined
  }
}

function extractTokenMetadata(tokens: OpenAIChatGPTTokenResponse): {
  accountId?: string
  email?: string
  planType?: string
  isFedRamp?: boolean
  jwtExpiresAt?: number
} {
  const idClaims = tokens.id_token ? parseOpenAIChatGPTJwtClaims(tokens.id_token) : undefined
  const accessClaims = parseOpenAIChatGPTJwtClaims(tokens.access_token)
  const claims = idClaims ?? accessClaims
  const authClaims = claims?.['https://api.openai.com/auth']
  const accountId =
    authClaims?.chatgpt_account_id ?? claims?.chatgpt_account_id ?? claims?.organizations?.find((item) => item.id)?.id
  const exp = accessClaims?.exp ?? claims?.exp
  return {
    accountId,
    email: claims?.email ?? claims?.['https://api.openai.com/profile']?.email,
    planType: authClaims?.chatgpt_plan_type,
    isFedRamp: authClaims?.chatgpt_account_is_fedramp,
    jwtExpiresAt: typeof exp === 'number' ? exp * 1000 : undefined,
  }
}

export function openAIChatGPTCredentialsFromTokens(
  tokens: OpenAIChatGPTTokenResponse,
  previous?: OpenAIChatGPTCredentials,
): OpenAIChatGPTCredentials {
  if (!tokens.access_token) {
    throw new OpenAIChatGPTAuthError('oauth-failed', 'OpenAI did not return an access token.')
  }
  const refreshToken = tokens.refresh_token ?? previous?.refreshToken
  if (!refreshToken) {
    throw new OpenAIChatGPTAuthError('oauth-failed', 'OpenAI did not return a refresh token.')
  }
  const metadata = extractTokenMetadata(tokens)
  const expiresAt =
    typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in)
      ? Date.now() + tokens.expires_in * 1000
      : (metadata.jwtExpiresAt ?? Date.now() + 60 * 60 * 1000)
  const previousRevision = previous?.authRevision
    ? previous.authRevision
    : previous
      ? `legacy-${createHash('sha256')
          .update(previous.accountId ?? previous.refreshToken)
          .digest('hex')}`
      : undefined
  return {
    version: 1,
    authRevision: previousRevision ?? randomUUID(),
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt,
    accountId: metadata.accountId ?? previous?.accountId,
    idToken: tokens.id_token ?? previous?.idToken,
    email: metadata.email ?? previous?.email,
    planType: metadata.planType ?? previous?.planType,
    isFedRamp: metadata.isFedRamp ?? previous?.isFedRamp,
  }
}

export function buildOpenAIChatGPTAuthorizeUrl(
  pkce: PkceCodes,
  state: string,
  redirectUri: string = OPENAI_CHATGPT_OAUTH.browserRedirectUri,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OPENAI_CHATGPT_OAUTH.clientId,
    redirect_uri: redirectUri,
    scope: OPENAI_CHATGPT_OAUTH.scopes,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: 'x-code-cli',
  })
  return `${OPENAI_CHATGPT_OAUTH.issuer}/oauth/authorize?${params.toString()}`
}

function authHeaders(userAgent?: string): Record<string, string> {
  return userAgent ? { 'User-Agent': userAgent } : {}
}

function isPermanentRefreshFailure(errorCode: string, errorDescription: string): boolean {
  const code = errorCode.toLowerCase()
  if (
    [
      'invalid_grant',
      'invalid_token',
      'refresh_token_expired',
      'refresh_token_invalidated',
      'refresh_token_revoked',
      'refresh_token_reused',
    ].includes(code)
  )
    return true
  const description = errorDescription.toLowerCase()
  const refreshTokenFailure = /refresh[_ ]token/.test(description)
  return refreshTokenFailure && /expired|invalid|revoked|reused|already (?:been )?used|reuse detected/.test(description)
}

async function responseError(
  response: Response,
  action: string,
  loginRequiredOnPermanentRefreshFailure = false,
): Promise<OpenAIChatGPTAuthError> {
  let errorCode = ''
  let errorDescription = ''
  try {
    const body = (await response.json()) as {
      code?: unknown
      error?: unknown
      error_description?: unknown
    }
    const nestedErrorCode =
      body.error && typeof body.error === 'object' && !Array.isArray(body.error)
        ? (body.error as Record<string, unknown>).code
        : undefined
    const candidateCode = typeof body.error === 'string' ? body.error : (nestedErrorCode ?? body.code)
    if (typeof candidateCode === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(candidateCode)) {
      errorCode = candidateCode
    }
    if (typeof body.error_description === 'string') errorDescription = body.error_description.slice(0, 500)
  } catch {
    // OAuth endpoints sometimes return HTML; do not copy an untrusted body into logs or terminal output.
  }
  if (
    loginRequiredOnPermanentRefreshFailure &&
    (response.status === 401 || isPermanentRefreshFailure(errorCode, errorDescription))
  ) {
    return new OpenAIChatGPTAuthError(
      'login-required',
      'ChatGPT sign-in expired or was revoked. Run `xc login` again, or `xc logout` to return to OpenAI API key authentication.',
    )
  }
  return new OpenAIChatGPTAuthError(
    'oauth-failed',
    `${action} failed (${response.status})${errorCode ? `: ${errorCode}` : ''}`,
  )
}

export async function exchangeOpenAIChatGPTCode(
  code: string,
  redirectUri: string,
  verifier: string,
  options: OpenAIChatGPTOAuthOptions = {},
): Promise<OpenAIChatGPTCredentials> {
  const fetchImpl = options.fetch ?? fetch
  const response = await fetchImpl(`${OPENAI_CHATGPT_OAUTH.issuer}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...authHeaders(options.userAgent),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: OPENAI_CHATGPT_OAUTH.clientId,
      code_verifier: verifier,
    }).toString(),
    signal: options.signal,
  })
  if (!response.ok) throw await responseError(response, 'ChatGPT token exchange')
  const tokens = (await response.json()) as OpenAIChatGPTTokenResponse
  return openAIChatGPTCredentialsFromTokens(tokens)
}

export async function refreshOpenAIChatGPTAccessToken(
  credentials: OpenAIChatGPTCredentials,
  options: OpenAIChatGPTOAuthOptions = {},
): Promise<OpenAIChatGPTCredentials> {
  const fetchImpl = options.fetch ?? fetch
  const response = await fetchImpl(`${OPENAI_CHATGPT_OAUTH.issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(options.userAgent) },
    body: JSON.stringify({
      client_id: OPENAI_CHATGPT_OAUTH.clientId,
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
    }),
    signal: options.signal,
  })
  if (!response.ok) throw await responseError(response, 'ChatGPT token refresh', true)
  const tokens = (await response.json()) as OpenAIChatGPTTokenResponse
  return openAIChatGPTCredentialsFromTokens(tokens, credentials)
}

export async function revokeOpenAIChatGPTCredentials(
  credentials: OpenAIChatGPTCredentials,
  options: OpenAIChatGPTOAuthOptions = {},
): Promise<void> {
  const fetchImpl = options.fetch ?? fetch
  const response = await fetchImpl(`${OPENAI_CHATGPT_OAUTH.issuer}/oauth/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(options.userAgent) },
    body: JSON.stringify({
      token: credentials.refreshToken || credentials.accessToken,
      token_type_hint: credentials.refreshToken ? 'refresh_token' : 'access_token',
      ...(credentials.refreshToken ? { client_id: OPENAI_CHATGPT_OAUTH.clientId } : {}),
    }),
    signal: options.signal,
  })
  if (!response.ok) throw await responseError(response, 'ChatGPT logout')
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === '&') return '&amp;'
    if (character === '<') return '&lt;'
    if (character === '>') return '&gt;'
    if (character === '"') return '&quot;'
    return '&#39;'
  })
}

function callbackPage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`
}

async function listen(server: Server, port: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? aborted()
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening)
      signal?.removeEventListener('abort', onAbort)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const onAbort = () => {
      server.off('error', onError)
      server.off('listening', onListening)
      reject(signal?.reason ?? aborted())
    }
    server.once('error', onError)
    server.once('listening', onListening)
    signal?.addEventListener('abort', onAbort, { once: true })
    server.listen(port, OPENAI_CHATGPT_OAUTH.browserBindHost)
  })
}

async function listenForBrowserCallback(server: Server, signal?: AbortSignal): Promise<number> {
  const ports = [OPENAI_CHATGPT_OAUTH.browserPort, OPENAI_CHATGPT_OAUTH.browserFallbackPort]
  for (const port of ports) {
    try {
      await listen(server, port, signal)
      return port
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port === ports.at(-1)) throw error
    }
  }
  throw new OpenAIChatGPTAuthError('oauth-failed', 'No ChatGPT browser callback port is available.')
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve) => {
    const forceCloseTimer = setTimeout(() => server.closeAllConnections(), 10)
    forceCloseTimer.unref()
    server.close(() => {
      clearTimeout(forceCloseTimer)
      resolve()
    })
  })
}

async function defaultOpenBrowser(url: string): Promise<void> {
  let child: ReturnType<typeof spawn>
  if (process.platform === 'win32') {
    child = spawn('rundll32', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
  } else if (process.platform === 'darwin') {
    child = spawn('open', [url], { detached: true, stdio: 'ignore' })
  } else {
    child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
  }
  child.on('error', (err) => debugLog('openai-chatgpt.browser-open-failed', err.message))
  child.unref()
}

function aborted(): OpenAIChatGPTAuthError {
  return new OpenAIChatGPTAuthError('cancelled', 'ChatGPT authentication was cancelled.')
}

function flowTimeout(message: string): OpenAIChatGPTAuthError {
  return new OpenAIChatGPTAuthError('timeout', message)
}

function createFlowSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal
  timedOut: () => boolean
  dispose: () => void
} {
  const timeoutController = new AbortController()
  let didTimeOut = false
  const timer = setTimeout(() => {
    didTimeOut = true
    timeoutController.abort()
  }, timeoutMs)
  timer.unref()
  return {
    signal: externalSignal ? AbortSignal.any([externalSignal, timeoutController.signal]) : timeoutController.signal,
    timedOut: () => didTimeOut,
    dispose: () => clearTimeout(timer),
  }
}

function normalizeFlowError(
  err: unknown,
  externalSignal: AbortSignal | undefined,
  timedOut: boolean,
  timeoutMessage: string,
): unknown {
  if (externalSignal?.aborted) return aborted()
  if (timedOut) return flowTimeout(timeoutMessage)
  return err
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal, shouldIgnoreAbort?: () => boolean): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? aborted())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (shouldIgnoreAbort?.()) return
      reject(signal.reason ?? aborted())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(aborted())
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(aborted())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function loginOpenAIChatGPTWithBrowser(
  options: OpenAIChatGPTBrowserLoginOptions = {},
): Promise<OpenAIChatGPTCredentials> {
  if (options.signal?.aborted) throw aborted()
  const flow = createFlowSignal(options.signal, options.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS)
  const pkce = generateOpenAIChatGPTPkce()
  const state = base64Url(randomBytes(32))
  let resolveCredentials: ((credentials: OpenAIChatGPTCredentials) => void) | undefined
  let rejectCredentials: ((err: Error) => void) | undefined
  const credentialsPromise = new Promise<OpenAIChatGPTCredentials>((resolve, reject) => {
    resolveCredentials = resolve
    rejectCredentials = reject
  })
  void credentialsPromise.catch(() => undefined)
  let settled = false
  let callbackAccepted = false
  let credentialCommitInProgress = false
  let redirectUri: string = OPENAI_CHATGPT_OAUTH.browserRedirectUri
  const settleError = (err: Error) => {
    if (settled) return
    settled = true
    rejectCredentials?.(err)
  }
  const settleCredentials = (credentials: OpenAIChatGPTCredentials) => {
    if (settled) return
    settled = true
    resolveCredentials?.(credentials)
  }

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', redirectUri)
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Connection', 'close')
    if (request.method !== 'GET' || requestUrl.pathname !== '/auth/callback') {
      response.writeHead(404)
      response.end(callbackPage('Not found', 'This callback URL is not valid.'))
      return
    }
    if (requestUrl.searchParams.get('state') !== state) {
      response.writeHead(400)
      response.end(callbackPage('ChatGPT login failed', 'The authorization state did not match.'))
      return
    }
    if (settled || callbackAccepted) {
      response.writeHead(409)
      response.end(callbackPage('ChatGPT login already handled', 'Return to x-code-cli to continue.'))
      return
    }
    const error = requestUrl.searchParams.get('error')
    if (error) {
      const safeError = /^[a-z0-9_.-]{1,80}$/i.test(error) ? error : 'authorization_failed'
      const authError = new OpenAIChatGPTAuthError('oauth-failed', `ChatGPT authorization failed: ${safeError}`)
      const finish = () => settleError(authError)
      response.writeHead(400)
      response.once('close', finish)
      response.end(callbackPage('ChatGPT login failed', safeError), finish)
      return
    }
    const code = requestUrl.searchParams.get('code')
    if (!code) {
      response.writeHead(400)
      response.end(callbackPage('ChatGPT login failed', 'The authorization code was missing.'))
      return
    }
    callbackAccepted = true
    void (async () => {
      try {
        const credentials = await exchangeOpenAIChatGPTCode(code, redirectUri, pkce.verifier, {
          ...options,
          signal: flow.signal,
        })
        if (settled) return
        credentialCommitInProgress = true
        await options.onCredentials?.(credentials, flow.signal)
        if (settled) return
        const finish = () => settleCredentials(credentials)
        if (response.destroyed) {
          finish()
        } else {
          try {
            response.writeHead(200)
            response.once('close', finish)
            response.end(
              callbackPage('ChatGPT login complete', 'You can close this window and return to x-code-cli.'),
              finish,
            )
          } catch {
            finish()
          }
        }
      } catch (err) {
        credentialCommitInProgress = false
        const authError =
          err instanceof Error
            ? err
            : new OpenAIChatGPTAuthError('oauth-failed', 'ChatGPT login failed during token exchange.')
        if (!response.destroyed && !response.writableEnded) {
          const finish = () => settleError(authError)
          response.writeHead(400)
          response.once('close', finish)
          response.end(
            callbackPage('ChatGPT login failed', 'Return to x-code-cli for details, then try again.'),
            finish,
          )
          return
        }
        settleError(authError)
      }
    })()
  })

  const onAbort = () => {
    if (credentialCommitInProgress) return
    settleError(flow.timedOut() ? flowTimeout('ChatGPT browser login timed out.') : aborted())
  }
  flow.signal.addEventListener('abort', onAbort, { once: true })
  try {
    const port = await listenForBrowserCallback(server, flow.signal)
    redirectUri = `http://localhost:${port}/auth/callback`
    const url = buildOpenAIChatGPTAuthorizeUrl(pkce, state, redirectUri)
    options.onAuthorizationUrl?.(url)
    await abortable((options.openBrowser ?? defaultOpenBrowser)(url), flow.signal, () => credentialCommitInProgress)
    return await credentialsPromise
  } catch (err) {
    settleError(
      err instanceof Error ? err : new OpenAIChatGPTAuthError('oauth-failed', 'ChatGPT browser login failed.'),
    )
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new OpenAIChatGPTAuthError(
        'oauth-failed',
        'Ports 1455 and 1457 are already in use. Close another login process or run `xc login --device-auth`.',
        { cause: err },
      )
    }
    throw normalizeFlowError(err, options.signal, flow.timedOut(), 'ChatGPT browser login timed out.')
  } finally {
    flow.dispose()
    flow.signal.removeEventListener('abort', onAbort)
    await closeServer(server)
  }
}

export async function loginOpenAIChatGPTWithDevice(
  options: OpenAIChatGPTDeviceLoginOptions,
): Promise<OpenAIChatGPTCredentials> {
  const fetchImpl = options.fetch ?? fetch
  if (options.signal?.aborted) throw aborted()
  const timeoutMs = options.timeoutMs ?? DEFAULT_DEVICE_TIMEOUT_MS
  const flow = createFlowSignal(options.signal, timeoutMs)
  try {
    const startResponse = await fetchImpl(`${OPENAI_CHATGPT_OAUTH.issuer}/api/accounts/deviceauth/usercode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(options.userAgent) },
      body: JSON.stringify({ client_id: OPENAI_CHATGPT_OAUTH.clientId }),
      signal: flow.signal,
    })
    if (!startResponse.ok) throw await responseError(startResponse, 'ChatGPT device authorization')
    const device = (await startResponse.json()) as DeviceAuthorizationResponse
    if (!device.device_auth_id || !device.user_code) {
      throw new OpenAIChatGPTAuthError('oauth-failed', 'OpenAI returned an invalid device authorization response.')
    }
    options.onUserCode(`${OPENAI_CHATGPT_OAUTH.issuer}/codex/device`, device.user_code)

    let intervalMs = Math.max(Number.parseInt(String(device.interval ?? '5'), 10) || 5, 1) * 1000
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await wait(Math.min(intervalMs, deadline - Date.now()), flow.signal)
      if (Date.now() >= deadline) break
      const pollResponse = await fetchImpl(`${OPENAI_CHATGPT_OAUTH.issuer}/api/accounts/deviceauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(options.userAgent) },
        body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
        signal: flow.signal,
      })
      if (pollResponse.ok) {
        const result = (await pollResponse.json()) as DeviceTokenResponse
        if (!result.authorization_code || !result.code_verifier) {
          throw new OpenAIChatGPTAuthError('oauth-failed', 'OpenAI returned an invalid device token response.')
        }
        return await exchangeOpenAIChatGPTCode(
          result.authorization_code,
          `${OPENAI_CHATGPT_OAUTH.issuer}/deviceauth/callback`,
          result.code_verifier,
          { ...options, signal: flow.signal },
        )
      }
      let pendingError: string | undefined
      try {
        const pending = (await pollResponse.json()) as { error?: string }
        pendingError = pending.error
      } catch {
        // A body is optional for the endpoint's 403/404 pending responses.
      }
      if (pendingError === 'slow_down') {
        intervalMs += 5_000
        continue
      }
      if (pendingError === 'access_denied' || pendingError === 'expired_token') {
        throw new OpenAIChatGPTAuthError('oauth-failed', `ChatGPT device authorization failed: ${pendingError}`)
      }
      if (pendingError === 'authorization_pending' || pollResponse.status === 403 || pollResponse.status === 404)
        continue
      throw new OpenAIChatGPTAuthError(
        'oauth-failed',
        `ChatGPT device authorization failed (${pollResponse.status})${pendingError ? `: ${pendingError}` : ''}`,
      )
    }
    throw flowTimeout('ChatGPT device login timed out.')
  } catch (err) {
    throw normalizeFlowError(err, options.signal, flow.timedOut(), 'ChatGPT device login timed out.')
  } finally {
    flow.dispose()
  }
}
