import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createContextCommandHandler, parseContextWindowSize } from '../src/ui/app/commands/context.js'

const contextMocks = vi.hoisted(() => ({
  override: undefined as number | undefined,
  getContextWindow: vi.fn(() => 1_047_576),
  saveUserConfig: vi.fn(() => true),
  setContextWindowOverride: vi.fn((value: unknown) => {
    contextMocks.override = typeof value === 'number' ? value : undefined
    return contextMocks.override
  }),
}))

vi.mock('@x-code-cli/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@x-code-cli/core')>()
  return {
    ...actual,
    getContextWindow: contextMocks.getContextWindow,
    getContextWindowOverride: () => contextMocks.override,
    saveUserConfig: contextMocks.saveUserConfig,
    setContextWindowOverride: contextMocks.setContextWindowOverride,
  }
})

function setup() {
  const addCommandMessage = vi.fn()
  const { handleContext } = createContextCommandHandler({
    modelId: 'openai:gpt-5.6-sol',
    addCommandMessage,
  })
  return { addCommandMessage, handleContext }
}

describe('parseContextWindowSize', () => {
  it('accepts exact token counts and decimal k/m suffixes', () => {
    expect(parseContextWindowSize('128000')).toBe(128000)
    expect(parseContextWindowSize('128k')).toBe(128000)
    expect(parseContextWindowSize('1.5M')).toBe(1500000)
    expect(parseContextWindowSize('1_047_576')).toBe(1047576)
  })

  it('rejects undersized, fractional-token, and malformed values', () => {
    expect(parseContextWindowSize('32767')).toBeNull()
    expect(parseContextWindowSize('1.5')).toBeNull()
    expect(parseContextWindowSize('1,5m')).toBeNull()
    expect(parseContextWindowSize('128kb')).toBeNull()
  })
})

describe('/context command', () => {
  beforeEach(() => {
    contextMocks.override = undefined
    contextMocks.getContextWindow.mockReset()
    contextMocks.getContextWindow.mockReturnValue(1_047_576)
    contextMocks.saveUserConfig.mockReset()
    contextMocks.saveUserConfig.mockReturnValue(true)
    contextMocks.setContextWindowOverride.mockClear()
  })

  it('reports model defaults when no override is active', () => {
    const command = setup()

    command.handleContext('/context', '')

    expect(command.addCommandMessage.mock.calls[0]?.[1]).toContain('No context window override is set')
    expect(command.addCommandMessage.mock.calls[0]?.[1]).toContain('1,047,576 tokens')
  })

  it('persists and applies one override to every model', () => {
    const command = setup()

    command.handleContext('/context 128k', '128k')

    expect(contextMocks.saveUserConfig).toHaveBeenCalledWith({ contextWindow: 128000 })
    expect(contextMocks.setContextWindowOverride).toHaveBeenCalledWith(128000)
    expect(command.addCommandMessage.mock.calls[0]?.[1]).toContain('128,000 tokens')
    expect(command.addCommandMessage.mock.calls[0]?.[1]).toContain('every model')
  })

  it('removes the persisted override and restores model defaults', () => {
    contextMocks.override = 128000
    contextMocks.getContextWindow.mockReturnValue(258400)
    const command = setup()

    command.handleContext('/context reset', 'reset')

    expect(contextMocks.saveUserConfig).toHaveBeenCalledWith({ contextWindow: undefined })
    expect(contextMocks.setContextWindowOverride).toHaveBeenCalledWith(undefined)
    expect(command.addCommandMessage.mock.calls[0]?.[1]).toContain('258,400-token')
  })

  it('clears persisted state even when this process has no active override', () => {
    const command = setup()

    command.handleContext('/context reset', 'reset')

    expect(contextMocks.saveUserConfig).toHaveBeenCalledWith({ contextWindow: undefined })
    expect(contextMocks.setContextWindowOverride).toHaveBeenCalledWith(undefined)
  })

  it.each(['off', 'auto', 'default', 'unset', 'status'])(
    'rejects unsupported reset or status argument %s',
    (argument) => {
      const command = setup()

      command.handleContext(`/context ${argument}`, argument)

      expect(command.addCommandMessage.mock.calls[0]?.[1]).toContain('Usage: /context [tokens|reset]')
      expect(contextMocks.saveUserConfig).not.toHaveBeenCalled()
      expect(contextMocks.setContextWindowOverride).not.toHaveBeenCalled()
    },
  )

  it('keeps the runtime change but reports a persistence failure', () => {
    contextMocks.saveUserConfig.mockReturnValue(false)
    const command = setup()

    command.handleContext('/context 128k', '128k')

    expect(contextMocks.setContextWindowOverride).toHaveBeenCalledWith(128000)
    expect(command.addCommandMessage.mock.calls[0]?.[1]).toContain('config.json could not be updated')
  })
})
