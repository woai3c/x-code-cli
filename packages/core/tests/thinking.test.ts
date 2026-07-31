import { getReasoningLevel, getThinkingProviderOptions, supportsReasoningTier } from '../src/providers/thinking.js'

describe('supportsReasoningTier', () => {
  it('is true for tier-capable models', () => {
    expect(supportsReasoningTier('moonshotai:kimi-k3')).toBe(true)
    expect(supportsReasoningTier('google:gemini-3.5-flash')).toBe(true)
    expect(supportsReasoningTier('openai:gpt-5.6-sol')).toBe(true)
    expect(supportsReasoningTier('anthropic:claude-sonnet-5')).toBe(true)
    expect(supportsReasoningTier('xai:grok-4.5')).toBe(true)
  })

  it('is false for models whose provider has tiers but the model family does not', () => {
    expect(supportsReasoningTier('google:gemini-2.5-pro')).toBe(false)
    expect(supportsReasoningTier('google:gemini-2.5-flash')).toBe(false)
    expect(supportsReasoningTier('moonshotai:kimi-k2.6')).toBe(false)
    expect(supportsReasoningTier('moonshotai:kimi-k2.7-code')).toBe(false)
  })

  it('is true for DeepSeek V4 models', () => {
    expect(supportsReasoningTier('deepseek:deepseek-v4-flash')).toBe(true)
    expect(supportsReasoningTier('deepseek:deepseek-v4-pro')).toBe(true)
  })

  it('is true for Zhipu GLM-5.2', () => {
    expect(supportsReasoningTier('zhipu:glm-5.2')).toBe(true)
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

describe('getReasoningLevel', () => {
  it('returns the effort tier for tier-capable models', () => {
    expect(getReasoningLevel('deepseek:deepseek-v4-flash', false, 'high')).toBe('high')
    expect(getReasoningLevel('openai:gpt-5.6-sol', false, 'medium')).toBe('medium')
    expect(getReasoningLevel('anthropic:claude-sonnet-5', true, 'low')).toBe('low')
  })

  it('maps "max" tier to "xhigh" reasoning level', () => {
    expect(getReasoningLevel('deepseek:deepseek-v4-flash', false, 'max')).toBe('xhigh')
    expect(getReasoningLevel('moonshotai:kimi-k3', false, 'max')).toBe('xhigh')
  })

  it('returns high when enabled and no effort specified', () => {
    expect(getReasoningLevel('deepseek:deepseek-v4-flash', true)).toBe('high')
    expect(getReasoningLevel('openai:gpt-5.6-sol', true)).toBe('high')
  })

  it('returns none when disabled and no effort specified', () => {
    expect(getReasoningLevel('deepseek:deepseek-v4-flash', false)).toBe('none')
    expect(getReasoningLevel('openai:gpt-5.6-sol', false)).toBe('none')
  })

  it('returns undefined for alibaba/zhipu/custom providers', () => {
    expect(getReasoningLevel('alibaba:qwen3.7-max', true)).toBeUndefined()
    expect(getReasoningLevel('zhipu:glm-5.2', true, 'high')).toBeUndefined()
    expect(getReasoningLevel('custom:my-model', true)).toBeUndefined()
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
      zhipu: { thinking: { type: 'enabled' } },
    })
  })

  it('returns empty object for providers using top-level reasoning', () => {
    expect(getThinkingProviderOptions('deepseek:deepseek-v4-flash', true)).toEqual({})
    expect(getThinkingProviderOptions('openai:gpt-5.6-sol', true, 'high')).toEqual({})
    expect(getThinkingProviderOptions('anthropic:claude-sonnet-5', true)).toEqual({})
    expect(getThinkingProviderOptions('google:gemini-3.5-flash', true, 'low')).toEqual({})
  })
})
