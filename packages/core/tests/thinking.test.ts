import { getThinkingProviderOptions, supportsReasoningTier } from '../src/providers/thinking.js'

describe('supportsReasoningTier', () => {
  it('is true for tier-capable models', () => {
    expect(supportsReasoningTier('moonshotai:kimi-k3')).toBe(true)
    expect(supportsReasoningTier('google:gemini-3.5-flash')).toBe(true)
    expect(supportsReasoningTier('openai:gpt-5.6-sol')).toBe(true)
    expect(supportsReasoningTier('anthropic:claude-sonnet-5')).toBe(true)
    expect(supportsReasoningTier('xai:grok-4.5')).toBe(true)
  })

  it('is false for models whose provider has tiers but the model family does not', () => {
    // thinkingLevel is Gemini 3-only; reasoningEffort is K3-only.
    expect(supportsReasoningTier('google:gemini-2.5-pro')).toBe(false)
    expect(supportsReasoningTier('google:gemini-2.5-flash')).toBe(false)
    expect(supportsReasoningTier('moonshotai:kimi-k2.6')).toBe(false)
    expect(supportsReasoningTier('moonshotai:kimi-k2.7-code')).toBe(false)
  })

  it('is false for providers without any tier support', () => {
    expect(supportsReasoningTier('deepseek:deepseek-v4-flash')).toBe(false)
    expect(supportsReasoningTier('alibaba:qwen3.7-max')).toBe(false)
    expect(supportsReasoningTier('zhipu:glm-5.2')).toBe(false)
  })
})

describe('getThinkingProviderOptions with an explicit effort tier', () => {
  it('maps the tier for models that honor it', () => {
    expect(getThinkingProviderOptions('moonshotai:kimi-k3', false, 'max')).toEqual({
      moonshotai: { reasoningEffort: 'max' },
    })
    expect(getThinkingProviderOptions('google:gemini-3.5-flash', false, 'low')).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'LOW' } },
    })
    expect(getThinkingProviderOptions('openai:gpt-5.6-sol', false, 'medium')).toEqual({
      openai: { reasoningEffort: 'medium' },
    })
    expect(getThinkingProviderOptions('anthropic:claude-sonnet-5', false, 'high')).toEqual({
      anthropic: { effort: 'high' },
    })
  })

  it('falls back to the binary toggle for models that do not honor the tier', () => {
    // A stale stored tier (picked before gating existed) must not disable
    // /thinking on K2.6 or Gemini 2.5.
    expect(getThinkingProviderOptions('moonshotai:kimi-k2.6', false, 'max')).toEqual({
      moonshotai: { thinking: { type: 'disabled' } },
    })
    expect(getThinkingProviderOptions('moonshotai:kimi-k2.6', true, 'max')).toEqual({
      moonshotai: { thinking: { type: 'enabled' } },
    })
    expect(getThinkingProviderOptions('google:gemini-2.5-pro', false, 'high')).toEqual({
      google: { thinkingConfig: { thinkingBudget: 0 } },
    })
    expect(getThinkingProviderOptions('google:gemini-2.5-pro', true, 'high')).toEqual({
      google: { thinkingConfig: { thinkingBudget: -1 } },
    })
  })
})
