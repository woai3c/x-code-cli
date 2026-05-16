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

/** True when an error message indicates the request exceeded the context window.
 *  Also matches HTTP 413, which `permanentErrorFetch` rewrites context-overflow
 *  responses to so the SDK marks them non-retryable. */
export function isContextTooLongError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  if (extractHttpStatus(msg) === 413) return true
  for (const pattern of CONTEXT_TOO_LONG_PATTERNS) {
    if (msg.includes(pattern)) return true
  }
  return false
}

export interface ClassifiedError {
  message: string
  retryable: boolean
}

// ── Error-shape predicates ───────────────────────────────────────────────
// Each predicate matches one provider failure mode. Keeping them as named
// helpers keeps classifyApiError() readable and gives unit tests a clean
// hook to assert on individual cases without driving the full classifier.

function isReasoningContentError(msg: string): boolean {
  // DeepSeek Reasoner requires reasoning_content on assistant messages
  // during tool-call chains; both phrasings appear in the wild.
  return msg.includes('Missing `reasoning_content`') || msg.includes('reasoning_content')
}

function isMissingApiKeyError(msg: string): boolean {
  return msg.includes('API key is missing') || msg.includes('API_KEY')
}

function isUnauthorizedError(msg: string, status: number): boolean {
  return status === 401 || msg.includes('Unauthorized') || msg.includes('Invalid API Key')
}

function isInsufficientBalanceError(msg: string, status: number): boolean {
  if (status === 402) return true
  // Case-insensitive: providers are inconsistent — DeepSeek returns
  // "Insufficient Balance", OpenAI uses "insufficient_quota", Moonshot
  // returns HTTP 429 with body "is suspended due to insufficient balance,
  // please recharge your account" (lowercase, spaced). Without the
  // permissive match Moonshot's billing failure falls through to the 429
  // rate-limit branch and gets retried 4 times before surfacing as a
  // RetryError, which is the exact opposite of what the user needs.
  const lower = msg.toLowerCase()
  return (
    lower.includes('insufficient balance') ||
    lower.includes('insufficient_balance') ||
    lower.includes('insufficient_quota') ||
    lower.includes('insufficient quota') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('exceeded_current_quota') ||
    lower.includes('suspended due to insufficient') ||
    lower.includes('please recharge')
  )
}

function isForbiddenError(msg: string, status: number): boolean {
  return status === 403 || msg.includes('Forbidden')
}

function isMaxTokensError(msg: string): boolean {
  if (msg.includes('Invalid max_tokens') || msg.includes('Range of max_tokens') || msg.includes('InvalidParameter')) {
    return true
  }
  // Catch-all: any "max_tokens" reference combined with an invalid/range marker.
  if (!msg.includes('max_tokens')) return false
  return /invalid|range/i.test(msg)
}

function isServiceUnavailableError(msg: string, status: number): boolean {
  return status === 503 || msg.includes('Service Unavailable') || msg.includes('overloaded')
}

/** Provider safety/moderation filter blocked the content. permanentErrorFetch
 *  rewrites matching bodies to HTTP 422 so this fires on status alone; the
 *  pattern fallback catches cases that bypass the fetch shim (other entry
 *  points, alternate providers). */
function isContentPolicyError(msg: string, status: number): boolean {
  if (status === 422) return true
  const lower = msg.toLowerCase()
  return (
    lower.includes('content_policy_violation') ||
    lower.includes('content_filter_triggered') ||
    lower.includes('content_filter') ||
    lower.includes('content_policy') ||
    lower.includes('input_blocked') ||
    lower.includes('harmful_content') ||
    lower.includes('safety_violation')
  )
}

/** Model id unknown to the provider (typo / deprecated / not entitled).
 *  permanentErrorFetch normalizes matching 5xx/429 bodies to 404; the pattern
 *  list catches providers that already return 404 with a descriptive body. */
function isModelNotFoundError(msg: string, status: number): boolean {
  if (status === 404) return true
  const lower = msg.toLowerCase()
  // "model ... does not exist" — OpenAI inserts the model name between
  // the two tokens, so we can't match the literal phrase; require both
  // tokens present anywhere in the body.
  if (lower.includes('model') && lower.includes('does not exist')) return true
  return lower.includes('model_not_found') || lower.includes('model not found') || lower.includes('unknown model')
}

function isRateLimitedError(msg: string, status: number): boolean {
  return status === 429 || /rate limit/i.test(msg)
}

function isNetworkError(msg: string): boolean {
  return msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')
}

function isTypeValidationError(err: unknown, msg: string): boolean {
  return (
    (err instanceof Error && err.constructor.name === 'AI_TypeValidationError') ||
    msg.includes('Type validation failed')
  )
}

/** Provider rejection due to malformed tool_call ↔ tool_result pairing
 *  in the message history. Most often surfaces against DeepSeek with a
 *  specific wording; OpenAI and others have variants. The
 *  `repairOrphanToolCalls` sweep in `runTurn` should prevent this from
 *  happening — but if it leaks through (or for older session state),
 *  surface a directly actionable message instead of the raw provider
 *  dump. */
function isMalformedToolHistoryError(msg: string): boolean {
  return (
    msg.includes("Messages with role 'tool' must be a response to a preceding message with 'tool_calls'") ||
    msg.includes('tool_calls and tool_call_ids') ||
    msg.includes('tool_call_id')
  )
}

/** Pull a provider name out of "Anthropic API key is missing" → "Anthropic". */
function extractProviderName(msg: string): string {
  const m = msg.match(/^(\w+)\s+API key/i)
  return m ? m[1]! : 'Provider'
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
  if (isReasoningContentError(msg)) {
    return {
      message:
        'DeepSeek Reasoner requires reasoning_content in assistant messages during tool-call chains. This is usually an SDK compatibility issue — please report it.',
      retryable: false,
    }
  }
  if (isMissingApiKeyError(msg)) {
    const provider = extractProviderName(msg)
    return {
      message: `${provider} API key is not set. Please set the corresponding environment variable (e.g. ${provider.toUpperCase()}_API_KEY).`,
      retryable: false,
    }
  }
  if (isUnauthorizedError(msg, status)) {
    return {
      message: 'API authentication failed (401). Please check your API key with /model or reconfigure with `xc init`.',
      retryable: false,
    }
  }
  if (isInsufficientBalanceError(msg, status)) {
    return {
      message:
        'API account balance insufficient (402). Top up your provider account, or switch to a different provider with /model.',
      retryable: false,
    }
  }
  if (isForbiddenError(msg, status)) {
    return {
      message: 'API access forbidden (403). Your API key may not have permission for this model.',
      retryable: false,
    }
  }
  if (isModelNotFoundError(msg, status)) {
    return {
      message:
        'Model not found (404). The id may be wrong, deprecated, or not enabled for your account. Switch with /model.',
      retryable: false,
    }
  }
  if (isContentPolicyError(msg, status)) {
    return {
      message:
        "Content blocked by the provider's safety filter (422). Rephrase the request or try a different model with /model.",
      retryable: false,
    }
  }
  if (isMaxTokensError(msg)) {
    return {
      message:
        "The configured max_tokens exceeds this model's limit. Try switching to a different model with /model, or report this issue so we can add the correct ceiling.",
      retryable: false,
    }
  }
  if (isServiceUnavailableError(msg, status)) {
    return {
      message: 'Model service unavailable (503). Try switching to a different model with /model.',
      retryable: false,
    }
  }
  if (isRateLimitedError(msg, status)) {
    return {
      message:
        'Rate limited (429). Waiting for retry... (AI SDK handles exponential backoff automatically with maxRetries: 3)',
      retryable: true,
    }
  }
  if (isNetworkError(msg)) {
    return {
      message: `Network error: ${msg}. Retrying...`,
      retryable: true,
    }
  }
  // AI SDK TypeValidationError — provider returned a non-standard response
  // (e.g. an error JSON body instead of a valid SSE stream). Surface the
  // provider's error message rather than the raw Zod validation dump.
  if (isTypeValidationError(err, msg)) {
    return {
      message: `Provider returned an error: ${msg}. Try a different model with /model.`,
      retryable: false,
    }
  }
  if (isMalformedToolHistoryError(msg)) {
    return {
      message:
        'Conversation history has an orphan tool call (model emitted a malformed tool input that the SDK rejected). The next turn will auto-repair, but if this keeps happening you can /clear to reset the conversation.',
      retryable: false,
    }
  }

  return { message: msg, retryable: false }
}
