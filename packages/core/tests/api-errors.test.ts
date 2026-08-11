import { describe, expect, it } from 'vitest'

import {
  classifyApiError,
  extractHttpStatus,
  isContextTooLongError,
  isImageDataError,
} from '../src/agent/api-errors.js'

describe('extractHttpStatus', () => {
  it('extracts "status code NNN"', () => {
    expect(extractHttpStatus('Request failed with status code 429')).toBe(429)
  })
  it('extracts "(NNN)"', () => {
    expect(extractHttpStatus('Error (401) Unauthorized')).toBe(401)
  })
  it('extracts leading NNN', () => {
    expect(extractHttpStatus('503 Service Unavailable')).toBe(503)
  })
  it('extracts HTTP NNN from an SDK retry wrapper', () => {
    expect(extractHttpStatus('Failed after 4 attempts. Last error: AI_APICallError: scripted HTTP 503')).toBe(503)
  })
})

describe('isContextTooLongError', () => {
  it('detects context_length_exceeded', () => {
    expect(isContextTooLongError(new Error('context_length_exceeded'))).toBe(true)
  })
  it('detects maximum context length', () => {
    expect(isContextTooLongError(new Error('maximum context length is 128000'))).toBe(true)
  })
  it('detects prompt is too long', () => {
    expect(isContextTooLongError(new Error('prompt is too long'))).toBe(true)
  })
  it('detects HTTP 413 (permanentErrorFetch rewrites context overflow to 413)', () => {
    expect(isContextTooLongError(new Error('Request failed with status code 413'))).toBe(true)
  })
})

describe('isImageDataError', () => {
  it('detects Anthropic phrasing', () => {
    expect(isImageDataError(new Error('400 Could not process the image'))).toBe(true)
  })
  it('detects OpenAI phrasing', () => {
    expect(isImageDataError(new Error('Invalid image data (400)'))).toBe(true)
  })
  it('detects size-limit phrasing', () => {
    expect(isImageDataError(new Error('image too large: max 5MB per image'))).toBe(true)
  })
  it('detects Gemini parse error', () => {
    expect(isImageDataError(new Error('image_parse_error: unable to decode'))).toBe(true)
  })
  it('does not fire on generic 400s', () => {
    expect(isImageDataError(new Error('400 Bad Request: unknown parameter foo'))).toBe(false)
  })
  it('does not fire on rate limits', () => {
    expect(isImageDataError(new Error('Request failed with status code 429'))).toBe(false)
  })
})

describe('classifyApiError', () => {
  it('classifies context too long', () => {
    const result = classifyApiError(new Error('maximum context length exceeded'))
    expect(result.message).toContain('Context too long')
    expect(result.retryable).toBe(false)
  })

  it('classifies missing API key', () => {
    const result = classifyApiError(new Error('Anthropic API key is missing'))
    expect(result.message).toContain('API key is not set')
    expect(result.message).toContain('Anthropic')
    expect(result.retryable).toBe(false)
  })

  it('classifies 401 unauthorized', () => {
    const result = classifyApiError(new Error('Request failed with status code 401'))
    expect(result.message).toContain('authentication failed')
    expect(result.retryable).toBe(false)
  })

  it('uses the SDK statusCode when the provider message omits the HTTP status', () => {
    const error = Object.assign(new Error('invalid test credential'), { statusCode: 401 })
    const result = classifyApiError(error)
    expect(result.message).toContain('authentication failed')
    expect(result.message).not.toContain('invalid test credential')
  })

  it('classifies 402 insufficient balance', () => {
    const result = classifyApiError(new Error('Insufficient Balance (402)'))
    expect(result.message).toContain('balance insufficient')
    expect(result.retryable).toBe(false)
  })

  it('classifies Moonshot suspended-account billing error (HTTP 429 body)', () => {
    // Real Moonshot error: HTTP 429 with body saying the account is
    // suspended for insufficient balance. Must classify as billing (not
    // rate-limit) so the user is told to top up / switch provider rather
    // than told to wait for a retry.
    const result = classifyApiError(
      new Error(
        'Your account org-xxx <ak-yyy> is suspended due to insufficient balance, please recharge your account (429)',
      ),
    )
    expect(result.message).toContain('balance insufficient')
    expect(result.retryable).toBe(false)
  })

  it('classifies 403 forbidden', () => {
    const result = classifyApiError(new Error('Request failed with status code 403'))
    expect(result.message).toContain('forbidden')
    expect(result.retryable).toBe(false)
  })

  it('classifies 404 model not found by status', () => {
    const result = classifyApiError(new Error('Request failed with status code 404'))
    expect(result.message).toContain('Model not found')
    expect(result.retryable).toBe(false)
  })

  it('classifies model_not_found by body keyword', () => {
    const result = classifyApiError(new Error('The model `kimi-k99` does not exist (500)'))
    expect(result.message).toContain('Model not found')
    expect(result.retryable).toBe(false)
  })

  it('classifies 422 content policy by status', () => {
    const result = classifyApiError(new Error('Request failed with status code 422'))
    expect(result.message).toContain('safety filter')
    expect(result.retryable).toBe(false)
  })

  it('classifies content_filter by body keyword', () => {
    const result = classifyApiError(new Error('content_filter_triggered: prompt rejected (500)'))
    expect(result.message).toContain('safety filter')
    expect(result.retryable).toBe(false)
  })

  it('classifies 429 rate limit as retryable', () => {
    const result = classifyApiError(new Error('Request failed with status code 429'))
    expect(result.message).toContain('Rate limited')
    expect(result.retryable).toBe(true)
  })

  it('classifies 503 service unavailable', () => {
    const result = classifyApiError(new Error('503 Service Unavailable'))
    expect(result.message).toContain('unavailable')
    expect(result.retryable).toBe(false)
  })

  it('classifies network timeouts as retryable', () => {
    const result = classifyApiError(new Error('ETIMEDOUT'))
    expect(result.message).toContain('Network connection failed')
    expect(result.retryable).toBe(true)
  })

  it('normalizes SDK transport wrappers without leaking internal error types', () => {
    const result = classifyApiError(
      new Error('Failed after 4 attempts. Last error: AI_APICallError: Cannot connect to API: other side closed'),
    )
    expect(result.message).toBe('Network connection failed or was interrupted. Check your connection and try again.')
    expect(result.message).not.toContain('AI_APICallError')
    expect(result.retryable).toBe(true)
  })

  it('classifies max_tokens errors', () => {
    const result = classifyApiError(new Error('Invalid max_tokens: 999999'))
    expect(result.message).toContain('max_tokens')
    expect(result.retryable).toBe(false)
  })

  it('classifies DeepSeek reasoning_content error', () => {
    const result = classifyApiError(new Error('Missing `reasoning_content` in assistant message'))
    expect(result.message).toContain('reasoning_content')
    expect(result.retryable).toBe(false)
  })

  it('classifies malformed tool history', () => {
    const result = classifyApiError(
      new Error("Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"),
    )
    expect(result.message).toContain('orphan tool call')
    expect(result.retryable).toBe(false)
  })

  it('falls through to raw message for unknown errors', () => {
    const result = classifyApiError(new Error('something completely new'))
    expect(result.message).toBe('something completely new')
    expect(result.retryable).toBe(false)
  })
})
