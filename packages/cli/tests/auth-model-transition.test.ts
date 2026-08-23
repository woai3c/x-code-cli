import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createModelRegistry,
  initializeOpenAIAuthContext,
  resetOpenAIAuthContextForTesting,
  writeOpenAIChatGPTCredentials,
} from '@x-code-cli/core'
import type { LanguageModel } from '@x-code-cli/core'

import { replaceActiveModelProvider } from '../src/ui/app/model-activation.js'

describe('ChatGPT auth model transition', () => {
  let testHome: string

  beforeEach(() => {
    testHome = path.join(os.tmpdir(), `x-code-auth-model-${crypto.randomUUID()}`)
    process.env.X_CODE_HOME = testHome
    process.env.OPENAI_API_KEY = 'platform-key-must-never-leak'
    resetOpenAIAuthContextForTesting()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetOpenAIAuthContextForTesting()
    delete process.env.X_CODE_HOME
    delete process.env.OPENAI_API_KEY
    fs.rmSync(testHome, { recursive: true, force: true })
  })

  it('replaces a live API-key model with the ChatGPT provider even when the catalog is empty', async () => {
    initializeOpenAIAuthContext()
    const options = { modelRegistry: createModelRegistry() }
    const staleApiKeyModel = options.modelRegistry.languageModel('openai:gpt-5.6-sol')
    let activeModel: LanguageModel = staleApiKeyModel

    await writeOpenAIChatGPTCredentials({
      version: 1,
      accessToken: 'oauth-access',
      refreshToken: 'oauth-refresh',
      expiresAt: Date.now() + 60 * 60 * 1000,
      accountId: 'account-1',
    })
    initializeOpenAIAuthContext()
    replaceActiveModelProvider('openai:gpt-5.6-sol', options, (_modelId, model) => {
      activeModel = model
    })

    expect(activeModel).not.toBe(staleApiKeyModel)
    expect(options.modelRegistry).not.toBeUndefined()
    expect(activeModel.modelId).toBe('gpt-5.6-sol')
  })
})
