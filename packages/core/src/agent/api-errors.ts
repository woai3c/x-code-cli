// @x-code-cli/core — API error classification & pattern detection

/** Substrings that signal the request exceeded the model's context window. */
const CONTEXT_TOO_LONG_PATTERNS = [
  'maximum context length',
  'context_length_exceeded',
  'token limit',
  'prompt is too long',
  'prompt_too_long',
] as const

/** Extract HTTP status from "status code 400", "(400)", or "400 ..." */
export function extractHttpStatus(msg: string): number {
  const match =
    msg.match(/\bstatus(?:\s+code)?\s+(\d{3})\b/i) ?? msg.match(/\((\d{3})\)/) ?? msg.match(/^(\d{3})\s/)
  return match ? Number(match[1]) : 0
}

/** True when an error message indicates the request exceeded the context window. */
export function isContextTooLongError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  for (const pattern of CONTEXT_TOO_LONG_PATTERNS) {
    if (msg.includes(pattern)) return true
  }
  return false
}

export interface ClassifiedError {
  message: string
  retryable: boolean
}

/** Classify API error and return a user-friendly recovery message. */
export function classifyApiError(err: unknown): ClassifiedError {
  const msg = err instanceof Error ? err.message : String(err)
  const status = extractHttpStatus(msg)

  if (isContextTooLongError(err)) {
    return {
      message:
        "Context too long — the conversation exceeded the model's token limit. Try /compact to compress context, or /clear to start fresh.",
      retryable: false,
    }
  }
  if (msg.includes('Missing `reasoning_content`') || msg.includes('reasoning_content')) {
    return {
      message:
        'DeepSeek Reasoner requires reasoning_content in assistant messages during tool-call chains. This is usually an SDK compatibility issue — please report it.',
      retryable: false,
    }
  }
  if (msg.includes('API key is missing') || msg.includes('API_KEY')) {
    const providerMatch = msg.match(/^(\w+)\s+API key/i)
    const provider = providerMatch ? providerMatch[1] : 'Provider'
    return {
      message: `${provider} API key is not set. Please set the corresponding environment variable (e.g. ${provider.toUpperCase()}_API_KEY).`,
      retryable: false,
    }
  }
  if (status === 401 || msg.includes('Unauthorized') || msg.includes('Invalid API Key')) {
    return {
      message: 'API authentication failed (401). Please check your API key with /model or reconfigure with `xc init`.',
      retryable: false,
    }
  }
  if (status === 403 || msg.includes('Forbidden')) {
    return {
      message: 'API access forbidden (403). Your API key may not have permission for this model.',
      retryable: false,
    }
  }
  if (status === 503 || msg.includes('Service Unavailable') || msg.includes('overloaded')) {
    return {
      message: 'Model service unavailable (503). Try switching to a different model with /model.',
      retryable: false,
    }
  }
  if (status === 429 || msg.includes('rate limit') || msg.includes('Rate limit')) {
    return {
      message:
        'Rate limited (429). Waiting for retry... (AI SDK handles exponential backoff automatically with maxRetries: 3)',
      retryable: true,
    }
  }
  if (msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')) {
    return {
      message: `Network error: ${msg}. Retrying...`,
      retryable: true,
    }
  }
  return { message: msg, retryable: false }
}
