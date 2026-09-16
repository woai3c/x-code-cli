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

describe('supportsReasoningTier', () => {
  it('is true for tier-capable models', () => {
    expect(supportsReasoningTier('moonshotai:kimi-k3')).toBe(true)
    expect(supportsReasoningTier('google:gemini-3.8-flash')).toBe(true)
    expect(supportsReasoningTier('google:gemini-3.7-flash')).toBe(true)
    expect(supportsReasoningTier('google:gemini-3.6-flash')).toBe(true)
    expect(supportsReasoningTier('google:gemini-3.5-flash')).toBe(true)
    expect(supportsReasoningTier('openai:gpt-5.6')).toBe(true)
    expect(supportsReasoningTier('openai:gpt-5.6-sol')).toBe(true)
    expect(supportsReasoningTier('openai:gpt-5.5')).toBe(true)
    expect(supportsReasoningTier('anthropic:claude-sonnet-5')).toBe(true)
    expect(supportsReasoningTier('xai:grok-4.5')).toBe(true)
    expect(supportsReasoningTier('xai:grok-4.6')).toBe(true)
    expect(supportsReasoningTier('anthropic:claude-fable-5-1')).toBe(true)
    expect(supportsReasoningTier('openai:gpt-6-astra')).toBe(true)
  })

  it('is false for models whose provider has tiers but the model family does not', () => {
    expect(supportsReasoningTier('google:gemini-2.5-pro')).toBe(false)
    expect(supportsReasoningTier('google:gemini-2.5-flash')).toBe(false)
    expect(supportsReasoningTier('moonshotai:kimi-k2.6')).toBe(false)
    expect(supportsReasoningTier('moonshotai:kimi-k2.7-code')).toBe(false)
    expect(supportsReasoningTier('xai:grok-4.20')).toBe(false)
    expect(supportsReasoningTier('xai:grok-4.20-non-reasoning')).toBe(false)
  })

  it('is true for current DeepSeek Flash and V4 models', () => {
    expect(supportsReasoningTier('deepseek:deepseek-flash')).toBe(true)
    expect(supportsReasoningTier('deepseek:deepseek-v4-pro')).toBe(true)
  })

  it('is true for Zhipu GLM-5.2', () => {
    expect(supportsReasoningTier('zhipu:glm-5.2')).toBe(true)
    expect(supportsReasoningTier('zhipu:glm-5.3')).toBe(true)
    expect(supportsReasoningTier('zhipu:glm-5.3-flash')).toBe(true)
  })

  it('is false for providers without any tier support', () => {
    expect(supportsReasoningTier('alibaba:qwen3.7-max')).toBe(false)
  })

  it('is false for older models in providers that have tiers', () => {
    expect(supportsReasoningTier('deepseek:deepseek-chat')).toBe(false)
    expect(supportsReasoningTier('deepseek:deepseek-reasoner')).toBe(false)
    expect(supportsReasoningTier('zhipu:glm-5')).toBe(false)
    expect(supportsReasoningTier('zhipu:glm-4.7')).toBe(false)
  })
})

describe('model-specific reasoning profiles', () => {
  it('returns only tiers supported by the selected model family', () => {
    expect(getReasoningTierOptions('google:gemini-3.8-flash')?.map((tier) => tier.value)).toEqual([
      'low',
      'medium',
      'high',
    ])
    expect(getReasoningTierOptions('google:gemini-3.6-flash')?.map((tier) => tier.value)).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ])
    expect(getReasoningTierOptions('google:gemini-3.5-flash')?.map((tier) => tier.value)).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ])
    expect(getReasoningTierOptions('openai:gpt-5.4-mini')?.map((tier) => tier.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    expect(getReasoningTierOptions('openai:gpt-5.6')?.map((tier) => tier.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(getReasoningTierOptions('openai:gpt-5.5')?.map((tier) => tier.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
  })

  it('floors disabled reasoning for models that reject off', () => {
    for (const id of [
      'anthropic:claude-fable-5-1',
      'openai:gpt-6-astra',
      'google:gemini-3.8-flash',
      'google:gemini-3.7-flash',
      'xai:grok-4.6',
      'xai:grok-4.5',
      'zhipu:glm-5.3',
    ]) {
      expect(getReasoningEffort(id, false), id).toBe('low')
    }
    expect(getReasoningLevel('google:gemini-3.8-flash', false)).toBe('low')
    expect(getReasoningEffort('google:gemini-3.6-flash', false)).toBe('minimal')
    expect(getReasoningLevel('openai:gpt-6-astra', false)).toBe('low')
  })
})

describe('getReasoningLevel', () => {
  it('returns the effort tier for tier-capable models', () => {
    expect(getReasoningLevel('deepseek:deepseek-flash', false, 'high')).toBeUndefined()
    expect(getReasoningLevel('openai:gpt-5.6', false, 'low')).toBe('low')
    expect(getReasoningLevel('openai:gpt-5.6-sol', false, 'medium')).toBe('medium')
    expect(getReasoningLevel('openai:gpt-5.5', false, 'xhigh')).toBe('xhigh')
    expect(getReasoningLevel('anthropic:claude-sonnet-5', true, 'low')).toBe('low')
  })

  it('maps portable "max" tiers to "xhigh" while leaving DeepSeek on its native option', () => {
    expect(getReasoningLevel('deepseek:deepseek-flash', false, 'max')).toBeUndefined()
    expect(getReasoningLevel('moonshotai:kimi-k3', false, 'max')).toBe('xhigh')
  })

  it('returns high when enabled and no effort specified', () => {
    expect(getReasoningLevel('deepseek:deepseek-flash', true)).toBe('high')
    expect(getReasoningLevel('openai:gpt-5.6-sol', true)).toBe('high')
  })

  it('returns none when disabled and no effort specified', () => {
    expect(getReasoningLevel('deepseek:deepseek-flash', false)).toBe('none')
    expect(getReasoningLevel('openai:gpt-5.6-sol', false)).toBe('none')
  })

  it('returns undefined for alibaba/zhipu/custom providers', () => {
    expect(getReasoningLevel('alibaba:qwen3.7-max', true)).toBeUndefined()
    expect(getReasoningLevel('zhipu:glm-5.2', true, 'high')).toBeUndefined()
    expect(getReasoningLevel('custom:my-model', true)).toBeUndefined()
  })

  it('omits reasoning control for fixed-reasoning Grok 4.20 variants', () => {
    expect(getReasoningLevel('xai:grok-4.20', false)).toBeUndefined()
    expect(getReasoningLevel('xai:grok-4.20', true, 'low')).toBeUndefined()
    expect(getReasoningLevel('xai:grok-4.20-non-reasoning', true, 'high')).toBeUndefined()
  })

  it('ignores effort for models that do not support tiers', () => {
    expect(getReasoningLevel('deepseek:deepseek-chat', false, 'high')).toBe('none')
    expect(getReasoningLevel('deepseek:deepseek-chat', true, 'high')).toBe('high')
  })
})

describe('getThinkingProviderOptions', () => {
  it('returns alibaba enableThinking', () => {
    expect(getThinkingProviderOptions('alibaba:qwen3.7-max', true)).toEqual({
      alibaba: { enableThinking: true },
    })
    expect(getThinkingProviderOptions('alibaba:qwen3.7-max', false)).toEqual({
      alibaba: { enableThinking: false },
    })
  })

  it('returns zhipu thinking toggle', () => {
    expect(getThinkingProviderOptions('zhipu:glm-5.2', true)).toEqual({
      zhipu: { thinking: { type: 'enabled' } },
    })
    expect(getThinkingProviderOptions('zhipu:glm-5.2', false)).toEqual({
      zhipu: { thinking: { type: 'disabled' } },
    })
  })

  it('returns zhipu thinking enabled when tier is set', () => {
    expect(getThinkingProviderOptions('zhipu:glm-5.2', false, 'high')).toEqual({
      zhipu: { thinking: { type: 'enabled' }, reasoningEffort: 'high' },
    })
  })

  it('keeps always-thinking Zhipu models enabled at low effort when switched off', () => {
    expect(getThinkingProviderOptions('zhipu:glm-5.3-flash', false)).toEqual({
      zhipu: { thinking: { type: 'enabled' }, reasoningEffort: 'low' },
    })
  })

  it.each(['low', 'high', 'max'])('uses the provider-native DeepSeek %s tier', (effort) => {
    expect(getThinkingProviderOptions('deepseek:deepseek-flash', true, effort)).toEqual({
      deepseek: { reasoningEffort: effort },
    })
  })

  it('uses provider-native max where the portable reasoning enum stops at xhigh', () => {
    expect(getThinkingProviderOptions('anthropic:claude-opus-5', true, 'max')).toEqual({
      anthropic: { thinking: { type: 'adaptive' }, effort: 'max' },
    })
    expect(getThinkingProviderOptions('openai:gpt-6-astra', true, 'max')).toEqual({
      openai: { reasoningEffort: 'max' },
    })
    expect(getThinkingProviderOptions('openai:gpt-5.4-mini', true, 'max')).toEqual({})
  })

  it('returns empty object for providers using top-level reasoning', () => {
    expect(getThinkingProviderOptions('deepseek:deepseek-flash', true)).toEqual({})
    expect(getThinkingProviderOptions('openai:gpt-5.6-sol', true, 'high')).toEqual({})
    expect(getThinkingProviderOptions('anthropic:claude-sonnet-5', true)).toEqual({})
    expect(getThinkingProviderOptions('google:gemini-3.5-flash', true, 'low')).toEqual({})
  })

  it('sends DeepSeek max natively without an xhigh compatibility warning', async () => {
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
