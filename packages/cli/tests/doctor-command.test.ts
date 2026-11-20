import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  createBuiltInRegistry,
  initializeOpenAIAuthContext,
  resetOpenAIAuthContextForTesting,
  writeOpenAIChatGPTCredentials,
} from '@x-code-cli/core'
import type { AgentOptions } from '@x-code-cli/core'

import { createDoctorCommandHandler } from '../src/ui/app/commands/doctor.js'

const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'ALIBABA_API_KEY',
  'XAI_API_KEY',
  'ZHIPU_API_KEY',
  'MOONSHOT_API_KEY',
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
] as const

describe('/doctor command handler', () => {
  let savedEnv: Record<string, string | undefined>
  let testHome: string

  beforeEach(async () => {
    savedEnv = { X_CODE_HOME: process.env.X_CODE_HOME }
    for (const key of PROVIDER_ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-doctor-home-'))
    process.env.X_CODE_HOME = testHome
    resetOpenAIAuthContextForTesting()
  })

  afterEach(async () => {
    resetOpenAIAuthContextForTesting()
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
    await fs.rm(testHome, { recursive: true, force: true })
  })

  it('reports ChatGPT OAuth precedence over OPENAI_API_KEY alongside MCP, plugin, sub-agent, and skill health', async () => {
    process.env.OPENAI_API_KEY = 'sk-inactive-when-chatgpt-logged-in'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-active'
    await writeOpenAIChatGPTCredentials({
      version: 1,
      accessToken: 'oauth-access',
      refreshToken: 'oauth-refresh',
      expiresAt: Date.now() + 3600_000,
      accountId: 'acct-1',
    })
    initializeOpenAIAuthContext()

    const subAgentRegistry = createBuiltInRegistry()
    const echoed: string[] = []
    const infoMessages: string[] = []

    const handleDoctor = createDoctorCommandHandler({
      modelId: 'anthropic:claude-sonnet-5-5',
      echoCommand: (text) => echoed.push(text),
      addInfoMessage: (content) => infoMessages.push(content),
      options: {
        subAgentRegistry,
        mcpRegistry: {
          serverStatus: () => [
            { name: 'fs', status: { kind: 'connected', toolCount: 4, resourceCount: 1 } },
            { name: 'sentry', status: { kind: 'needs_auth' } },
            { name: 'db', status: { kind: 'failed', error: 'connection refused' }, stderrTail: 'ECONNREFUSED 5432' },
          ],
        },
        pluginRegistry: {
          listAll: () => [
            { id: 'a@official', enabled: true },
            { id: 'b@local', enabled: false },
          ],
          loadErrors: () => [{ id: 'bad@local', message: 'broken manifest' }],
        },
        skillRegistry: {
          listAll: () => [
            { name: 's1', disabled: false },
            { name: 's2', disabled: true },
          ],
        },
        commandRegistry: {
          list: () => [{ name: 'deploy', source: 'plugin', pluginId: 'a@official' }],
        },
      } as unknown as AgentOptions,
    })

    handleDoctor('/doctor')

    expect(echoed).toEqual(['/doctor'])
    expect(infoMessages).toHaveLength(1)
    const report = infoMessages[0]!

    expect(report).toContain('- Model:   anthropic:claude-sonnet-5-5')
    expect(report).toContain('- anthropic: ✓')
    expect(report).toContain('- openai: ✓ ChatGPT subscription; OPENAI_API_KEY inactive')
    expect(report).toContain('- deepseek: ✗  (set `DEEPSEEK_API_KEY`)')

    expect(report).toContain('- fs: ✓ connected (4 tools, 1 resources)')
    expect(report).toContain('- sentry: ⚠ needs authentication — run `/mcp auth sentry`')
    expect(report).toContain('- db: ✗ failed — connection refused')
    expect(report).toContain('stderr: ECONNREFUSED 5432')
    expect(report).toContain('⚠ 1 server failed. Check config or run `/mcp refresh`.')

    expect(report).toContain('- Loaded: 2 (1 enabled, 1 disabled)')
    expect(report).toContain('✗ bad@local — broken manifest')
    expect(report).toContain('• explore (built-in) — inherit (anthropic:claude-sonnet-5-5)')
    expect(report).toContain('- Total: 2 (1 enabled, 1 disabled)')
    expect(report).toContain('• /deploy (plugin, plugin: a@official)')
  })
})
