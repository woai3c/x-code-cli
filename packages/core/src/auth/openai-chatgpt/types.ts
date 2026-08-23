export interface OpenAIChatGPTCredentials {
  version: 1
  authRevision?: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId?: string
  idToken?: string
  email?: string
  planType?: string
  isFedRamp?: boolean
}

export interface OpenAIChatGPTTokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
}

export interface OpenAIChatGPTJwtClaims {
  email?: string
  exp?: number
  chatgpt_account_id?: string
  organizations?: Array<{ id?: string }>
  'https://api.openai.com/profile'?: { email?: string }
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string
    chatgpt_plan_type?: string
    chatgpt_user_id?: string
    user_id?: string
    chatgpt_account_is_fedramp?: boolean
  }
}

export class OpenAIChatGPTAuthError extends Error {
  readonly code: 'cancelled' | 'credentials-invalid' | 'login-required' | 'oauth-failed' | 'state-mismatch' | 'timeout'

  constructor(code: OpenAIChatGPTAuthError['code'], message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OpenAIChatGPTAuthError'
    this.code = code
  }
}

export type OpenAIAuthContext = { mode: 'chatgpt' } | { mode: 'api-key'; apiKey: string } | { mode: 'none' }

export interface OpenAIAuthStatus {
  mode: OpenAIAuthContext['mode']
  apiKeyConfigured: boolean
  apiKeyActive: boolean
  accountId?: string
  email?: string
  planType?: string
  expiresAt?: number
  credentialError?: string
}
