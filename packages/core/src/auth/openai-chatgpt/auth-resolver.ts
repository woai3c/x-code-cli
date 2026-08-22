import { hasOpenAIChatGPTCredentials, readOpenAIChatGPTCredentialsSync } from './credential-store.js'
import type { OpenAIAuthContext, OpenAIAuthStatus } from './types.js'

let activeContext: OpenAIAuthContext | undefined

function resolveUncached(): OpenAIAuthContext {
  if (hasOpenAIChatGPTCredentials()) return { mode: 'chatgpt' }
  const apiKey = process.env.OPENAI_API_KEY
  return apiKey ? { mode: 'api-key', apiKey } : { mode: 'none' }
}

export function initializeOpenAIAuthContext(): OpenAIAuthContext {
  activeContext = resolveUncached()
  return activeContext
}

export function getOpenAIAuthContext(): OpenAIAuthContext {
  return activeContext ?? resolveUncached()
}

export function getOpenAIAuthStatus(): OpenAIAuthStatus {
  const context = getOpenAIAuthContext()
  const base: OpenAIAuthStatus = {
    mode: context.mode,
    apiKeyConfigured: !!process.env.OPENAI_API_KEY,
    apiKeyActive: context.mode === 'api-key',
  }
  if (context.mode !== 'chatgpt') return base
  try {
    const credentials = readOpenAIChatGPTCredentialsSync()
    return {
      ...base,
      accountId: credentials.accountId,
      email: credentials.email,
      planType: credentials.planType,
      expiresAt: credentials.expiresAt,
    }
  } catch (err) {
    return {
      ...base,
      credentialError: err instanceof Error ? err.message : 'Stored ChatGPT credentials are invalid.',
    }
  }
}

export function resetOpenAIAuthContextForTesting(): void {
  activeContext = undefined
}
