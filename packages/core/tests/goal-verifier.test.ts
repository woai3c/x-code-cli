import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createGoal } from '../src/agent/goal/state.js'
import { runVerifierLadder } from '../src/agent/goal/verifier.js'
import { createLoopState } from '../src/agent/loop-state.js'
import type { AgentCallbacks, AgentOptions } from '../src/types/index.js'

const spawn = vi.fn()

vi.mock('../src/tools/shell-provider.js', () => ({
  getShellProvider: () => ({
    type: 'powershell',
    spawn,
  }),
}))

function callbacks(decision: 'yes' | 'always' | 'no' = 'yes'): AgentCallbacks {
  return {
    onTextDelta: vi.fn(),
    onToolCall: vi.fn(),
    onToolProgress: vi.fn(),
    onToolResult: vi.fn(),
    onAskPermission: vi.fn().mockResolvedValue(decision),
    onAskUser: vi.fn().mockResolvedValue('Yes'),
    onPlanApprovalRequest: vi.fn().mockResolvedValue(true),
    onPlanModeChange: vi.fn(),
    onTodosUpdate: vi.fn(),
    onShellOutput: vi.fn(),
    onUsageUpdate: vi.fn(),
    onContextCompressed: vi.fn(),
    onError: vi.fn(),
  }
}

function options(): AgentOptions {
  return {
    modelId: 'test:model',
    trustMode: false,
    printMode: false,
  }
}

describe('goal verifier', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    spawn.mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' })
  })

  it('uses permission classification for shell verifiers', async () => {
    const state = createLoopState()
    const goal = createGoal(state, { objective: 'verify', verifiers: [{ kind: 'shell', command: 'pwd' }] })
    const cb = callbacks()

    const result = await runVerifierLadder({ goal, state, options: options(), callbacks: cb, model: {} as any })

    expect(result.ok).toBe(true)
    expect(cb.onAskPermission).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith('pwd', expect.objectContaining({ cwd: process.cwd() }))
  })

  it('fails when shell verifier permission is denied', async () => {
    const state = createLoopState()
    const goal = createGoal(state, {
      objective: 'verify',
      verifiers: [{ kind: 'shell', command: 'npm install left-pad' }],
    })
    const cb = callbacks('no')

    const result = await runVerifierLadder({ goal, state, options: options(), callbacks: cb, model: {} as any })

    expect(result.ok).toBe(false)
    expect(cb.onAskPermission).toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects model-only completion evidence when no verifier or confirmation is configured', async () => {
    const state = createLoopState()
    const goal = createGoal(state, { objective: 'verify' })
    const cb = callbacks()

    const result = await runVerifierLadder({ goal, state, options: options(), callbacks: cb, model: {} as any })

    expect(result.ok).toBe(false)
    expect(result.summary).toMatch(/No verifier configured/)
    expect(cb.onAskUser).not.toHaveBeenCalled()
  })

  it('allows explicit user confirmation when no deterministic verifier is configured', async () => {
    const state = createLoopState()
    const goal = createGoal(state, { objective: 'verify', requiresUserConfirmation: true })
    const cb = callbacks()

    const result = await runVerifierLadder({ goal, state, options: options(), callbacks: cb, model: {} as any })

    expect(result.ok).toBe(true)
    expect(cb.onAskUser).toHaveBeenCalled()
  })
})
