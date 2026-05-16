// @x-code-cli/core — AI SDK Provider Registry (multi-model support)
import { zhipu } from 'zhipu-ai-provider'

import { createAlibaba } from '@ai-sdk/alibaba'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createMoonshotAI } from '@ai-sdk/moonshotai'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createXai } from '@ai-sdk/xai'
import { createProviderRegistry } from 'ai'

import { getProviderOptions } from '../config/index.js'

export function createModelRegistry() {
  const opts = getProviderOptions()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providers: Record<string, any> = {}

  if (opts.anthropic) providers.anthropic = createAnthropic({ fetch: permanentErrorFetch })
  if (opts.openai) providers.openai = createOpenAI({ fetch: permanentErrorFetch })
  if (opts.google) providers.google = createGoogleGenerativeAI({ fetch: permanentErrorFetch })
  if (opts.xai) providers.xai = createXai({ fetch: permanentErrorFetch })
  if (opts.deepseek) providers.deepseek = createDeepSeek({ fetch: deepseekReasoningFetch })
  if (opts.alibaba) {
    providers.alibaba = createAlibaba({
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      fetch: permanentErrorFetch,
    })
  }
  if (opts.zhipu) providers.zhipu = zhipu
  if (opts.moonshotai) providers.moonshotai = createMoonshotAI({ fetch: permanentErrorFetch })

  // Custom OpenAI compatible provider
  if (opts.custom.apiKey && opts.custom.baseURL) {
    providers.custom = createOpenAICompatible({
      name: 'custom',
      apiKey: opts.custom.apiKey,
      baseURL: opts.custom.baseURL,
      fetch: permanentErrorFetch,
    })
  }

  return createProviderRegistry(providers)
}

/**
 * Back-fill `reasoning_content: ""` on every assistant message in the request
 * body before it reaches DeepSeek V4. The upstream `@ai-sdk/deepseek` converter
 * (convert-to-deepseek-chat-messages.ts) strips `reasoning_content` from any
 * assistant message at or before the last user message — correct for
 * deepseek-reasoner (R1), which forbids passing reasoning back, but wrong for
 * deepseek-v4-*, which *requires* it. Without this, the second turn 400s with
 * "reasoning_content in the thinking mode must be passed back to the API."
 * Scoped to v4 so R1 keeps its documented behavior. Remove once upstream
 * differentiates by model.
 */
const deepseekReasoningFetch: typeof fetch = async (input, init) => {
  // Forward through permanentErrorFetch so DeepSeek requests get BOTH
  // the v4 reasoning_content backfill AND the billing-error short-circuit.
  if (!init?.body || typeof init.body !== 'string') return permanentErrorFetch(input, init)

  try {
    const body = JSON.parse(init.body) as { model?: string; messages?: Array<Record<string, unknown>> }
    if (typeof body.model === 'string' && body.model.includes('deepseek-v4') && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg.role === 'assistant' && msg.reasoning_content == null) {
          msg.reasoning_content = ''
        }
      }
      return permanentErrorFetch(input, { ...init, body: JSON.stringify(body) })
    }
  } catch {
    // Body wasn't JSON we recognize — pass through unchanged.
  }

  return permanentErrorFetch(input, init)
}

/**
 * Body-keyword → non-retryable status mapping. SDK's `APICallError` marks
 * 408 / 409 / 429 / 5xx as `isRetryable: true`; any 4xx outside that set is
 * non-retryable. Each entry below catches a "this will never succeed by
 * retrying" failure mode that providers nonetheless return with retryable
 * status codes (most commonly Moonshot using 429 for billing). Pick a
 * semantically-honest target status so `classifyApiError` downstream can
 * also use the status alone to emit the right recovery hint.
 *
 * Order matters: first category whose pattern matches wins. Keep billing /
 * context-length above content-policy / auth — they are the most specific.
 */
type PermanentErrorMatcher = string | RegExp

const PERMANENT_ERROR_CATEGORIES: ReadonlyArray<{
  status: number
  statusText: string
  patterns: readonly PermanentErrorMatcher[]
}> = [
  {
    // 402 Payment Required — account out of funds / quota exhausted.
    // Real example: Moonshot returns HTTP 429 with body
    // `{"error":{"message":"... is suspended due to insufficient balance,
    //   please recharge ...","type":"exceeded_current_quota_error"}}`.
    // DeepSeek returns "Insufficient Balance" with HTTP 400 (already
    // non-retryable; rewriting to 402 only normalizes the status so the
    // classifier emits the same friendly hint).
    status: 402,
    statusText: 'Payment Required',
    patterns: [
      'insufficient balance',
      'insufficient_balance',
      'insufficient_quota',
      'insufficient quota',
      'exceeded_current_quota',
      'exceeded your current quota',
      'suspended due to insufficient',
      'please recharge',
    ],
  },
  {
    // 413 Payload Too Large — prompt exceeded the model's context window.
    // Same prompt will keep overflowing — only /compact or /clear or a
    // model swap fixes it.
    status: 413,
    statusText: 'Payload Too Large',
    patterns: [
      'context_length_exceeded',
      'context length exceeded',
      'maximum context length',
      'prompt is too long',
      'prompt_too_long',
      'context window',
    ],
  },
  {
    // 422 Unprocessable Entity — provider's safety filter blocked the
    // request or response. Retrying the same content reproduces the same
    // block; the user has to rephrase or switch models.
    status: 422,
    statusText: 'Unprocessable Entity',
    patterns: [
      'content_policy_violation',
      'content_filter_triggered',
      'content_filter',
      'content_policy',
      'input_blocked',
      'harmful_content',
      'unsafe content',
      'safety_violation',
    ],
  },
  {
    // 401 Unauthorized — auth-related failures that occasionally leak
    // through a 5xx or 429 due to upstream proxy / gateway misconfig.
    // Retrying with the same (bad) key fails identically.
    status: 401,
    statusText: 'Unauthorized',
    patterns: [
      'invalid api key',
      'invalid_api_key',
      'incorrect api key',
      'api key not found',
      'api_key_invalid',
      'expired api key',
    ],
  },
  {
    // 404 Not Found — model id is wrong, deprecated, or not enabled for
    // this account. Some providers return 5xx instead of 404 when the
    // model alias is unrecognized; this normalizes it. The regex catches
    // OpenAI's "The model `gpt-x` does not exist or you do not have
    // access..." where the model name sits between the two tokens.
    status: 404,
    statusText: 'Not Found',
    patterns: ['model_not_found', 'model not found', 'unknown model', /\bmodel\b[^]*?\bdoes not exist\b/],
  },
] as const

/**
 * Intercept upstream error responses (4xx / 5xx) that describe a permanent
 * failure but use a retryable HTTP status, and rewrite their status to a
 * non-retryable code BEFORE the AI SDK parses them. SDK's `APICallError`
 * constructor computes `isRetryable` from the status — anything outside
 * {408, 409, 429, 5xx} comes out false — so the SDK's
 * `_retryWithExponentialBackoff` bails on the first attempt instead of
 * burning ~30s and a `RetryError` wrapper on a problem retries cannot fix.
 *
 * Body-detection only — error responses without a matching keyword pass
 * through unchanged, so real rate limits / network blips / 5xx hiccups
 * still benefit from SDK's normal retry. Successful responses (`< 400`)
 * are never read so SSE streams are untouched.
 */
const permanentErrorFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)
  // Streaming/successful responses are off-limits: reading their body would
  // consume the SSE stream the SDK is about to parse.
  if (response.status < 400) return response

  const text = await response
    .clone()
    .text()
    .catch(() => '')
  if (!text) return response

  const lower = text.toLowerCase()
  for (const category of PERMANENT_ERROR_CATEGORIES) {
    const hit = category.patterns.some((p) => (typeof p === 'string' ? lower.includes(p) : p.test(lower)))
    if (!hit) continue
    // No-op when the provider already used the right status code.
    if (response.status === category.status) return response
    // Preserve the body verbatim — the SDK's error parser still extracts
    // the provider's message field from it, which classifyApiError then
    // sees and routes to the right friendly hint.
    return new Response(text, {
      status: category.status,
      statusText: category.statusText,
      headers: response.headers,
    })
  }
  return response
}
