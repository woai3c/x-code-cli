// Tests for provider/model capability lookups — in particular the per-model
// vision flag that gates the browser agent's visual mode.
import { describe, expect, it } from 'vitest'

import { capabilitiesOf, modelSupportsVision } from '../src/providers/capabilities.js'

describe('modelSupportsVision', () => {
  it('returns the catalog vision flag for listed vision models', () => {
    expect(modelSupportsVision('anthropic:claude-haiku-4-5')).toBe(true)
    expect(modelSupportsVision('moonshotai:kimi-k2.6')).toBe(true)
    expect(modelSupportsVision('alibaba:qwen-vl-plus')).toBe(true)
    expect(modelSupportsVision('moonshotai:moonshot-v1-32k-vision-preview')).toBe(true)
    expect(modelSupportsVision('zhipu:glm-4v-flash')).toBe(true)
  })

  it('returns false for listed text-only models even on image-capable providers', () => {
    // alibaba / zhipu providers accept image parts at the API level, but these
    // specific models are text-only — the per-model flag must win.
    expect(modelSupportsVision('alibaba:qwen3.7-max')).toBe(false)
    expect(modelSupportsVision('zhipu:glm-5.1')).toBe(false)
    expect(modelSupportsVision('deepseek:deepseek-v4-flash')).toBe(false)
  })

  it('expands aliases before lookup', () => {
    expect(modelSupportsVision('opus')).toBe(true) // → anthropic:claude-opus-4-8
    expect(modelSupportsVision('deepseek')).toBe(false) // → deepseek:deepseek-v4-flash
  })

  it('falls back to provider-level capability for unlisted ids', () => {
    // Not in the catalog → defer to the provider's image capability.
    expect(modelSupportsVision('anthropic:claude-some-future-model')).toBe(true)
    expect(modelSupportsVision('deepseek:some-future-model')).toBe(false)
    expect(modelSupportsVision('unknownprovider:whatever')).toBe(false)
  })

  it('provider-level capabilitiesOf stays coarse (provider, not model)', () => {
    // capabilitiesOf is intentionally provider-level; both Qwen models report
    // image:true there, and only modelSupportsVision distinguishes them.
    expect(capabilitiesOf('alibaba:qwen3.7-max').image).toBe(true)
    expect(capabilitiesOf('alibaba:qwen-vl-plus').image).toBe(true)
    expect(modelSupportsVision('alibaba:qwen3.7-max')).toBe(false)
    expect(modelSupportsVision('alibaba:qwen-vl-plus')).toBe(true)
  })
})

describe('toolResultImage capability', () => {
  it('is true only for Anthropic — the one provider that carries images in tool-results', () => {
    expect(capabilitiesOf('anthropic:claude-sonnet-4-6').toolResultImage).toBe(true)
  })

  it('is false for providers that accept images only in USER messages', () => {
    // These report image:true (a pasted image works in a user message) but
    // their API JSON.stringifies tool-result content, so a screenshot returned
    // FROM a tool degrades to base64 text. Must be captioned, not embedded.
    for (const id of [
      'openai:gpt-5',
      'google:gemini-2.5-flash',
      'moonshotai:kimi-k2.6',
      'alibaba:qwen-vl-plus',
      'zhipu:glm-4v-flash',
      'xai:grok-4.3',
      'deepseek:deepseek-v4',
      'custom:whatever',
      'unknownprovider:whatever',
    ]) {
      expect(capabilitiesOf(id).toolResultImage, id).toBe(false)
    }
  })
})
