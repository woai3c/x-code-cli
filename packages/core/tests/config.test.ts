// Tests for config module

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { resolveModelId, getAvailableProviders } from '../src/config/index.js'
import type { AppConfig } from '../src/types/index.js'

describe('resolveModelId', () => {
  const emptyConfig: AppConfig = { providers: {} }
  const configWithModel: AppConfig = { model: 'anthropic:claude-sonnet-4-5', providers: {} }

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

  it('falls back to config file model', () => {
    expect(resolveModelId(undefined, configWithModel)).toBe('anthropic:claude-sonnet-4-5')
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

  it('falls back to config providers for smart default', () => {
    const config: AppConfig = {
      providers: {
        deepseek: { apiKey: 'sk-test' },
      },
    }
    expect(resolveModelId(undefined, config)).toBe('deepseek:deepseek-chat')
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

  it('returns empty array when no providers configured', () => {
    expect(getAvailableProviders({ providers: {} })).toEqual([])
  })

  it('detects providers from env vars', () => {
    process.env.ANTHROPIC_API_KEY = 'test'
    process.env.OPENAI_API_KEY = 'test'
    const providers = getAvailableProviders({ providers: {} })
    expect(providers).toContain('anthropic')
    expect(providers).toContain('openai')
  })

  it('detects providers from config', () => {
    const config: AppConfig = {
      providers: {
        deepseek: { apiKey: 'sk-test' },
      },
    }
    expect(getAvailableProviders(config)).toContain('deepseek')
  })
})
