import { describe, expect, it } from 'vitest'

import { classifyApiError, extractHttpStatus, isContextTooLongError } from '../src/agent/api-errors.js'

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
  it('returns 0 when no status found', () => {
    expect(extractHttpStatus('some random error')).toBe(0)
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
  it('returns false for unrelated errors', () => {
    expect(isContextTooLongError(new Error('network timeout'))).toBe(false)
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

  it('classifies 402 insufficient balance', () => {
    const result = classifyApiError(new Error('Insufficient Balance (402)'))
    expect(result.message).toContain('balance insufficient')
    expect(result.retryable).toBe(false)
  })

  it('classifies 403 forbidden', () => {
    const result = classifyApiError(new Error('Request failed with status code 403'))
    expect(result.message).toContain('forbidden')
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
    expect(result.message).toContain('Network error')
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
    const result = classifyApiError(new Error("Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"))
    expect(result.message).toContain('orphan tool call')
    expect(result.retryable).toBe(false)
  })

  it('falls through to raw message for unknown errors', () => {
    const result = classifyApiError(new Error('something completely new'))
    expect(result.message).toBe('something completely new')
    expect(result.retryable).toBe(false)
  })
})
