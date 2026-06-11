// Tests for config module
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import os from 'node:os'
import path from 'node:path'

import { getAvailableProviders, resolveModelId } from '../src/config/index.js'

/** Every provider env var the config module reads. Mirrors `ENV_MAP` in
 *  `src/config/index.ts` plus the `OPENAI_COMPATIBLE_*` pair from
 *  `getAvailableProviders`. Listed in full so a developer running tests
 *  with any single provider key set in their shell (Google for Gemini,
 *  Alibaba for Qwen, etc.) doesn't get a leak that fails the
 *  "no providers configured" assertions. Update when adding providers. */
const PROVIDER_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'ALIBABA_API_KEY',
  'ZHIPU_API_KEY',
  'MOONSHOT_API_KEY',
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
] as const

function clearProviderEnvVars(): void {
  for (const key of PROVIDER_ENV_VARS) delete process.env[key]
}

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
    clearProviderEnvVars()
  })

  afterEach(() => {
    delete process.env.X_CODE_HOME
    delete process.env.X_CODE_MODEL
    clearProviderEnvVars()
  })

  it('resolves from CLI argument', () => {
    expect(resolveModelId('anthropic:claude-sonnet-4-6')).toBe('anthropic:claude-sonnet-4-6')
  })

  it('resolves alias from CLI argument', () => {
    expect(resolveModelId('sonnet')).toBe('anthropic:claude-sonnet-4-6')
    expect(resolveModelId('opus')).toBe('anthropic:claude-opus-4-8')
    expect(resolveModelId('deepseek')).toBe('deepseek:deepseek-v4-flash')
  })

  it('falls back to env var X_CODE_MODEL', () => {
    process.env.X_CODE_MODEL = 'openai:gpt-4.1'
    expect(resolveModelId()).toBe('openai:gpt-4.1')
  })

  it('resolves alias from X_CODE_MODEL env var', () => {
    process.env.X_CODE_MODEL = 'sonnet'
    expect(resolveModelId()).toBe('anthropic:claude-sonnet-4-6')
  })

  it('CLI argument takes precedence over X_CODE_MODEL', () => {
    process.env.X_CODE_MODEL = 'openai:gpt-4.1'
    expect(resolveModelId('sonnet')).toBe('anthropic:claude-sonnet-4-6')
  })

  it('falls back to smart default from env API key', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    expect(resolveModelId()).toBe('anthropic:claude-sonnet-4-6')
  })

  it('follows provider detection order', () => {
    process.env.OPENAI_API_KEY = 'test-key'
    expect(resolveModelId()).toBe('openai:gpt-5.5')
  })

  it('returns null when no providers configured', () => {
    expect(resolveModelId()).toBeNull()
  })

  it('returns model even if provider key missing when explicitly requested', () => {
    expect(resolveModelId('deepseek')).toBe('deepseek:deepseek-v4-flash')
  })
})

describe('getAvailableProviders', () => {
  beforeEach(() => {
    clearProviderEnvVars()
  })

  afterEach(() => {
    clearProviderEnvVars()
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
