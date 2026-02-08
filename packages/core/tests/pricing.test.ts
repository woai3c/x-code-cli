// Tests for pricing module

import { describe, it, expect } from 'vitest'

import { estimateCost } from '../src/agent/pricing.js'

describe('estimateCost', () => {
  it('calculates Anthropic Sonnet cost correctly', () => {
    // 10K input @ $3/M + 2K output @ $15/M = $0.03 + $0.03 = $0.06
    const cost = estimateCost('anthropic:claude-sonnet-4-5', 10_000, 2_000)
    expect(cost).toBeCloseTo(0.06, 4)
  })

  it('calculates Anthropic Opus cost correctly', () => {
    // 10K input @ $15/M + 2K output @ $75/M = $0.15 + $0.15 = $0.30
    const cost = estimateCost('anthropic:claude-opus-4-6', 10_000, 2_000)
    expect(cost).toBeCloseTo(0.30, 4)
  })

  it('calculates OpenAI GPT-4.1 cost correctly', () => {
    // 50K input @ $2/M + 10K output @ $8/M = $0.10 + $0.08 = $0.18
    const cost = estimateCost('openai:gpt-4.1', 50_000, 10_000)
    expect(cost).toBeCloseTo(0.18, 4)
  })

  it('calculates DeepSeek cost correctly', () => {
    // 100K input @ $0.27/M + 20K output @ $1.1/M = $0.027 + $0.022 = $0.049
    const cost = estimateCost('deepseek:deepseek-chat', 100_000, 20_000)
    expect(cost).toBeCloseTo(0.049, 4)
  })

  it('returns 0 for unknown models', () => {
    const cost = estimateCost('unknown:model', 10_000, 2_000)
    expect(cost).toBe(0)
  })

  it('returns 0 for zero tokens', () => {
    const cost = estimateCost('anthropic:claude-sonnet-4-5', 0, 0)
    expect(cost).toBe(0)
  })

  it('handles Google Gemini pricing', () => {
    // 20K input @ $1.25/M + 5K output @ $10/M = $0.025 + $0.05 = $0.075
    const cost = estimateCost('google:gemini-2.5-pro', 20_000, 5_000)
    expect(cost).toBeCloseTo(0.075, 4)
  })
})
