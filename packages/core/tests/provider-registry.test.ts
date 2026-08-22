import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { streamText, tool } from 'ai'

import { z } from 'zod'

import { classifyApiError } from '../src/agent/api-errors.js'
import { resetOpenAIAuthContextForTesting } from '../src/auth/openai-chatgpt/auth-resolver.js'
import { writeOpenAIChatGPTCredentials } from '../src/auth/openai-chatgpt/credential-store.js'
import { getProviderOptions, saveUserConfig } from '../src/config/index.js'
import { createModelRegistry, kimiCodingModelId } from '../src/providers/registry.js'

function sseResponse(events: unknown[]): Response {
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('Kimi endpoint model ids', () => {
  let testHome: string

  beforeEach(() => {
    testHome = path.join(os.tmpdir(), `x-code-provider-registry-${Math.random().toString(36).slice(2)}`)
    process.env.X_CODE_HOME = testHome
    process.env.MOONSHOT_API_KEY = 'test-key'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetOpenAIAuthContextForTesting()
    delete process.env.X_CODE_HOME
    delete process.env.MOONSHOT_API_KEY
    delete process.env.OPENAI_API_KEY
    fs.rmSync(testHome, { recursive: true, force: true })
  })

  it('maps platform model ids to the Coding Plan wire ids', () => {
    expect(kimiCodingModelId('kimi-k3')).toBe('k3')
    expect(kimiCodingModelId('kimi-k2.7-code')).toBe('kimi-for-coding')
    expect(kimiCodingModelId('kimi-k2.7-code-highspeed')).toBe('kimi-for-coding-highspeed')
    expect(kimiCodingModelId('kimi-k2.6')).toBe('kimi-for-coding')
    expect(kimiCodingModelId('future-model')).toBe('future-model')
  })

  it('uses Coding Plan wire ids only on the Coding Plan endpoint', () => {
    saveUserConfig({ baseUrls: { moonshotai: 'https://api.kimi.com/coding/v1' } })
    let registry = createModelRegistry()
    expect(registry.languageModel('moonshotai:kimi-k3').modelId).toBe('k3')
    expect(registry.languageModel('moonshotai:kimi-k2.7-code').modelId).toBe('kimi-for-coding')
    expect(registry.languageModel('moonshotai:kimi-k2.6').modelId).toBe('kimi-for-coding')

    saveUserConfig({ baseUrls: { moonshotai: 'https://api.moonshot.ai/v1' } })
    registry = createModelRegistry()
    expect(registry.languageModel('moonshotai:kimi-k3').modelId).toBe('kimi-k3')
    expect(registry.languageModel('moonshotai:kimi-k2.7-code').modelId).toBe('kimi-k2.7-code')
  })

  it('registers one OpenAI provider with ChatGPT auth and keeps OPENAI_API_KEY out of the request', async () => {
    process.env.OPENAI_API_KEY = 'platform-key-must-never-leak'
    await writeOpenAIChatGPTCredentials({
      version: 1,
      accessToken: 'oauth-access',
      refreshToken: 'oauth-refresh',
      expiresAt: Date.now() + 60 * 60 * 1000,
      accountId: 'account-1',
    })
    resetOpenAIAuthContextForTesting()
    expect(getProviderOptions().openai).toBeUndefined()

    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: { message: 'test stop' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const model = createModelRegistry().languageModel('openai:gpt-5.6-sol')
    const result = streamText({
      model,
      instructions: 'stable instructions',
      messages: [{ role: 'user', content: 'hello' }],
      providerOptions: { openai: { store: false, promptCacheKey: 'session-1' } },
      onError: () => undefined,
    })
    for await (const _chunk of result.textStream) {
      // The mock returns a deliberate error after the outbound request is captured.
    }

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer oauth-access')
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('platform-key-must-never-leak')
  })

  it('does not let the AI SDK retry a ChatGPT subscription usage limit', async () => {
    await writeOpenAIChatGPTCredentials({
      version: 1,
      accessToken: 'oauth-access',
      refreshToken: 'oauth-refresh',
      expiresAt: Date.now() + 60 * 60 * 1000,
      accountId: 'account-1',
    })
    resetOpenAIAuthContextForTesting()
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse([
        {
          type: 'response.failed',
          sequence_number: 0,
          response: {
            error: { message: 'Your subscription limit has been reached', code: 429, type: 'usage_limit_reached' },
          },
        },
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)
    const errors: unknown[] = []
    const result = streamText({
      model: createModelRegistry().languageModel('openai:gpt-5.6-sol'),
      messages: [{ role: 'user', content: 'hello' }],
      onError: ({ error }) => {
        errors.push(error)
      },
    })
    for await (const _chunk of result.textStream) {
      // A subscription quota error has no stream chunks.
    }

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(errors).toHaveLength(1)
    expect(classifyApiError(errors[0]).message).toContain('ChatGPT subscription usage limit reached')
  })

  it('round-trips encrypted ChatGPT reasoning across a tool-call boundary', async () => {
    process.env.OPENAI_API_KEY = 'platform-key-must-never-leak'
    await writeOpenAIChatGPTCredentials({
      version: 1,
      accessToken: 'oauth-access',
      refreshToken: 'oauth-refresh',
      expiresAt: Date.now() + 60 * 60 * 1000,
      accountId: 'account-1',
    })
    resetOpenAIAuthContextForTesting()
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sseResponse([
          {
            type: 'response.created',
            response: { id: 'response-1', created_at: 1, model: 'gpt-5.6-sol' },
          },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'encrypted-reasoning' },
          },
          { type: 'response.reasoning_summary_part.added', item_id: 'reasoning-1', summary_index: 0 },
          {
            type: 'response.reasoning_summary_text.delta',
            item_id: 'reasoning-1',
            summary_index: 0,
            delta: 'reasoned',
          },
          { type: 'response.reasoning_summary_part.done', item_id: 'reasoning-1', summary_index: 0 },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'encrypted-reasoning' },
          },
          {
            type: 'response.output_item.added',
            output_index: 1,
            item: {
              type: 'function_call',
              id: 'function-1',
              call_id: 'call-1',
              name: 'testTool',
              arguments: '',
            },
          },
          {
            type: 'response.function_call_arguments.delta',
            item_id: 'function-1',
            output_index: 1,
            delta: '{}',
          },
          {
            type: 'response.output_item.done',
            output_index: 1,
            item: {
              type: 'function_call',
              id: 'function-1',
              call_id: 'call-1',
              name: 'testTool',
              arguments: '{}',
              status: 'completed',
            },
          },
          {
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 2 },
              },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'test stop' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const model = createModelRegistry().languageModel('openai:gpt-5.6-sol')
    const tools = { testTool: tool({ inputSchema: z.object({}) }) }
    const first = streamText({
      model,
      messages: [{ role: 'user', content: 'use the tool' }],
      tools,
      reasoning: 'high',
      providerOptions: { openai: { store: false } },
      onError: () => undefined,
    })
    for await (const _chunk of first.fullStream) {
      // Consume the complete first response so the SDK materializes response.messages.
    }
    const firstMessages = (await first.response).messages
    const second = streamText({
      model,
      messages: [
        { role: 'user', content: 'use the tool' },
        ...firstMessages,
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'testTool',
              output: { type: 'text', value: 'done' },
            },
          ],
        },
      ],
      tools,
      reasoning: 'high',
      providerOptions: { openai: { store: false } },
      onError: () => undefined,
    })
    for await (const _chunk of second.fullStream) {
      // The second mock intentionally stops after the request has been captured.
    }

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { input?: unknown[] }
    expect(JSON.stringify(secondBody.input)).toContain('encrypted-reasoning')
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('platform-key-must-never-leak')
  })
})
