import { OPENAI_CHATGPT_OAUTH } from '../auth/openai-chatgpt/oauth.js'
import type { OpenAIChatGPTRequestAuth, OpenAIChatGPTTokenManager } from '../auth/openai-chatgpt/token-manager.js'
import { OPENAI_SESSION_ID_HEADER } from './cache-control.js'
import { getOpenAIChatGPTRuntimeModel, refreshOpenAIChatGPTModelsAfterNotFound } from './openai-chatgpt-models.js'

type FetchInput = Parameters<typeof fetch>[0]

export const OPENAI_CHATGPT_AUTH_RESPONSE_HEADER = 'x-x-code-openai-auth-mode'
export const OPENAI_CHATGPT_USAGE_LIMIT_HEADER = 'x-x-code-chatgpt-usage-limit'

export interface OpenAIChatGPTFetchOptions {
  tokenManager: OpenAIChatGPTTokenManager
  fetch?: typeof fetch
  userAgent?: string
}

type ResponsesInputItem = {
  role?: string
  content?: string | ResponsesContentPart[]
}

type ResponsesContentPart = {
  type?: string
  text?: string
  prompt_cache_breakpoint?: { mode?: string }
}

type ResponsesRequestBody = {
  model?: string
  input?: ResponsesInputItem[]
  instructions?: string
  max_output_tokens?: number
  prompt_cache_key?: string
  prompt_cache_options?: { mode?: string; ttl?: string }
  reasoning?: { effort?: string; summary?: string }
  store?: boolean
  include?: string[]
  tools?: Array<{ type?: string; strict?: boolean }>
  text?: { format?: { type?: string; strict?: boolean } }
}

function textFromDeveloperInput(item: ResponsesInputItem): string | undefined {
  if (item.role !== 'developer' && item.role !== 'system') return undefined
  if (typeof item.content === 'string') return item.content
  if (!Array.isArray(item.content)) return undefined
  const text = item.content
    .filter((part) => part.type === 'input_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
  return text || undefined
}

export function transformOpenAIChatGPTRequestBody(raw: string): { body: string; modelId?: string } {
  let body: ResponsesRequestBody
  try {
    body = JSON.parse(raw) as ResponsesRequestBody
  } catch {
    return { body: raw }
  }

  delete body.max_output_tokens
  // The Platform Responses endpoint supports GPT-5.6 explicit cache options,
  // but the ChatGPT subscription backend currently rejects both fields with
  // HTTP 400. Keep prompt_cache_key (which the backend accepts) and strip only
  // the unsupported controls at this transport boundary.
  delete body.prompt_cache_options
  body.store = false

  if (Array.isArray(body.input)) {
    body.input = body.input.map((item) => {
      if (!Array.isArray(item.content)) return item
      return {
        ...item,
        content: item.content.map(({ prompt_cache_breakpoint: _breakpoint, ...part }) => part),
      }
    })
    const instructions: string[] = []
    let prefixLength = 0
    for (const item of body.input) {
      const text = textFromDeveloperInput(item)
      if (!text) break
      instructions.push(text)
      prefixLength++
    }
    if (instructions.length > 0) {
      body.instructions = body.instructions ?? instructions.join('\n\n')
      body.input = body.input.slice(prefixLength)
    }
  }

  const include = new Set(body.include ?? [])
  include.add('reasoning.encrypted_content')
  body.include = [...include]

  const modelId = body.model ? (body.model.startsWith('openai:') ? body.model : `openai:${body.model}`) : undefined
  const runtimeModel = modelId ? getOpenAIChatGPTRuntimeModel(modelId) : undefined
  const supportsReasoningSummary = runtimeModel?.supportsReasoningSummaryParameter !== false
  if (body.reasoning?.effort === 'none') {
    const supportsNone = runtimeModel?.supportedReasoningLevels?.some((level) => level.effort === 'none') ?? false
    if (supportsNone && supportsReasoningSummary) body.reasoning.summary = 'auto'
    else if (supportsNone) delete body.reasoning.summary
    else delete body.reasoning
  } else if (body.reasoning) {
    if (supportsReasoningSummary) body.reasoning.summary = 'auto'
    else delete body.reasoning.summary
  }

  if (Array.isArray(body.tools)) {
    body.tools = body.tools.map((tool) => (tool.type === 'function' ? { ...tool, strict: false } : tool))
  }
  if (body.text?.format?.type === 'json_schema') body.text.format.strict = false

  return { body: JSON.stringify(body), modelId }
}

function originalRequestUrl(input: FetchInput): URL {
  if (input instanceof URL) return input
  return new URL(typeof input === 'string' ? input : input.url)
}

function requestHeaders(input: FetchInput, init?: RequestInit): { headers: Headers; sessionId?: string } {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  const sessionId = headers.get(OPENAI_SESSION_ID_HEADER) ?? undefined
  headers.delete(OPENAI_SESSION_ID_HEADER)
  headers.delete('authorization')
  headers.delete('openai-organization')
  headers.delete('openai-project')
  return { headers, sessionId }
}

function authenticatedHeaders(
  base: Headers,
  auth: OpenAIChatGPTRequestAuth,
  userAgent: string,
  sessionId?: string,
): Headers {
  const headers = new Headers(base)
  headers.set('Authorization', `Bearer ${auth.accessToken}`)
  if (auth.accountId) headers.set('ChatGPT-Account-ID', auth.accountId)
  if (auth.isFedRamp) headers.set('X-OpenAI-Fedramp', 'true')
  headers.set('originator', 'x-code-cli')
  headers.set('User-Agent', userAgent)
  if (sessionId) headers.set('session-id', sessionId)
  return headers
}

function markedResponse(
  response: Response,
  body: ConstructorParameters<typeof Response>[0] = response.body,
  status = response.status,
): Response {
  const headers = new Headers(response.headers)
  headers.set(OPENAI_CHATGPT_AUTH_RESPONSE_HEADER, 'chatgpt')
  return new Response(body, { status, statusText: response.statusText, headers })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function sseError(value: unknown): Record<string, unknown> | undefined {
  const event = asRecord(value)
  if (!event) return undefined
  if (event.type === 'response.failed') return asRecord(asRecord(event.response)?.error)
  return asRecord(event.error) ?? (event.type === 'error' ? event : undefined)
}

function sseErrorStatus(value: unknown): number | undefined {
  const error = sseError(value)
  if (!error) return undefined
  const discriminator = [error.code, error.type, error.message].filter(Boolean).join(' ').toLowerCase()
  if (/usage_limit_reached|workspace_(?:owner|member)_usage_limit_reached/.test(discriminator)) return 402
  const numericCode = typeof error.code === 'number' ? error.code : Number(error.code)
  if (Number.isInteger(numericCode) && numericCode >= 400 && numericCode <= 599) return numericCode
  if (/authentication|unauthorized|invalid[_ -]?token/.test(discriminator)) return 401
  if (/permission|forbidden/.test(discriminator)) return 403
  if (/not[_ -]?found/.test(discriminator)) return 404
  return undefined
}

function parseSseValue(frame: string): unknown {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data || data === '[DONE]') return undefined
  try {
    return JSON.parse(data) as unknown
  } catch {
    return undefined
  }
}

function rewriteSseFrame(frame: string): string {
  const lines = frame.split(/\r?\n/)
  const dataIndexes = lines.flatMap((line, index) => (line.startsWith('data:') ? [index] : []))
  if (dataIndexes.length !== 1) return frame
  const index = dataIndexes[0]!
  const value = parseSseValue(frame)
  const status = sseErrorStatus(value)
  const error = sseError(value)
  if (!status || !error) return frame
  error.code = String(status)
  lines[index] = `data: ${JSON.stringify(value)}`
  return lines.join(frame.includes('\r\n') ? '\r\n' : '\n')
}

function rewriteSseErrors(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        while (true) {
          const boundary = /\r?\n\r?\n/.exec(buffer)
          if (!boundary) break
          const delimiter = boundary[0]
          const frame = buffer.slice(0, boundary.index)
          buffer = buffer.slice(boundary.index + delimiter.length)
          controller.enqueue(encoder.encode(`${rewriteSseFrame(frame)}${delimiter}`))
        }
      },
      flush(controller) {
        buffer += decoder.decode()
        if (buffer) controller.enqueue(encoder.encode(rewriteSseFrame(buffer)))
      },
    }),
  )
}

function sseEventType(value: unknown): string | undefined {
  const type = asRecord(value)?.type
  return typeof type === 'string' ? type : undefined
}

async function prepareSseResponse(
  response: Response,
  detectEarlyUnauthorized: boolean,
): Promise<{ response: Response; earlyUnauthorized: boolean; sseStatus?: number }> {
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    return { response, earlyUnauthorized: false }
  }

  const [peekBody, consumerBody] = response.body.tee()
  const consumerResponse = markedResponse(response, rewriteSseErrors(consumerBody))
  const reader = peekBody.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let accepted = false
  let inspectedBytes = 0

  const finish = (earlyUnauthorized: boolean, sseStatus?: number) => {
    void reader
      .cancel()
      .catch(() => undefined)
      .finally(() => {
        try {
          reader.releaseLock()
        } catch {
          // A timed peek can still have a read settling; cancellation releases it asynchronously.
        }
      })
    if (earlyUnauthorized) void consumerResponse.body?.cancel().catch(() => undefined)
    if (sseStatus === 402) consumerResponse.headers.set(OPENAI_CHATGPT_USAGE_LIMIT_HEADER, 'true')
    return { response: consumerResponse, earlyUnauthorized, sseStatus }
  }

  try {
    while (inspectedBytes <= 64 * 1024) {
      const read = reader.read()
      let timer: ReturnType<typeof setTimeout> | undefined
      const result = accepted
        ? await Promise.race([
            read,
            new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), 50)
            }),
          ])
        : await read
      clearTimeout(timer)
      if (!result) {
        void read.catch(() => undefined)
        return finish(false)
      }
      if (result.done) {
        reader.releaseLock()
        return { response: consumerResponse, earlyUnauthorized: false }
      }
      inspectedBytes += result.value.byteLength
      buffer += decoder.decode(result.value, { stream: true })
      while (true) {
        const boundary = /\r?\n\r?\n/.exec(buffer)
        if (!boundary) break
        const frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const value = parseSseValue(frame)
        const status = sseErrorStatus(value)
        if (status) return finish(detectEarlyUnauthorized && status === 401, status)
        const type = sseEventType(value)
        if (type === 'response.in_progress') accepted = true
        if (type?.startsWith('response.output_') || type?.includes('.delta') || type === 'response.completed') {
          return finish(false)
        }
      }
    }
    return finish(false)
  } catch (err) {
    try {
      reader.releaseLock()
    } catch {
      // The stream owns lock release while a failed read settles.
    }
    void consumerResponse.body?.cancel().catch(() => undefined)
    throw err
  }
}

async function normalizeChatGPTResponse(response: Response): Promise<Response> {
  if (response.status !== 429) return markedResponse(response)
  const text = await response
    .clone()
    .text()
    .catch(() => '')
  const lower = text.toLowerCase()
  const limitType = response.headers.get('x-codex-rate-limit-reached-type')?.toLowerCase() ?? ''
  const usageLimited =
    lower.includes('usage_limit_reached') ||
    limitType.includes('usage_limit_reached') ||
    limitType === 'workspace_owner_usage_limit_reached' ||
    limitType === 'workspace_member_usage_limit_reached'
  if (!usageLimited) return markedResponse(response)

  const headers = new Headers(response.headers)
  headers.set(OPENAI_CHATGPT_AUTH_RESPONSE_HEADER, 'chatgpt')
  headers.set(OPENAI_CHATGPT_USAGE_LIMIT_HEADER, 'true')
  return new Response(text, { status: 402, statusText: 'ChatGPT Usage Limit Reached', headers })
}

export function createOpenAIChatGPTFetch(options: OpenAIChatGPTFetchOptions): typeof fetch {
  const fetchImpl = options.fetch ?? fetch
  const userAgent = options.userAgent ?? 'x-code-cli'

  return async (input, init) => {
    const originalUrl = originalRequestUrl(input)
    if (!originalUrl.pathname.endsWith('/responses')) {
      throw new Error(`ChatGPT authentication cannot call unexpected OpenAI endpoint: ${originalUrl.pathname}`)
    }

    let rawBody = init?.body
    if (rawBody === undefined && input instanceof Request) rawBody = await input.clone().text()
    const transformed =
      typeof rawBody === 'string' ? transformOpenAIChatGPTRequestBody(rawBody) : { body: rawBody, modelId: undefined }
    const requestContext = requestHeaders(input, init)
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)

    const send = async (auth: OpenAIChatGPTRequestAuth, detectEarlyUnauthorized: boolean) =>
      prepareSseResponse(
        await normalizeChatGPTResponse(
          await fetchImpl(OPENAI_CHATGPT_OAUTH.responsesEndpoint, {
            ...init,
            body: transformed.body,
            headers: authenticatedHeaders(requestContext.headers, auth, userAgent, requestContext.sessionId),
            signal,
          }),
        ),
        detectEarlyUnauthorized,
      )

    let auth = await options.tokenManager.getRequestAuth(signal ?? undefined)
    let prepared = await send(auth, true)
    let response = prepared.response
    if (response.status === 404 || prepared.sseStatus === 404) {
      await refreshOpenAIChatGPTModelsAfterNotFound(transformed.modelId, signal ?? undefined)
      return response
    }
    if (response.status !== 401 && !prepared.earlyUnauthorized) return response

    if (!prepared.earlyUnauthorized) await response.body?.cancel().catch(() => undefined)
    auth = await options.tokenManager.recoverAfterUnauthorized(auth.accessToken, signal ?? undefined)
    prepared = await send(auth, false)
    response = prepared.response
    if (response.status === 404 || prepared.sseStatus === 404) {
      await refreshOpenAIChatGPTModelsAfterNotFound(transformed.modelId, signal ?? undefined)
    }
    return response
  }
}
