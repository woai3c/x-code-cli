import { describe, expect, it } from 'vitest'

import {
  capabilitiesOf,
  isModelAcceptedImage,
  isModelAcceptedImageMime,
  modelSupportsVision,
} from '../src/providers/capabilities.js'
import { PROVIDERS } from '../src/providers/catalog.js'

describe('modelSupportsVision', () => {
  it('matches the per-model vision flag for every model in PROVIDERS', () => {
    for (const provider of PROVIDERS) {
      for (const model of provider.models) {
        expect(modelSupportsVision(model.id), model.id).toBe(model.vision)
      }
    }
  })

  it('keeps provider-level capabilitiesOf coarse while modelSupportsVision enforces text-only overrides', () => {
    expect(capabilitiesOf('zhipu:glm-5.3').image).toBe(true)
    expect(modelSupportsVision('zhipu:glm-5.3')).toBe(false)
    expect(modelSupportsVision('zhipu:glm-5.3-flash')).toBe(true)
    expect(modelSupportsVision('deepseek:deepseek-v4-pro')).toBe(false)
  })

  it('expands aliases before lookup and falls back to provider capability for unlisted ids', () => {
    expect(modelSupportsVision('opus')).toBe(true)
    expect(modelSupportsVision('deepseek')).toBe(true)
    expect(modelSupportsVision('anthropic:claude-some-future-model')).toBe(true)
    expect(modelSupportsVision('unknownprovider:whatever')).toBe(false)
  })
})

describe('provider image MIME and transport policy', () => {
  it('applies provider MIME restrictions and rejects animated GIFs where unsupported', () => {
    expect(isModelAcceptedImageMime('image/png', 'xai:grok-4.7')).toBe(true)
    expect(isModelAcceptedImageMime('image/gif', 'xai:grok-4.7')).toBe(false)
    expect(isModelAcceptedImageMime('image/webp', 'xai:grok-4.7')).toBe(false)
    expect(isModelAcceptedImageMime('image/gif', 'moonshotai:kimi-k3.1-pro')).toBe(true)
    expect(isModelAcceptedImageMime('image/gif', 'alibaba:qwen3.8-flash')).toBe(false)
    expect(isModelAcceptedImageMime('image/webp', 'alibaba:qwen3.8-flash')).toBe(true)
    expect(isModelAcceptedImage('image/gif', { modelId: 'openai:gpt-6.2-sol' })).toBe(true)
    expect(isModelAcceptedImage('image/gif', { modelId: 'openai:gpt-6.2-sol', animated: true })).toBe(false)
  })

  it('selects native tool-result vs user-message image reattachment vs unsupported transport', () => {
    for (const id of ['anthropic:claude-sonnet-5-5', 'openai:gpt-6.2-sol', 'google:gemini-4-carbon']) {
      expect(capabilitiesOf(id).toolImageTransport, id).toBe('tool-result')
    }
    for (const id of [
      'deepseek:deepseek-flash',
      'moonshotai:kimi-k3.1-pro',
      'alibaba:qwen3.8-flash',
      'zhipu:glm-5.3-flash',
      'xai:grok-4.7',
    ]) {
      expect(capabilitiesOf(id).toolImageTransport, id).toBe('user-message')
    }
    expect(capabilitiesOf('custom:whatever').toolImageTransport).toBe('unsupported')
    expect(capabilitiesOf('unknownprovider:whatever').toolImageTransport).toBe('unsupported')
  })
})
