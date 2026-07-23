import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { saveUserConfig } from '../src/config/index.js'
import { createModelRegistry, kimiCodingModelId } from '../src/providers/registry.js'

describe('Kimi endpoint model ids', () => {
  let testHome: string

  beforeEach(() => {
    testHome = path.join(os.tmpdir(), `x-code-provider-registry-${Math.random().toString(36).slice(2)}`)
    process.env.X_CODE_HOME = testHome
    process.env.MOONSHOT_API_KEY = 'test-key'
  })

  afterEach(() => {
    delete process.env.X_CODE_HOME
    delete process.env.MOONSHOT_API_KEY
    fs.rmSync(testHome, { recursive: true, force: true })
  })

  it('maps platform model ids to the Coding Plan wire ids', () => {
    expect(kimiCodingModelId('kimi-k3')).toBe('k3')
    expect(kimiCodingModelId('kimi-k2.7-code')).toBe('kimi-for-coding')
    expect(kimiCodingModelId('kimi-k2.7-code-highspeed')).toBe('kimi-for-coding-highspeed')
    expect(kimiCodingModelId('kimi-k2.6')).toBe('kimi-for-coding')
    expect(kimiCodingModelId('future-model')).toBe('future-model')
  })

  it('uses Coding Plan wire ids only on the Coding Plan endpoint', () => {
    saveUserConfig({ baseUrls: { moonshotai: 'https://api.kimi.com/coding/v1' } })
    let registry = createModelRegistry()
    expect(registry.languageModel('moonshotai:kimi-k3').modelId).toBe('k3')
    expect(registry.languageModel('moonshotai:kimi-k2.7-code').modelId).toBe('kimi-for-coding')
    expect(registry.languageModel('moonshotai:kimi-k2.6').modelId).toBe('kimi-for-coding')

    saveUserConfig({ baseUrls: { moonshotai: 'https://api.moonshot.ai/v1' } })
    registry = createModelRegistry()
    expect(registry.languageModel('moonshotai:kimi-k3').modelId).toBe('kimi-k3')
    expect(registry.languageModel('moonshotai:kimi-k2.7-code').modelId).toBe('kimi-k2.7-code')
  })
})
