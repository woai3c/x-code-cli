import {
  readOpenAIChatGPTCredentials,
  withOpenAIChatGPTCredentialLock,
  writeOpenAIChatGPTCredentials,
} from './credential-store.js'
import { refreshOpenAIChatGPTAccessToken } from './oauth.js'
import { OpenAIChatGPTAuthError } from './types.js'
import type { OpenAIChatGPTCredentials } from './types.js'

const REFRESH_SKEW_MS = 5 * 60 * 1000

export interface OpenAIChatGPTTokenManagerOptions {
  fetch?: typeof fetch
  userAgent?: string
}

export interface OpenAIChatGPTRequestAuth {
  accessToken: string
  accountId?: string
  isFedRamp?: boolean
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
    if (!this.refreshPromise) {
      this.refreshPromise = withOpenAIChatGPTCredentialLock(async () => {
        const current = await readOpenAIChatGPTCredentials()
        if (current.accessToken !== failedAccessToken) return current
        if (!force && Date.now() + REFRESH_SKEW_MS < current.expiresAt) return current

        const refreshed = await refreshOpenAIChatGPTAccessToken(current, {
          fetch: this.fetchImpl,
          userAgent: this.userAgent,
          signal,
        })
        if (current.accountId && refreshed.accountId && current.accountId !== refreshed.accountId) {
          throw new OpenAIChatGPTAuthError(
            'credentials-invalid',
            'The refreshed ChatGPT account does not match the signed-in account. Run `xc logout`, then `xc login`.',
          )
        }
        await writeOpenAIChatGPTCredentials(refreshed)
        return refreshed
      }, signal).finally(() => {
        this.refreshPromise = undefined
      })
    }
    return this.refreshPromise
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
