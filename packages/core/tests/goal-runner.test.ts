import { beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPendingGoalInput } from '../src/agent/goal/input.js'
import { runGoalLoop } from '../src/agent/goal/runner.js'
import { createGoal } from '../src/agent/goal/state.js'
import { createLoopState } from '../src/agent/loop-state.js'
import { appendGoalInput } from '../src/agent/session-store.js'
import type { AgentCallbacks, AgentOptions } from '../src/types/index.js'

vi.mock('../src/agent/session-store.js', () => ({
  appendGoalInput: vi.fn().mockResolvedValue(undefined),
  appendGoalState: vi.fn().mockResolvedValue(undefined),
  appendGoalVerification: vi.fn().mockResolvedValue(undefined),
}))

function callbacks(): AgentCallbacks {
  return {
    onTextDelta: vi.fn(),
    onToolCall: vi.fn(),
    onToolProgress: vi.fn(),
    onToolResult: vi.fn(),
    onAskPermission: vi.fn().mockResolvedValue('yes'),
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

function options(signal?: AbortSignal): AgentOptions {
  return {
    modelId: 'test:model',
    trustMode: false,
    printMode: false,
    abortSignal: signal,
  }
}

describe('goal runner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('persists the initial goal input before promotion', async () => {
    const state = createLoopState()
    const goal = createGoal(state, { objective: 'finish safely', maxTurns: 1 })

    await runGoalLoop({
      state,
      model: {} as any,
      options: options(),
      callbacks: callbacks(),
      goalId: goal.id,
      runAgentTurn: vi.fn().mockResolvedValue({ state, turnCount: 1 }),
    })

    expect(appendGoalInput).toHaveBeenCalledWith(state, expect.objectContaining({ kind: 'initial', goalId: goal.id }))
    expect(appendGoalInput).toHaveBeenCalledWith(
      state,
      expect.objectContaining({ kind: 'initial', goalId: goal.id, promotedAt: expect.any(String) }),
    )
  })

  it('does not admit a continuation after the goal is paused mid-turn', async () => {
    const state = createLoopState()
    const controller = new AbortController()
    const goal = createGoal(state, { objective: 'stop cleanly', maxTurns: 5 })

    await runGoalLoop({
      state,
      model: {} as any,
      options: options(controller.signal),
      callbacks: callbacks(),
      goalId: goal.id,
      signal: controller.signal,
      runAgentTurn: vi.fn().mockImplementation(async () => {
        goal.status = 'paused'
        controller.abort()
        return { state, turnCount: 1 }
      }),
    })

    expect(goal.status).toBe('paused')
    expect(hasPendingGoalInput(state, goal.id)).toBe(false)
    expect(state.goalInputs).toHaveLength(1)
  })
})
