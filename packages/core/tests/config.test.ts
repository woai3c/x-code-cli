// Tests for config module
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getAvailableProviders, resolveModelId } from '../src/config/index.js'

/** Redirect config.json reads to an empty tmpdir so the real user's
 *  ~/.x-code/config.json (possibly written by a recent /model switch)
 *  can't contaminate these assertions. */
function isolateUserConfig(): void {
  const tmp = path.join(os.tmpdir(), 'x-code-config-test-' + Math.random().toString(36).slice(2))
  process.env.X_CODE_HOME = tmp
}

describe('resolveModelId', () => {
  beforeEach(() => {
    isolateUserConfig()
    delete process.env.X_CODE_MODEL
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.DEEPSEEK_API_KEY
  })

  afterEach(() => {
    delete process.env.X_CODE_HOME
    delete process.env.X_CODE_MODEL
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.DEEPSEEK_API_KEY
  })

  it('resolves from CLI argument', () => {
    expect(resolveModelId('anthropic:claude-sonnet-4-5')).toBe('anthropic:claude-sonnet-4-5')
  })

  it('resolves alias from CLI argument', () => {
    expect(resolveModelId('sonnet')).toBe('anthropic:claude-sonnet-4-5')
    expect(resolveModelId('opus')).toBe('anthropic:claude-opus-4-6')
    expect(resolveModelId('deepseek')).toBe('deepseek:deepseek-chat')
  })

  it('falls back to env var X_CODE_MODEL', () => {
    process.env.X_CODE_MODEL = 'openai:gpt-4.1'
    expect(resolveModelId()).toBe('openai:gpt-4.1')
  })

  it('resolves alias from X_CODE_MODEL env var', () => {
    process.env.X_CODE_MODEL = 'sonnet'
    expect(resolveModelId()).toBe('anthropic:claude-sonnet-4-5')
  })

  it('CLI argument takes precedence over X_CODE_MODEL', () => {
    process.env.X_CODE_MODEL = 'openai:gpt-4.1'
    expect(resolveModelId('sonnet')).toBe('anthropic:claude-sonnet-4-5')
  })

  it('falls back to smart default from env API key', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    expect(resolveModelId()).toBe('anthropic:claude-sonnet-4-5')
  })

  it('follows provider detection order', () => {
    process.env.OPENAI_API_KEY = 'test-key'
    expect(resolveModelId()).toBe('openai:gpt-4.1')
  })

  it('returns null when no providers configured', () => {
    expect(resolveModelId()).toBeNull()
  })

  it('returns model even if provider key missing when explicitly requested', () => {
    expect(resolveModelId('deepseek')).toBe('deepseek:deepseek-chat')
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
})
