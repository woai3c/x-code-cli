// Tests for config module

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { resolveModelId, getAvailableProviders } from '../src/config/index.js'
import type { AppConfig } from '../src/types/index.js'

describe('resolveModelId', () => {
  const emptyConfig: AppConfig = {}
  const configWithModel: AppConfig = { model: 'anthropic:claude-sonnet-4-5' }

  beforeEach(() => {
    // Clear env vars
    delete process.env.X_CODE_MODEL
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.DEEPSEEK_API_KEY
  })

  afterEach(() => {
    delete process.env.X_CODE_MODEL
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.DEEPSEEK_API_KEY
  })

  it('resolves from CLI argument', () => {
    expect(resolveModelId('anthropic:claude-sonnet-4-5', emptyConfig)).toBe('anthropic:claude-sonnet-4-5')
  })

  it('resolves alias from CLI argument', () => {
    expect(resolveModelId('sonnet', emptyConfig)).toBe('anthropic:claude-sonnet-4-5')
    expect(resolveModelId('opus', emptyConfig)).toBe('anthropic:claude-opus-4-6')
    expect(resolveModelId('deepseek', emptyConfig)).toBe('deepseek:deepseek-chat')
  })

  it('falls back to env var X_CODE_MODEL', () => {
    process.env.X_CODE_MODEL = 'openai:gpt-4.1'
    expect(resolveModelId(undefined, emptyConfig)).toBe('openai:gpt-4.1')
  })

  it('falls back to config file model only if provider key exists', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    expect(resolveModelId(undefined, configWithModel)).toBe('anthropic:claude-sonnet-4-5')
  })

  it('skips config file model if provider key missing', () => {
    // Config has anthropic model but no ANTHROPIC_API_KEY → falls through
    process.env.OPENAI_API_KEY = 'test-key'
    expect(resolveModelId(undefined, configWithModel)).toBe('openai:gpt-4.1')
  })

  it('falls back to smart default from env API key', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    expect(resolveModelId(undefined, emptyConfig)).toBe('anthropic:claude-sonnet-4-5')
  })

  it('follows provider detection order', () => {
    process.env.OPENAI_API_KEY = 'test-key'
    expect(resolveModelId(undefined, emptyConfig)).toBe('openai:gpt-4.1')
  })

  it('returns null when no providers configured', () => {
    expect(resolveModelId(undefined, emptyConfig)).toBeNull()
  })

  it('returns model even if provider key missing when explicitly requested via input', () => {
    // --model deepseek should return it even without key (will error at runtime)
    expect(resolveModelId('deepseek', emptyConfig)).toBe('deepseek:deepseek-chat')
  })
})

describe('getAvailableProviders', () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.DEEPSEEK_API_KEY
  })

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.DEEPSEEK_API_KEY
  })

  it('returns empty array when no env vars set', () => {
    expect(getAvailableProviders()).toEqual([])
  })

  it('detects providers from env vars', () => {
    process.env.ANTHROPIC_API_KEY = 'test'
    process.env.OPENAI_API_KEY = 'test'
    const providers = getAvailableProviders()
    expect(providers).toContain('anthropic')
    expect(providers).toContain('openai')
  })

  it('does not detect providers from config file only', () => {
    // API keys must come from env vars, not config file
    const providers = getAvailableProviders()
    expect(providers).not.toContain('deepseek')
  })
})
