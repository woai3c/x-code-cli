// Tests for config module
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import os from 'node:os'
import path from 'node:path'

import { resetOpenAIAuthContextForTesting } from '../src/auth/openai-chatgpt/auth-resolver.js'
import { writeOpenAIChatGPTCredentials } from '../src/auth/openai-chatgpt/credential-store.js'
import {
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_PEER_MESSAGING_CONFIG,
  DEFAULT_STREAM_CONFIG,
  getAvailableProviders,
  getProviderOptions,
  resolveBrowserConfig,
  resolveMemoryConfig,
  resolveModelId,
  resolvePeerMessagingConfig,
  resolveStreamConfig,
} from '../src/config/index.js'
import { PROVIDER_ENV_VARS } from './provider-env.js'

describe('resolvePeerMessagingConfig', () => {
  it('falls back safely for malformed policy values', () => {
    expect(resolvePeerMessagingConfig(undefined)).toEqual(DEFAULT_PEER_MESSAGING_CONFIG)
    expect(resolvePeerMessagingConfig({ enabled: 'yes', inbound: 'open', dialogExpiryMs: -1 })).toEqual(
      DEFAULT_PEER_MESSAGING_CONFIG,
    )
  })

  it('accepts inbound policy and bounded dialog expiry only', () => {
    expect(resolvePeerMessagingConfig({ enabled: true, inbound: 'hold', dialogExpiryMs: 10_000 })).toEqual({
      inbound: 'hold',
      dialogExpiryMs: 10_000,
    })
    expect(resolvePeerMessagingConfig({ enabled: true, inbound: 'accept', dialogExpiryMs: 1_800_001 })).toEqual({
      inbound: 'accept',
      dialogExpiryMs: DEFAULT_PEER_MESSAGING_CONFIG.dialogExpiryMs,
    })
  })
})

// Scrub the developer's real shell keys so they can't leak into the
// "no providers configured" assertions.
function clearProviderEnvVars(): void {
  for (const key of PROVIDER_ENV_VARS) delete process.env[key]
  resetOpenAIAuthContextForTesting()
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
    expect(resolveModelId('anthropic:claude-sonnet-5')).toBe('anthropic:claude-sonnet-5')
  })

  it('resolves alias from CLI argument', () => {
    expect(resolveModelId('sonnet')).toBe('anthropic:claude-sonnet-5')
    expect(resolveModelId('opus')).toBe('anthropic:claude-opus-4-8')
    expect(resolveModelId('deepseek')).toBe('deepseek:deepseek-v4-flash')
  })

  it('falls back to env var X_CODE_MODEL', () => {
    process.env.X_CODE_MODEL = 'openai:gpt-5.6-sol'
    expect(resolveModelId()).toBe('openai:gpt-5.6-sol')
  })

  it('resolves alias from X_CODE_MODEL env var', () => {
    process.env.X_CODE_MODEL = 'sonnet'
    expect(resolveModelId()).toBe('anthropic:claude-sonnet-5')
  })

  it('CLI argument takes precedence over X_CODE_MODEL', () => {
    process.env.X_CODE_MODEL = 'openai:gpt-5.6-sol'
    expect(resolveModelId('sonnet')).toBe('anthropic:claude-sonnet-5')
  })

  it('falls back to smart default from env API key', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    expect(resolveModelId()).toBe('anthropic:claude-sonnet-5')
  })

  it('follows provider detection order', () => {
    process.env.OPENAI_API_KEY = 'test-key'
    expect(resolveModelId()).toBe('openai:gpt-5.6-sol')
  })

  it('returns null when no providers configured', () => {
    expect(resolveModelId()).toBeNull()
  })

  it('returns model even if provider key missing when explicitly requested', () => {
    expect(resolveModelId('deepseek')).toBe('deepseek:deepseek-v4-flash')
  })

  it('uses ChatGPT authentication as the OpenAI smart default without an API key', async () => {
    await writeOpenAIChatGPTCredentials({
      version: 1,
      accessToken: 'oauth-access',
      refreshToken: 'oauth-refresh',
      expiresAt: Date.now() + 60_000,
    })
    resetOpenAIAuthContextForTesting()
    expect(resolveModelId()).toBe('openai:gpt-5.6-sol')
  })
})

describe('getAvailableProviders', () => {
  beforeEach(() => {
    isolateUserConfig()
    clearProviderEnvVars()
  })

  afterEach(() => {
    delete process.env.X_CODE_HOME
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

  it('keeps OpenAI available through ChatGPT auth while the API key stays inactive', async () => {
    process.env.OPENAI_API_KEY = 'platform-key'
    await writeOpenAIChatGPTCredentials({
      version: 1,
      accessToken: 'oauth-access',
      refreshToken: 'oauth-refresh',
      expiresAt: Date.now() + 60_000,
    })
    resetOpenAIAuthContextForTesting()
    expect(getAvailableProviders()).toContain('openai')
    expect(getProviderOptions().openai).toBeUndefined()
  })
})

describe('memory config', () => {
  it('keeps memory always active and merges nested recall overrides', () => {
    expect(resolveMemoryConfig({})).toEqual(DEFAULT_MEMORY_CONFIG)
    expect(resolveMemoryConfig({ memory: { recall: { semanticSelector: 'off' } } }).recall).toEqual({
      ...DEFAULT_MEMORY_CONFIG.recall,
      semanticSelector: 'off',
    })
    expect(
      resolveMemoryConfig({ memory: { enabled: false } } as unknown as Parameters<typeof resolveMemoryConfig>[0]),
    ).toEqual(DEFAULT_MEMORY_CONFIG)
  })

  it('rejects malformed and unsafe memory limits from hand-edited config', () => {
    const malformed = {
      memory: {
        maxInputTokens: -1,
        maxOperationsPerTurn: 99,
        recall: { maxTopicsPerTurn: 500, semanticSelector: 'sometimes' },
      },
    } as unknown as Parameters<typeof resolveMemoryConfig>[0]
    expect(resolveMemoryConfig(malformed)).toEqual(DEFAULT_MEMORY_CONFIG)
  })

  it('resolves memory reasoning and total generation budget safely', () => {
    expect(
      resolveMemoryConfig({
        memory: { reasoning: 'low', maxOutputTokens: 2000, maxTotalOutputTokens: 6000 },
      }).reasoning,
    ).toBe('low')
    expect(
      resolveMemoryConfig({
        memory: { reasoning: 'low', maxOutputTokens: 2000, maxTotalOutputTokens: 6000 },
      }).maxTotalOutputTokens,
    ).toBe(6000)
    expect(
      resolveMemoryConfig({ memory: { maxOutputTokens: 4000, maxTotalOutputTokens: 1000 } }).maxTotalOutputTokens,
    ).toBe(4000)
  })
})

describe('stream config', () => {
  it('uses reconnect and idle-timeout defaults', () => {
    expect(resolveStreamConfig({})).toEqual(DEFAULT_STREAM_CONFIG)
  })

  it('accepts bounded overrides and allows disabling the watchdog', () => {
    expect(resolveStreamConfig({ stream: { maxRetries: 2, idleTimeoutMs: 1500 } })).toEqual({
      maxRetries: 2,
      idleTimeoutMs: 1500,
    })
    expect(resolveStreamConfig({ stream: { maxRetries: 0, idleTimeoutMs: 0 } })).toEqual({
      maxRetries: 0,
      idleTimeoutMs: 0,
    })
  })

  it('rejects malformed or unsafe overrides', () => {
    expect(
      resolveStreamConfig({
        stream: { maxRetries: 101, idleTimeoutMs: 50 },
      }),
    ).toEqual(DEFAULT_STREAM_CONFIG)
  })
})

describe('browser config', () => {
  it('normalizes supported channels and bounded viewport dimensions', () => {
    expect(resolveBrowserConfig({ browser: 'chromium', viewport: '1440x900', headless: true })).toEqual({
      browser: 'chromium',
      viewport: '1440,900',
      headless: true,
    })
  })

  it('drops malformed browser settings and invalid custom argv', () => {
    expect(
      resolveBrowserConfig({
        browser: 'safari',
        viewport: '99999,1',
        command: ' custom-browser ',
        args: ['--stdio', 42],
        enabled: 'yes',
      }),
    ).toEqual({})
  })
})
