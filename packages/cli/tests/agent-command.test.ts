import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createBuiltInRegistry, loadUserConfig } from '@x-code-cli/core'
import type { AgentOptions } from '@x-code-cli/core'

import { createAgentCommandHandler } from '../src/ui/app/commands/agent.js'

describe('/agent command', () => {
  let homeDir: string
  let prevHome: string | undefined
  let prevOpenAIKey: string | undefined
  let prevGoogleKey: string | undefined

  beforeEach(async () => {
    prevHome = process.env.X_CODE_HOME
    prevOpenAIKey = process.env.OPENAI_API_KEY
    prevGoogleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-agent-cmd-'))
    process.env.X_CODE_HOME = homeDir
    process.env.OPENAI_API_KEY = 'sk-test-openai'
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'sk-test-google'
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.X_CODE_HOME
    else process.env.X_CODE_HOME = prevHome
    if (prevOpenAIKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevOpenAIKey
    if (prevGoogleKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = prevGoogleKey
    await fs.rm(homeDir, { recursive: true, force: true })
  })

  function setup(modelId = 'openai:gpt-6.2-astra') {
    const options: AgentOptions = {
      modelId,
      trustMode: false,
      printMode: false,
      subAgentRegistry: createBuiltInRegistry(),
    }
    const addCommandMessage = vi.fn()
    const askQuestion =
      vi.fn<
        (
          question: string,
          opts: { label: string; description: string }[],
          cfg?: { noOther?: boolean },
        ) => Promise<string>
      >()
    const { handleAgent } = createAgentCommandHandler({
      options,
      modelId,
      addCommandMessage,
      askQuestion,
    })
    return { options, handleAgent, addCommandMessage, askQuestion }
  }

  it('lists explore, plan, and worker inheriting the main model by default', async () => {
    const cmd = setup('openai:gpt-6.2-astra')

    await cmd.handleAgent('/agent list', 'list')

    const message = cmd.addCommandMessage.mock.calls[0]?.[1] as string
    expect(message).toContain('**explore**')
    expect(message).toContain('**plan**')
    expect(message).toContain('**worker**')
    expect(message).not.toContain('goal-verifier')
    expect(message).toContain('inherit (openai:gpt-6.2-astra)')
  })

  it('sets and resets a single sub-agent model via /agent worker <model|inherit>', async () => {
    const cmd = setup('openai:gpt-6.2-astra')

    await cmd.handleAgent('/agent worker sol', 'worker sol')

    expect(loadUserConfig().subAgentModels).toEqual({ worker: 'openai:gpt-6.2-sol' })
    expect(cmd.options.modelRegistry).toBeDefined()
    expect(cmd.addCommandMessage.mock.calls[0]?.[1]).toContain('Set **worker** model')

    cmd.addCommandMessage.mockClear()
    await cmd.handleAgent('/agent worker inherit', 'worker inherit')

    expect(loadUserConfig().subAgentModels).toBeUndefined()
    expect(cmd.addCommandMessage.mock.calls[0]?.[1]).toContain('Reset **worker** model override')
  })

  it('supports /agent model <model> for global default and /agent reset to clear all overrides', async () => {
    const cmd = setup('openai:gpt-6.2-astra')

    await cmd.handleAgent('/agent model luna', 'model luna')
    await cmd.handleAgent('/agent worker sol', 'worker sol')
    expect(loadUserConfig()).toMatchObject({
      subAgentModel: 'openai:gpt-6-luna',
      subAgentModels: { worker: 'openai:gpt-6.2-sol' },
    })

    cmd.addCommandMessage.mockClear()
    await cmd.handleAgent('/agent reset', 'reset')

    expect(loadUserConfig().subAgentModel).toBeUndefined()
    expect(loadUserConfig().subAgentModels).toBeUndefined()
    expect(cmd.addCommandMessage.mock.calls[0]?.[1]).toContain('Reset all sub-agents to inherit main model')
  })

  it('drives two-step interactive picker when invoked with no arguments', async () => {
    const cmd = setup('openai:gpt-6.2-astra')
    cmd.askQuestion
      .mockImplementationOnce(async (_q, choices) => {
        const workerChoice = choices.find((c) => c.label.includes('worker —'))
        expect(workerChoice).toBeDefined()
        return workerChoice!.label
      })
      .mockImplementationOnce(async (_q, choices) => {
        const solChoice = choices.find((c) => c.description.startsWith('openai:gpt-6.2-sol —'))
        expect(solChoice).toBeDefined()
        return solChoice!.label
      })

    await cmd.handleAgent('/agent', '')

    expect(cmd.askQuestion).toHaveBeenCalledTimes(2)
    expect(loadUserConfig().subAgentModels).toEqual({ worker: 'openai:gpt-6.2-sol' })
  })

  it('rejects unknown sub-agents and unconfigured providers without persisting invalid config', async () => {
    const cmd = setup('openai:gpt-6.2-astra')

    await cmd.handleAgent('/agent unknown-agent sol', 'unknown-agent sol')
    expect(cmd.addCommandMessage.mock.calls[0]?.[1]).toContain('Available sub-agents:')
    expect(loadUserConfig().subAgentModels).toBeUndefined()

    cmd.addCommandMessage.mockClear()
    delete process.env.ANTHROPIC_API_KEY
    await cmd.handleAgent('/agent worker sonnet', 'worker sonnet')
    expect(cmd.addCommandMessage.mock.calls[0]?.[1]).toContain('Failed to set sub-agent model')
    expect(loadUserConfig().subAgentModels).toBeUndefined()
  })

  it('normalizes agent name casing and reflects live options.modelId switches immediately', async () => {
    const cmd = setup('openai:gpt-6.2-astra')
    cmd.options.modelId = 'google:gemini-4-carbon'

    await cmd.handleAgent('/agent WORKER sol', 'WORKER sol')
    expect(loadUserConfig().subAgentModels).toEqual({ worker: 'openai:gpt-6.2-sol' })

    cmd.addCommandMessage.mockClear()
    await cmd.handleAgent('/agent list', 'list')
    const listText = cmd.addCommandMessage.mock.calls[0]?.[1] as string
    expect(listText).toContain('inherit (google:gemini-4-carbon)')
    expect(listText).toContain('`openai:gpt-6.2-sol`')
  })
})
