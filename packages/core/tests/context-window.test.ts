import { describe, expect, it } from 'vitest'

import {
  COMPRESSION_TRIGGER_RATIO,
  estimateTokenCount,
  getCompressionThreshold,
  getContextWindow,
  getMaxOutputTokens,
} from '../src/agent/context-window.js'

describe('getContextWindow', () => {
  it('returns exact value for known models', () => {
    expect(getContextWindow('anthropic:claude-opus-4-7')).toBe(1000000)
    expect(getContextWindow('openai:gpt-4.1')).toBe(1047576)
    expect(getContextWindow('google:gemini-2.5-flash')).toBe(1000000)
    expect(getContextWindow('deepseek:deepseek-v4-flash')).toBe(1000000)
    expect(getContextWindow('alibaba:qwen-max')).toBe(32768)
  })

  it('falls back to provider-level default for unknown models', () => {
    expect(getContextWindow('anthropic:claude-unknown')).toBe(1000000)
    expect(getContextWindow('openai:gpt-99')).toBe(128000)
    expect(getContextWindow('google:gemini-99')).toBe(1000000)
  })

  it('returns global default for completely unknown providers', () => {
    expect(getContextWindow('unknownprovider:somemodel')).toBe(128000)
  })
})

describe('getCompressionThreshold', () => {
  it('is context window * COMPRESSION_TRIGGER_RATIO', () => {
    const window = getContextWindow('anthropic:claude-opus-4-7')
    expect(getCompressionThreshold('anthropic:claude-opus-4-7')).toBe(Math.floor(window * COMPRESSION_TRIGGER_RATIO))
  })

  it('changes with model', () => {
    const a = getCompressionThreshold('anthropic:claude-opus-4-7')
    const b = getCompressionThreshold('alibaba:qwen-max')
    expect(a).toBeGreaterThan(b)
  })
})

describe('getMaxOutputTokens', () => {
  it('returns specific ceiling for known models', () => {
    expect(getMaxOutputTokens('deepseek:deepseek-v4-flash')).toBe(131072)
    expect(getMaxOutputTokens('alibaba:qwen-turbo')).toBe(16384)
    expect(getMaxOutputTokens('alibaba:qwen-max')).toBe(8192)
  })

  it('returns default for unknown models', () => {
    expect(getMaxOutputTokens('openai:gpt-4.1')).toBe(16384)
    expect(getMaxOutputTokens('unknownprovider:model')).toBe(16384)
  })
})

describe('estimateTokenCount', () => {
  it('estimates tokens from string content', () => {
    const messages = [{ role: 'user' as const, content: 'hello world' }]
    const tokens = estimateTokenCount(messages)
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBe(Math.ceil(11 / 3.0))
  })

  it('estimates tokens from array content with text parts', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: ' world' },
        ],
      },
    ]
    const tokens = estimateTokenCount(messages)
    expect(tokens).toBe(Math.ceil(11 / 3.0))
  })

  it('ignores non-text parts in array content', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', image: 'data:...' },
        ],
      },
    ]
    const tokens = estimateTokenCount(messages)
    expect(tokens).toBe(Math.ceil(5 / 3.0))
  })
})
