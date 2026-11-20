import { createDeepSeek } from '@ai-sdk/deepseek'
import { generateText } from 'ai'

import {
  getReasoningEffort,
  getReasoningLevel,
  getReasoningTierOptions,
  getThinkingProviderOptions,
  supportsReasoningTier,
} from '../src/providers/thinking.js'
import { isolateOpenAIAuth } from './provider-env.js'

let restoreOpenAIAuth: () => void

beforeEach(() => {
  restoreOpenAIAuth = isolateOpenAIAuth()
})

afterEach(() => restoreOpenAIAuth())

describe('reasoning tier eligibility and profiles', () => {
  it('gates granular reasoning tiers to matching model families rather than whole providers', () => {
    expect(supportsReasoningTier('openai:gpt-6.2-sol')).toBe(true)
    expect(supportsReasoningTier('google:gemini-4-carbon')).toBe(true)
    expect(supportsReasoningTier('deepseek:deepseek-flash')).toBe(true)
    expect(supportsReasoningTier('zhipu:glm-5.3')).toBe(true)

    expect(supportsReasoningTier('google:gemini-2.5-pro')).toBe(false)
    expect(supportsReasoningTier('deepseek:deepseek-chat')).toBe(false)
    expect(supportsReasoningTier('zhipu:glm-4.7')).toBe(false)
    expect(supportsReasoningTier('xai:grok-4.20')).toBe(false)
    expect(supportsReasoningTier('alibaba:qwen4-max')).toBe(false)

    expect(getReasoningTierOptions('google:gemini-4-carbon')?.map((t) => t.value)).toEqual(['low', 'medium', 'high'])
    expect(getReasoningTierOptions('openai:gpt-6.2-sol')?.map((t) => t.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })

  it('floors disabled reasoning to low for models that reject off, including uncatalogued Gemini 3.8/4 ids', () => {
    for (const id of [
      'anthropic:claude-fable-5-2',
      'openai:gpt-6.2-astra',
      'google:gemini-4-carbon',
      'google:gemini-4-future-model',
      'google:gemini-3.8-flash-001',
      'zhipu:glm-5.3',
    ]) {
      expect(getReasoningEffort(id, false) ?? getReasoningLevel(id, false), id).toBe('low')
    }
    expect(getReasoningLevel('google:gemini-3.5-flash', false)).toBe('none')
    expect(getReasoningLevel('google:gemini-2.5-pro', false)).toBe('none')
  })
})

describe('getReasoningLevel and getThinkingProviderOptions', () => {
  it('resolves portable tri-state reasoning (explicit tier, on -> high, off -> none, unset -> undefined)', () => {
    expect(getReasoningLevel('openai:gpt-6.2-sol', false, 'medium')).toBe('medium')
    expect(getReasoningLevel('openai:gpt-6.2-sol', true)).toBe('high')
    expect(getReasoningLevel('openai:gpt-6.2-sol', false)).toBe('none')
    expect(getReasoningLevel('openai:gpt-6.2-sol', undefined)).toBeUndefined()
    expect(getReasoningLevel('deepseek:deepseek-chat', false, 'high')).toBe('none')
    expect(getReasoningLevel('xai:grok-4.20', true, 'low')).toBeUndefined()
    expect(getReasoningLevel('alibaba:qwen4-max', true)).toBeUndefined()
  })

  it('routes provider-specific thinking options for Alibaba, Zhipu, DeepSeek, Anthropic, and OpenAI max', () => {
    expect(getThinkingProviderOptions('alibaba:qwen4-max', true)).toEqual({ alibaba: { enableThinking: true } })
    expect(getThinkingProviderOptions('alibaba:qwen4-max', false)).toEqual({ alibaba: { enableThinking: false } })
    expect(getThinkingProviderOptions('zhipu:glm-4.7', false)).toEqual({ zhipu: { thinking: { type: 'disabled' } } })
    expect(getThinkingProviderOptions('zhipu:glm-5.3-flash', false)).toEqual({
      zhipu: { thinking: { type: 'enabled' }, reasoningEffort: 'low' },
    })
    expect(getThinkingProviderOptions('zhipu:glm-5.3-flash', false, 'high')).toEqual({
      zhipu: { thinking: { type: 'enabled' }, reasoningEffort: 'high' },
    })

    expect(getReasoningLevel('moonshotai:kimi-k3.1-pro', false, 'max')).toBe('xhigh')
    expect(getReasoningLevel('deepseek:deepseek-flash', false, 'max')).toBeUndefined()
    expect(getThinkingProviderOptions('deepseek:deepseek-flash', true, 'max')).toEqual({
      deepseek: { reasoningEffort: 'max' },
    })
    expect(getThinkingProviderOptions('anthropic:claude-opus-5-5', true, 'max')).toEqual({
      anthropic: { thinking: { type: 'adaptive' }, effort: 'max' },
    })
    expect(getThinkingProviderOptions('openai:gpt-6.2-astra', true, 'max')).toEqual({
      openai: { reasoningEffort: 'max' },
    })
    expect(getThinkingProviderOptions('openai:gpt-99', true, 'max')).toEqual({})
  })

  it('sends DeepSeek max natively on the wire without an xhigh compatibility warning', async () => {
    let requestBody: { reasoning_effort?: string } = {}
    const provider = createDeepSeek({
      baseURL: 'https://example.test',
      apiKey: 'test-key',
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body))
        return new Response(
          JSON.stringify({
            id: 'response-1',
            object: 'chat.completion',
            created: 0,
            model: 'deepseek-flash',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    })
    const modelId = 'deepseek:deepseek-flash'
    const reasoning = getReasoningLevel(modelId, true, 'max')
    const providerOptions = getThinkingProviderOptions(modelId, true, 'max')

    const result = await generateText({
      model: provider('deepseek-flash'),
      messages: [{ role: 'user', content: 'hello' }],
      ...(reasoning ? { reasoning } : {}),
      providerOptions: providerOptions as Parameters<typeof generateText>[0]['providerOptions'],
    })

    expect(requestBody.reasoning_effort).toBe('max')
    expect(result.warnings ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ feature: 'reasoning' })]),
    )
  })
})
