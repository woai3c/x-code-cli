import type { AgentOptions, LanguageModel, TerminateAllResult, TerminationReason } from '@x-code-cli/core'

import { runPrintMode } from '../src/print.js'

const coreMocks = vi.hoisted(() => ({
  agentLoop: vi.fn(),
  createLoopState: vi.fn(),
  hydrateLoopState: vi.fn(),
  saveSession: vi.fn(),
  forceTerminateManagedShellsSync: vi.fn(),
}))

vi.mock('@x-code-cli/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@x-code-cli/core')>()
  return {
    ...original,
    agentLoop: coreMocks.agentLoop,
    createLoopState: coreMocks.createLoopState,
    hydrateLoopState: coreMocks.hydrateLoopState,
    saveSession: coreMocks.saveSession,
    forceTerminateManagedShellsSync: coreMocks.forceTerminateManagedShellsSync,
  }
})

function terminated(reason: TerminationReason): TerminateAllResult {
  return {
    managerInstanceId: 'manager-print',
    reason,
    requested: 0,
    confirmed: 0,
    alreadyExited: 0,
    results: [],
  }
}

const model = {} as LanguageModel
const options: AgentOptions = { modelId: 'test-model', trustMode: true, printMode: true }

describe('print-mode shell lifecycle', () => {
  beforeEach(() => {
    coreMocks.agentLoop.mockReset().mockResolvedValue(undefined)
    coreMocks.createLoopState.mockReset()
    coreMocks.hydrateLoopState.mockReset()
    coreMocks.saveSession.mockReset().mockResolvedValue(undefined)
    coreMocks.forceTerminateManagedShellsSync.mockReset().mockImplementation((reason: TerminationReason) => ({
      reason,
      requested: 0,
      results: [],
    }))
  })

  it('stops the final manager before saving a successful print session', async () => {
    const order: string[] = []
    const dispose = vi.fn(async (reason: TerminationReason) => {
      order.push('shell')
      return terminated(reason)
    })
    coreMocks.createLoopState.mockReturnValue({ shellSessions: { dispose } })
    coreMocks.saveSession.mockImplementation(async () => {
      order.push('save')
    })

    await expect(runPrintMode(model, options, 'hello')).resolves.toBe(0)

    expect(order).toEqual(['shell', 'save'])
    expect(dispose).toHaveBeenCalledWith('print-exit', expect.any(Object))
  })

  it('still disposes the final manager when agentLoop throws', async () => {
    const dispose = vi.fn(async (reason: TerminationReason) => terminated(reason))
    coreMocks.createLoopState.mockReturnValue({ shellSessions: { dispose } })
    coreMocks.agentLoop.mockRejectedValue(new Error('model failed'))

    await expect(runPrintMode(model, options, 'hello')).resolves.toBe(1)

    expect(dispose).toHaveBeenCalledWith('print-exit', expect.any(Object))
    expect(coreMocks.saveSession).not.toHaveBeenCalled()
  })

  it('does not let a save failure bypass or reverse process-tree cleanup', async () => {
    const order: string[] = []
    const dispose = vi.fn(async (reason: TerminationReason) => {
      order.push('shell')
      return terminated(reason)
    })
    coreMocks.createLoopState.mockReturnValue({ shellSessions: { dispose } })
    coreMocks.saveSession.mockImplementation(async () => {
      order.push('save')
      throw new Error('disk unavailable')
    })

    await expect(runPrintMode(model, options, 'hello')).resolves.toBe(0)

    expect(order).toEqual(['shell', 'save'])
  })
})
