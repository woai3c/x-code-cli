// @x-code-cli/core — API error classification & pattern detection

/** Substrings that signal the request exceeded the model's context window. */
const CONTEXT_TOO_LONG_PATTERNS = [
  'maximum context length',
  'context_length_exceeded',
  'token limit',
  'prompt is too long',
  'prompt_too_long',
  'input tokens',
  'context window',
] as const

/** Extract HTTP status from "status code 400", "(400)", or "400 ..." */
export function extractHttpStatus(msg: string): number {
  const match = msg.match(/\bstatus(?:\s+code)?\s+(\d{3})\b/i) ?? msg.match(/\((\d{3})\)/) ?? msg.match(/^(\d{3})\s/)
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

/**
 * Extract a meaningful error message from AI SDK errors. TypeValidationError
 * (thrown when a provider returns non-standard JSON — e.g. Alibaba returning
 * an error object instead of an SSE stream) embeds the real provider message
 * inside its `.value` property. We dig it out so classifyApiError can pattern-
 * match on the actual provider error, not the Zod validation wrapper.
 */
function extractErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const msg = err.message
  // AI SDK TypeValidationError: the real provider error lives in `.value`
  const val = (err as unknown as Record<string, unknown>).value
  if (val && typeof val === 'object') {
    const inner = (val as Record<string, unknown>).error
    if (inner && typeof inner === 'object') {
      const innerMsg = (inner as Record<string, string>).message
      if (typeof innerMsg === 'string') return innerMsg
    }
  }
  return msg
}

/** Classify API error and return a user-friendly recovery message. */
export function classifyApiError(err: unknown): ClassifiedError {
  const msg = extractErrorMessage(err)
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
  if (
    status === 402 ||
    msg.includes('Insufficient Balance') ||
    msg.includes('insufficient_balance') ||
    msg.includes('insufficient_quota') ||
    msg.includes('exceeded your current quota')
  ) {
    return {
      message:
        'API account balance insufficient (402). Top up your provider account, or switch to a different provider with /model.',
      retryable: false,
    }
  }
  if (status === 403 || msg.includes('Forbidden')) {
    return {
      message: 'API access forbidden (403). Your API key may not have permission for this model.',
      retryable: false,
    }
  }
  if (
    msg.includes('Invalid max_tokens') ||
    msg.includes('Range of max_tokens') ||
    msg.includes('InvalidParameter') ||
    (msg.includes('max_tokens') && (msg.includes('invalid') || msg.includes('Invalid') || msg.includes('range') || msg.includes('Range')))
  ) {
    return {
      message:
        'The configured max_tokens exceeds this model\'s limit. Try switching to a different model with /model, or report this issue so we can add the correct ceiling.',
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
  // AI SDK TypeValidationError — provider returned a non-standard response
  // (e.g. an error JSON body instead of a valid SSE stream). Surface the
  // provider's error message rather than the raw Zod validation dump.
  if (
    (err instanceof Error && err.constructor.name === 'AI_TypeValidationError') ||
    msg.includes('Type validation failed')
  ) {
    return {
      message: `Provider returned an error: ${msg}. Try a different model with /model.`,
      retryable: false,
    }
  }

  return { message: msg, retryable: false }
}
