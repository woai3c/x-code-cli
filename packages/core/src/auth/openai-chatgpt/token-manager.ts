import {
  readOpenAIChatGPTCredentials,
  withOpenAIChatGPTCredentialLock,
  writeOpenAIChatGPTCredentials,
} from './credential-store.js'
import { refreshOpenAIChatGPTAccessToken } from './oauth.js'
import { OpenAIChatGPTAuthError } from './types.js'
import type { OpenAIChatGPTCredentials } from './types.js'

const REFRESH_SKEW_MS = 5 * 60 * 1000
const SHARED_REFRESH_TIMEOUT_MS = 30 * 1000

export interface OpenAIChatGPTTokenManagerOptions {
  fetch?: typeof fetch
  userAgent?: string
}

export interface OpenAIChatGPTRequestAuth {
  accessToken: string
  accountId?: string
  isFedRamp?: boolean
}

function waitForSharedRefresh<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('ChatGPT token refresh wait was cancelled.'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('ChatGPT token refresh wait was cancelled.'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

export class OpenAIChatGPTTokenManager {
  private refreshPromise: Promise<OpenAIChatGPTCredentials> | undefined
  private readonly fetchImpl: typeof fetch
  private readonly userAgent?: string

  constructor(options: OpenAIChatGPTTokenManagerOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch
    this.userAgent = options.userAgent
  }

  async getCredentials(signal?: AbortSignal): Promise<OpenAIChatGPTCredentials> {
    const credentials = await readOpenAIChatGPTCredentials()
    if (Date.now() + REFRESH_SKEW_MS < credentials.expiresAt) return credentials
    return this.refresh(credentials.accessToken, false, signal)
  }

  async getRequestAuth(signal?: AbortSignal): Promise<OpenAIChatGPTRequestAuth> {
    const credentials = await this.getCredentials(signal)
    return {
      accessToken: credentials.accessToken,
      accountId: credentials.accountId,
      isFedRamp: credentials.isFedRamp,
    }
  }

  async recoverAfterUnauthorized(failedAccessToken: string, signal?: AbortSignal): Promise<OpenAIChatGPTRequestAuth> {
    const credentials = await this.refresh(failedAccessToken, true, signal)
    return {
      accessToken: credentials.accessToken,
      accountId: credentials.accountId,
      isFedRamp: credentials.isFedRamp,
    }
  }

  private refresh(failedAccessToken: string, force: boolean, signal?: AbortSignal): Promise<OpenAIChatGPTCredentials> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('ChatGPT token refresh wait was cancelled.'))
    if (!this.refreshPromise) {
      const refreshSignal = AbortSignal.timeout(SHARED_REFRESH_TIMEOUT_MS)
      this.refreshPromise = withOpenAIChatGPTCredentialLock(async () => {
        const current = await readOpenAIChatGPTCredentials()
        if (current.accessToken !== failedAccessToken) return current
        if (!force && Date.now() + REFRESH_SKEW_MS < current.expiresAt) return current

        const refreshed = await refreshOpenAIChatGPTAccessToken(current, {
          fetch: this.fetchImpl,
          userAgent: this.userAgent,
          signal: refreshSignal,
        })
        if (current.accountId && refreshed.accountId && current.accountId !== refreshed.accountId) {
          throw new OpenAIChatGPTAuthError(
            'credentials-invalid',
            'The refreshed ChatGPT account does not match the signed-in account. Run `xc logout`, then `xc login`.',
          )
        }
        await writeOpenAIChatGPTCredentials(refreshed)
        return refreshed
      }, refreshSignal).finally(() => {
        this.refreshPromise = undefined
      })
    }
    return waitForSharedRefresh(this.refreshPromise, signal)
  }
}

let defaultManager: OpenAIChatGPTTokenManager | undefined

export function getOpenAIChatGPTTokenManager(): OpenAIChatGPTTokenManager {
  if (!defaultManager) defaultManager = new OpenAIChatGPTTokenManager({ userAgent: 'x-code-cli' })
  return defaultManager
}

export function setOpenAIChatGPTTokenManagerForTesting(manager: OpenAIChatGPTTokenManager | undefined): void {
  defaultManager = manager
}
