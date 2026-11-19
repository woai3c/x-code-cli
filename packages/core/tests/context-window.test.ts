import { describe, expect, it } from 'vitest'

import {
  COMPRESSION_TRIGGER_RATIO,
  estimateTokenCount,
  getCompressionThreshold,
  getContextWindow,
  getContextWindowOverride,
  getMaxOutputTokens,
  setContextWindowOverride,
} from '../src/agent/context-window.js'
import { isolateOpenAIAuth } from './provider-env.js'

let restoreOpenAIAuth: () => void

beforeEach(() => {
  restoreOpenAIAuth = isolateOpenAIAuth()
  setContextWindowOverride(undefined)
})

afterEach(() => {
  setContextWindowOverride(undefined)
  restoreOpenAIAuth()
})

describe('getContextWindow', () => {
  it('returns exact value for known models', () => {
    expect(getContextWindow('anthropic:claude-fable-5-2')).toBe(1000000)
    expect(getContextWindow('anthropic:claude-haiku-5-5')).toBe(1000000)
    expect(getContextWindow('openai:gpt-6.2-astra')).toBe(1050000)
    expect(getContextWindow('openai:gpt-6.2-sol')).toBe(1050000)
    expect(getContextWindow('openai:gpt-6.1-terra')).toBe(1050000)
    expect(getContextWindow('google:gemini-4-carbon')).toBe(1048576)
    expect(getContextWindow('google:gemini-4-argon')).toBe(1048576)
    expect(getContextWindow('google:gemini-4-hydrogen')).toBe(1048576)
    expect(getContextWindow('google:gemini-3.8-flash')).toBe(1048576)
    expect(getContextWindow('deepseek:deepseek-flash')).toBe(1000000)
    expect(getContextWindow('alibaba:qwen4-max')).toBe(1000000)
    expect(getContextWindow('alibaba:qwen3.8-max')).toBe(1000000)
    expect(getContextWindow('xai:grok-4.7')).toBe(500000)
    expect(getContextWindow('xai:grok-4.6')).toBe(500000)
    expect(getContextWindow('zhipu:glm-5.3-flash')).toBe(1000000)
    expect(getContextWindow('zhipu:glm-4.7-flash')).toBe(200000)
    expect(getContextWindow('moonshotai:kimi-k3.1-pro')).toBe(1000000)
    expect(getContextWindow('moonshotai:kimi-k3')).toBe(1000000)
  })

  it('falls back to provider-level default for unknown models', () => {
    expect(getContextWindow('anthropic:claude-unknown')).toBe(1000000)
    expect(getContextWindow('openai:gpt-99')).toBe(128000)
    expect(getContextWindow('google:gemini-99')).toBe(1000000)
  })

  it('returns global default for completely unknown providers', () => {
    expect(getContextWindow('unknownprovider:somemodel')).toBe(128000)
  })

  it('forces the user override for every model and provider', () => {
    expect(setContextWindowOverride(64000)).toBe(64000)
    expect(getContextWindowOverride()).toBe(64000)
    expect(getContextWindow('anthropic:claude-opus-5-5')).toBe(64000)
    expect(getContextWindow('openai:gpt-6.2-sol')).toBe(64000)
    expect(getContextWindow('unknownprovider:somemodel')).toBe(64000)
  })

  it('clears or ignores an invalid override', () => {
    setContextWindowOverride(64000)
    expect(setContextWindowOverride(32767)).toBeUndefined()
    expect(setContextWindowOverride('invalid')).toBeUndefined()
    expect(getContextWindow('alibaba:qwen3.8-max')).toBe(1000000)
  })
})

describe('getCompressionThreshold', () => {
  it('is context window * COMPRESSION_TRIGGER_RATIO', () => {
    const window = getContextWindow('anthropic:claude-opus-5-5')
    expect(getCompressionThreshold('anthropic:claude-opus-5-5')).toBe(Math.floor(window * COMPRESSION_TRIGGER_RATIO))
  })

  it('uses the forced context window', () => {
    setContextWindowOverride(40000)
    expect(getCompressionThreshold('anthropic:claude-opus-5-5')).toBe(32000)
  })
})

describe('getMaxOutputTokens', () => {
  it('returns specific ceiling for known models', () => {
    expect(getMaxOutputTokens('deepseek:deepseek-flash')).toBe(131072)
    expect(getMaxOutputTokens('anthropic:claude-sonnet-5-5')).toBe(128000)
    expect(getMaxOutputTokens('anthropic:claude-haiku-5-5')).toBe(128000)
    expect(getMaxOutputTokens('openai:gpt-6.2-astra')).toBe(128000)
    expect(getMaxOutputTokens('openai:gpt-6.2-sol')).toBe(128000)
    expect(getMaxOutputTokens('openai:gpt-6.1-terra')).toBe(128000)
    expect(getMaxOutputTokens('google:gemini-4-carbon')).toBe(65536)
    expect(getMaxOutputTokens('google:gemini-4-argon')).toBe(65536)
    expect(getMaxOutputTokens('google:gemini-4-hydrogen')).toBe(65536)
    expect(getMaxOutputTokens('google:gemini-3.8-flash')).toBe(65536)
    expect(getMaxOutputTokens('alibaba:qwen4-max')).toBe(262144)
    expect(getMaxOutputTokens('alibaba:qwen3.8-flash')).toBe(65536)
    expect(getMaxOutputTokens('zhipu:glm-5.3')).toBe(131072)
    expect(getMaxOutputTokens('zhipu:glm-4.7-flash')).toBe(131072)
    expect(getMaxOutputTokens('xai:grok-4.7')).toBe(65536)
    expect(getMaxOutputTokens('moonshotai:kimi-k3.1-pro')).toBe(65536)
  })

  it('returns default for unknown models', () => {
    expect(getMaxOutputTokens('openai:gpt-99')).toBe(16384)
    expect(getMaxOutputTokens('unknownprovider:model')).toBe(16384)
  })
})

describe('estimateTokenCount', () => {
  it('estimates tokens from string content', () => {
    const messages = [{ role: 'user' as const, content: 'hello world' }]
    const tokens = estimateTokenCount(messages)
    expect(tokens).toBe(Math.ceil(11 / 3.0))
  })

  it('estimates tokens from array content with text parts', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'hello' },
          { type: 'text' as const, text: ' world' },
        ],
      },
    ]
    const tokens = estimateTokenCount(messages)
    expect(tokens).toBe(Math.ceil(11 / 3.0))
  })

  it('ignores non-text parts in array content', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'hello' },
          { type: 'image' as const, image: 'data:...' },
        ],
      },
    ]
    const tokens = estimateTokenCount(messages)
    expect(tokens).toBe(Math.ceil(5 / 3.0))
  })

  it('counts CJK text by UTF-8 bytes', () => {
    const messages = [{ role: 'user' as const, content: '天气不错' }]
    const tokens = estimateTokenCount(messages)
    expect(tokens).toBe(4)
  })

  it('counts structured tool-result text', () => {
    const messages = [
      {
        role: 'tool' as const,
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: 'call-1',
            toolName: 'readFile',
            output: { type: 'text' as const, value: 'x'.repeat(300) },
          },
        ],
      },
    ]
    const tokens = estimateTokenCount(messages)
    expect(tokens).toBe(100)
  })

  it('counts tool-call input and ignores binary tool-result media', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: 'call-1',
            toolName: 'readFile',
            input: { path: 'src/index.ts' },
          },
        ],
      },
      {
        role: 'tool' as const,
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: 'call-1',
            toolName: 'readFile',
            output: {
              type: 'content' as const,
              value: [
                { type: 'text' as const, text: 'visible text' },
                { type: 'image-data' as const, data: 'x'.repeat(10_000), mediaType: 'image/png' },
              ],
            },
          },
        ],
      },
    ]
    const countedText = JSON.stringify({ path: 'src/index.ts' }) + 'visible text'
    const tokens = estimateTokenCount(messages as any)
    expect(tokens).toBe(Math.ceil(Buffer.byteLength(countedText, 'utf8') / 3.0))
  })
})
