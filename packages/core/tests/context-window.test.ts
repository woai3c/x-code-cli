import { describe, expect, it } from 'vitest'

import {
  COMPRESSION_TRIGGER_RATIO,
  estimateTokenCount,
  getCompressionThreshold,
  getContextWindow,
  getMaxOutputTokens,
} from '../src/agent/context-window.js'
import { isolateOpenAIAuth } from './provider-env.js'

let restoreOpenAIAuth: () => void

beforeEach(() => {
  restoreOpenAIAuth = isolateOpenAIAuth()
})

afterEach(() => restoreOpenAIAuth())

describe('getContextWindow', () => {
  it('returns exact value for known models', () => {
    expect(getContextWindow('anthropic:claude-opus-4-8')).toBe(1000000)
    expect(getContextWindow('openai:gpt-5.6-sol')).toBe(1047576)
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
    const window = getContextWindow('anthropic:claude-opus-4-8')
    expect(getCompressionThreshold('anthropic:claude-opus-4-8')).toBe(Math.floor(window * COMPRESSION_TRIGGER_RATIO))
  })
})

describe('getMaxOutputTokens', () => {
  it('returns specific ceiling for known models', () => {
    expect(getMaxOutputTokens('deepseek:deepseek-v4-flash')).toBe(131072)
    expect(getMaxOutputTokens('alibaba:qwen3.7-plus')).toBe(32000)
    expect(getMaxOutputTokens('alibaba:qwen-max')).toBe(8192)
  })

  it('returns default for models without an explicit cap', () => {
    // Current Zhipu vision models (glm-4.6v, glm-5v-turbo) don't have
    // explicit max-output-token caps — they fall through to the default.
    expect(getMaxOutputTokens('zhipu:glm-4.6v')).toBe(16384)
    expect(getMaxOutputTokens('zhipu:glm-5v-turbo')).toBe(16384)
  })

  it('returns default for unknown models', () => {
    expect(getMaxOutputTokens('openai:gpt-5.6-sol')).toBe(16384)
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
