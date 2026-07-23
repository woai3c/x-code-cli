// Tests for provider/model capability lookups — in particular the per-model
// vision flag that gates the browser agent's visual mode.
import { describe, expect, it } from 'vitest'

import { capabilitiesOf, modelSupportsVision } from '../src/providers/capabilities.js'

describe('modelSupportsVision', () => {
  it('returns the catalog vision flag for listed vision models', () => {
    expect(modelSupportsVision('anthropic:claude-haiku-4-5')).toBe(true)
    expect(modelSupportsVision('moonshotai:kimi-k3')).toBe(true)
    expect(modelSupportsVision('moonshotai:kimi-k2.6')).toBe(true)
    expect(modelSupportsVision('alibaba:qwen3-vl-flash')).toBe(true)
    expect(modelSupportsVision('zhipu:glm-4.6v')).toBe(true)
  })

  it('returns false for listed text-only models even on image-capable providers', () => {
    // alibaba / zhipu providers accept image parts at the API level, but these
    // specific models are text-only — the per-model flag must win.
    expect(modelSupportsVision('alibaba:qwen3.7-max')).toBe(false)
    expect(modelSupportsVision('zhipu:glm-5.2')).toBe(false)
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
    expect(capabilitiesOf('alibaba:qwen3-vl-flash').image).toBe(true)
    expect(modelSupportsVision('alibaba:qwen3.7-max')).toBe(false)
    expect(modelSupportsVision('alibaba:qwen3-vl-flash')).toBe(true)
  })
})

describe('toolImageTransport capability', () => {
  it('uses native tool-result media where the provider SDK preserves it', () => {
    for (const id of ['anthropic:claude-sonnet-5', 'openai:gpt-5.6-sol', 'google:gemini-2.5-flash']) {
      expect(capabilitiesOf(id).toolImageTransport, id).toBe('tool-result')
    }
  })

  it('reattaches media in a following user message for Chat Completions providers', () => {
    for (const id of ['moonshotai:kimi-k2.6', 'alibaba:qwen3-vl-flash', 'zhipu:glm-4.6v', 'xai:grok-4.3']) {
      expect(capabilitiesOf(id).toolImageTransport, id).toBe('user-message')
    }
  })

  it('marks text-only and unknown providers unsupported', () => {
    for (const id of ['deepseek:deepseek-v4', 'custom:whatever', 'unknownprovider:whatever']) {
      expect(capabilitiesOf(id).toolImageTransport, id).toBe('unsupported')
    }
  })
})
