import { describe, expect, it } from 'vitest'

import {
  estimateTokenCount,
  getCompressionThreshold,
  getContextWindow,
  getContextWindowOverride,
  getMaxOutputTokens,
  setContextWindowOverride,
} from '../src/agent/context/context-window.js'
import { PROVIDERS } from '../src/providers/catalog.js'
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

describe('context window and output ceiling resolution', () => {
  it('resolves valid context windows and bounded output ceilings for every catalog model', () => {
    for (const provider of PROVIDERS) {
      for (const model of provider.models) {
        const window = getContextWindow(model.id)
        const maxOutput = getMaxOutputTokens(model.id)
        expect(window, `${model.id} context window`).toBeGreaterThanOrEqual(128_000)
        expect(maxOutput, `${model.id} max output`).toBeGreaterThan(0)
        expect(maxOutput, `${model.id} output <= window`).toBeLessThanOrEqual(window)
      }
    }
  })

  it('falls back to provider default for unlisted models and global default for unknown providers', () => {
    expect(getContextWindow('anthropic:claude-unknown')).toBe(1_000_000)
    expect(getContextWindow('openai:gpt-99')).toBe(128_000)
    expect(getContextWindow('unknownprovider:somemodel')).toBe(128_000)
    expect(getMaxOutputTokens('openai:gpt-99')).toBe(16_384)
    expect(getMaxOutputTokens('unknownprovider:somemodel')).toBe(16_384)
  })

  it('applies a valid user override across all providers and scales compression threshold accordingly', () => {
    expect(setContextWindowOverride(40_000)).toBe(40_000)
    expect(getContextWindowOverride()).toBe(40_000)
    expect(getContextWindow('anthropic:claude-opus-5-5')).toBe(40_000)
    expect(getContextWindow('unknownprovider:somemodel')).toBe(40_000)
    expect(getCompressionThreshold('anthropic:claude-opus-5-5')).toBe(32_000)
  })

  it('rejects undersized or malformed overrides', () => {
    setContextWindowOverride(64_000)
    expect(setContextWindowOverride(32_767)).toBeUndefined()
    expect(setContextWindowOverride('invalid')).toBeUndefined()
    expect(getContextWindowOverride()).toBeUndefined()
  })
})

describe('estimateTokenCount', () => {
  it('estimates tokens from string and text-part arrays while ignoring binary image parts', () => {
    expect(estimateTokenCount([{ role: 'user', content: 'hello world' }])).toBe(4)
    expect(
      estimateTokenCount([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'image', image: 'data:...' },
          ],
        },
      ]),
    ).toBe(2)
  })

  it('counts CJK text by UTF-8 byte length rather than UTF-16 code units', () => {
    expect(estimateTokenCount([{ role: 'user', content: '天气不错' }])).toBe(4)
  })

  it('counts tool-call inputs and visible tool-result text while ignoring binary media payloads', () => {
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
    expect(estimateTokenCount(messages as any)).toBe(Math.ceil(Buffer.byteLength(countedText, 'utf8') / 3.0))
  })
})
