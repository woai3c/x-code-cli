// @x-code-cli/core — AI SDK Provider Registry (multi-model support)
import { createAlibaba } from '@ai-sdk/alibaba'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogle } from '@ai-sdk/google'
import { createMoonshotAI } from '@ai-sdk/moonshotai'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createXai } from '@ai-sdk/xai'
import { createProviderRegistry, customProvider } from 'ai'

import { getOpenAIAuthSnapshot, refreshOpenAIAuthSnapshot } from '../auth/openai-chatgpt/auth-resolver.js'
import type { OpenAIAuthSnapshot } from '../auth/openai-chatgpt/auth-resolver.js'
import { getOpenAIChatGPTTokenManager } from '../auth/openai-chatgpt/token-manager.js'
import { getProviderOptions, loadUserConfig } from '../config/index.js'
import { createOpenAIChatGPTFetch } from './openai-chatgpt-fetch.js'

const KIMI_CODING_MODEL_IDS = {
  'kimi-k3': 'k3',
  'kimi-k2.7-code': 'kimi-for-coding',
  'kimi-k2.7-code-highspeed': 'kimi-for-coding-highspeed',
  // Coding Plan exposes K2.6 by disabling thinking on kimi-for-coding rather
  // than through a standalone model id.
  'kimi-k2.6': 'kimi-for-coding',
} as const

export function kimiCodingModelId(modelId: string): string {
  return KIMI_CODING_MODEL_IDS[modelId as keyof typeof KIMI_CODING_MODEL_IDS] ?? modelId
}

function unavailableOpenAIResponse(message: string): Response {
  return Response.json({ error: { message } }, { status: 401 })
}

function createOpenAIAuthFetch(providerSnapshot: OpenAIAuthSnapshot): typeof fetch {
  const chatGPTFetch = createOpenAIChatGPTFetch({
    tokenManager: getOpenAIChatGPTTokenManager(),
    fetch: permanentErrorFetch,
    userAgent: 'x-code-cli',
  })
  return async (input, init) => {
    const current = await refreshOpenAIAuthSnapshot()
    if (current.revision !== providerSnapshot.revision) {
      return unavailableOpenAIResponse(
        'OpenAI authentication changed in another process before this request was sent. Retry the request with the active authentication method.',
      )
    }
    if (providerSnapshot.context.mode === 'chatgpt') return chatGPTFetch(input, init)
    if (providerSnapshot.context.mode === 'api-key') return permanentErrorFetch(input, init)
    return unavailableOpenAIResponse('No active OpenAI credentials remain. Run /login.')
  }
}

export function createModelRegistry() {
  const opts = getProviderOptions()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providers: Record<string, any> = {}
  const config = loadUserConfig()

  if (opts.anthropic) providers.anthropic = createAnthropic({ fetch: permanentErrorFetch })
  const openAIAuth = getOpenAIAuthSnapshot()
  if (openAIAuth.context.mode !== 'none') {
    providers.openai = createOpenAI({
      apiKey: openAIAuth.context.mode === 'api-key' ? openAIAuth.context.apiKey : 'x-code-dynamic-openai-auth',
      fetch: createOpenAIAuthFetch(openAIAuth),
    })
  }
  if (opts.google) providers.google = createGoogle({ fetch: permanentErrorFetch })
  if (opts.xai) providers.xai = createXai({ fetch: permanentErrorFetch })
  if (opts.deepseek) providers.deepseek = createDeepSeek({ fetch: permanentErrorFetch })
  if (opts.alibaba) {
    providers.alibaba = createAlibaba({
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      fetch: permanentErrorFetch,
    })
  }
  if (opts.zhipu) {
    providers.zhipu = createOpenAICompatible({
      name: 'zhipu',
      apiKey: opts.zhipu,
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      fetch: zhipuReasoningFetch,
      includeUsage: true,
    })
  }
  if (opts.moonshotai) {
    // Base URL comes from the /model picker, persisted in config.baseUrls.
    // No env-var escape hatch — the picker is the single source of truth,
    // visible to the user and easy to change (just re-run /model).
    const baseURL = config.baseUrls?.moonshotai

    // Coding Plan (kimi.com/code/console) uses api.kimi.com/coding/v1, which is
    // a plain OpenAI-compatible endpoint. The @ai-sdk/moonshotai provider
    // injects per-request transforms (e.g. thinking config wrapping) that are
    // incompatible with the Coding Plan's direct API — keys minted through the
    // Coding Plan console authenticate only here and 401 against the moonshot.*
    // endpoints. Route through createOpenAICompatible so the request goes
    // through unmodified.
    if (baseURL?.includes('api.kimi.com/coding')) {
      const codingProvider = createOpenAICompatible({
        name: 'moonshotai',
        apiKey: opts.moonshotai,
        baseURL,
        fetch: permanentErrorFetch,
        // createOpenAICompatible only sends `stream_options.include_usage`
        // when asked; without it the Coding Plan streams no usage chunk and
        // the footer context-size readout stays at 0. The @ai-sdk/moonshotai
        // route below hardcodes this already.
        includeUsage: true,
        convertUsage: moonshotConvertUsage,
      })
      providers.moonshotai = customProvider({
        languageModels: {
          'kimi-k3': codingProvider(kimiCodingModelId('kimi-k3')),
          'kimi-k2.7-code': codingProvider(kimiCodingModelId('kimi-k2.7-code')),
          'kimi-k2.7-code-highspeed': codingProvider(kimiCodingModelId('kimi-k2.7-code-highspeed')),
          'kimi-k2.6': codingProvider(kimiCodingModelId('kimi-k2.6')),
        },
        fallbackProvider: codingProvider,
      })
    } else {
      providers.moonshotai = createMoonshotAI({
        fetch: permanentErrorFetch,
        ...(baseURL ? { baseURL } : {}),
      })
    }
  }

  // Custom OpenAI compatible provider
  if (opts.custom.apiKey && opts.custom.baseURL) {
    providers.custom = createOpenAICompatible({
      name: 'custom',
      apiKey: opts.custom.apiKey,
      baseURL: opts.custom.baseURL,
      fetch: permanentErrorFetch,
      // Same includeUsage rationale as the Coding Plan route above.
      includeUsage: true,
    })
  }

  return createProviderRegistry(providers)
}

/**
 * Usage converter for the Coding Plan (OpenAI-compatible) route. Mirrors the
 * SDK's default conversion, but additionally reads Moonshot's proprietary
 * TOP-LEVEL `cached_tokens` — the default only looks at OpenAI's
 * `prompt_tokens_details.cached_tokens`, so cache-read tokens would
 * otherwise always report 0 (the usage schema is a looseObject, so the
 * top-level field survives validation and is readable here).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moonshotConvertUsage = (usage: any) => {
  if (usage == null) {
    return {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      raw: undefined,
    }
  }
  const promptTokens = usage.prompt_tokens ?? 0
  const completionTokens = usage.completion_tokens ?? 0
  const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0
  return {
    inputTokens: {
      total: promptTokens,
      noCache: promptTokens - cacheReadTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: completionTokens,
      text: completionTokens - reasoningTokens,
      reasoning: reasoningTokens,
    },
    raw: usage,
  }
}

/**
 * Side-channel for Zhipu reasoning effort. Zhipu goes through
 * @ai-sdk/openai-compatible which doesn't auto-translate the top-level
 * `reasoning` parameter. We inject `reasoning_effort` via the fetch shim.
 */
let _zhipuReasoningEffort: string | undefined
const ZHIPU_REASONING_HEADER = 'x-x-code-zhipu-reasoning-effort'

export function setZhipuReasoningEffort(effort: string | undefined): void {
  _zhipuReasoningEffort = effort
}

export function withZhipuReasoningHeader(
  headers: Record<string, string | undefined> | undefined,
  effort: string | undefined,
): Record<string, string | undefined> {
  return { ...headers, [ZHIPU_REASONING_HEADER]: effort ?? '' }
}

/**
 * Inject `reasoning_effort` into Zhipu requests. Zhipu goes through
 * @ai-sdk/openai-compatible which doesn't auto-translate the SDK's
 * top-level `reasoning` parameter. We intercept the HTTP body and add it.
 */
const zhipuReasoningFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers)
  const hasRequestEffort = headers.has(ZHIPU_REASONING_HEADER)
  const requestEffort = headers.get(ZHIPU_REASONING_HEADER) ?? undefined
  headers.delete(ZHIPU_REASONING_HEADER)
  const sanitizedInit = init ? { ...init, headers } : init
  if (!init?.body || typeof init.body !== 'string') return permanentErrorFetch(input, sanitizedInit)

  const effort = hasRequestEffort ? requestEffort || undefined : _zhipuReasoningEffort
  if (effort) {
    try {
      const body = JSON.parse(init.body) as { model?: string; reasoning_effort?: string }
      if (typeof body.model === 'string' && !body.reasoning_effort) {
        body.reasoning_effort = effort
        return permanentErrorFetch(input, { ...sanitizedInit, body: JSON.stringify(body) })
      }
    } catch {
      // pass through
    }
  }

  return permanentErrorFetch(input, sanitizedInit)
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
