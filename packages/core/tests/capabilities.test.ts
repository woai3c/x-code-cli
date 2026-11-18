// Tests for provider/model capability lookups — in particular the per-model
// vision flag that gates the browser agent's visual mode.
import { describe, expect, it } from 'vitest'

import {
  capabilitiesOf,
  isModelAcceptedImage,
  isModelAcceptedImageMime,
  modelSupportsVision,
} from '../src/providers/capabilities.js'

describe('modelSupportsVision', () => {
  it('returns the catalog vision flag for listed vision models', () => {
    expect(modelSupportsVision('anthropic:claude-haiku-5-5')).toBe(true)
    expect(modelSupportsVision('moonshotai:kimi-k3.1-pro')).toBe(true)
    expect(modelSupportsVision('moonshotai:kimi-k3.1-pro-highspeed')).toBe(true)
    expect(modelSupportsVision('deepseek:deepseek-flash')).toBe(true)
    expect(modelSupportsVision('alibaba:qwen3.8-max')).toBe(true)
    expect(modelSupportsVision('alibaba:qwen3.8-flash')).toBe(true)
    expect(modelSupportsVision('google:gemini-4-carbon')).toBe(true)
    expect(modelSupportsVision('google:gemini-4-hydrogen')).toBe(true)
    expect(modelSupportsVision('google:gemini-3.8-flash')).toBe(true)
    expect(modelSupportsVision('xai:grok-4.7')).toBe(true)
    expect(modelSupportsVision('zhipu:glm-5.3-flash')).toBe(true)
    expect(modelSupportsVision('openai:gpt-6.1-terra')).toBe(true)
    expect(modelSupportsVision('openai:gpt-6-luna')).toBe(true)
  })

  it('returns false for listed text-only models even on image-capable providers', () => {
    // zhipu accepts image parts at the API level, but GLM-5.3 is text-only —
    // the per-model flag must win.
    expect(modelSupportsVision('zhipu:glm-5.3')).toBe(false)
    expect(modelSupportsVision('deepseek:deepseek-v4-pro')).toBe(false)
  })

  it('expands aliases before lookup', () => {
    expect(modelSupportsVision('opus')).toBe(true) // → anthropic:claude-opus-5-5
    expect(modelSupportsVision('deepseek')).toBe(true) // → deepseek:deepseek-flash
  })

  it('falls back to provider-level capability for unlisted ids', () => {
    // Not in the catalog → defer to the provider's image capability.
    expect(modelSupportsVision('anthropic:claude-some-future-model')).toBe(true)
    expect(modelSupportsVision('deepseek:some-future-model')).toBe(true)
    expect(modelSupportsVision('unknownprovider:whatever')).toBe(false)
  })

  it('provider-level capabilitiesOf stays coarse (provider, not model)', () => {
    // capabilitiesOf is intentionally provider-level; both Zhipu models report
    // image:true there, and only modelSupportsVision distinguishes them.
    expect(capabilitiesOf('zhipu:glm-5.3').image).toBe(true)
    expect(capabilitiesOf('zhipu:glm-5.3-flash').image).toBe(true)
    expect(modelSupportsVision('zhipu:glm-5.3')).toBe(false)
    expect(modelSupportsVision('zhipu:glm-5.3-flash')).toBe(true)
  })
})

describe('provider image MIME policy', () => {
  it('applies provider MIME and animation policies', () => {
    expect(isModelAcceptedImageMime('image/png', 'xai:grok-4.7')).toBe(true)
    expect(isModelAcceptedImageMime('image/jpeg', 'xai:grok-4.7')).toBe(true)
    expect(isModelAcceptedImageMime('image/gif', 'xai:grok-4.7')).toBe(false)
    expect(isModelAcceptedImageMime('image/webp', 'xai:grok-4.7')).toBe(false)
    expect(isModelAcceptedImageMime('image/gif', 'moonshotai:kimi-k3.1-pro')).toBe(true)
    expect(isModelAcceptedImageMime('image/webp', 'moonshotai:kimi-k3.1-pro')).toBe(true)
    expect(isModelAcceptedImageMime('image/gif', 'alibaba:qwen3.8-flash')).toBe(false)
    expect(isModelAcceptedImageMime('image/webp', 'alibaba:qwen3.8-flash')).toBe(true)
    expect(isModelAcceptedImage('image/gif', { modelId: 'openai:gpt-6.2-sol' })).toBe(true)
    expect(isModelAcceptedImage('image/gif', { modelId: 'openai:gpt-6.2-sol', animated: true })).toBe(false)
  })
})

describe('toolImageTransport capability', () => {
  it('uses native tool-result media where the provider SDK preserves it', () => {
    for (const id of ['anthropic:claude-sonnet-5-5', 'openai:gpt-6.2-sol', 'google:gemini-4-carbon']) {
      expect(capabilitiesOf(id).toolImageTransport, id).toBe('tool-result')
    }
  })

  it('reattaches media in a following user message for Chat Completions providers', () => {
    for (const id of [
      'deepseek:deepseek-flash',
      'moonshotai:kimi-k3.1-pro',
      'alibaba:qwen3.8-flash',
      'zhipu:glm-5.3-flash',
      'xai:grok-4.7',
    ]) {
      expect(capabilitiesOf(id).toolImageTransport, id).toBe('user-message')
    }
  })

  it('marks text-only and unknown providers unsupported', () => {
    for (const id of ['custom:whatever', 'unknownprovider:whatever']) {
      expect(capabilitiesOf(id).toolImageTransport, id).toBe('unsupported')
    }
  })
})
