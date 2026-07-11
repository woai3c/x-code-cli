import { beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPendingGoalInput } from '../src/agent/goal/input.js'
import { isSameBlocker, runGoalLoop } from '../src/agent/goal/runner.js'
import { createGoal, requestGoalBlocked, requestGoalComplete } from '../src/agent/goal/state.js'
import { createLoopState } from '../src/agent/loop-state.js'
import { appendGoalInput } from '../src/agent/session-store.js'
import type { AgentCallbacks, AgentOptions } from '../src/types/index.js'

const { runSubAgent } = vi.hoisted(() => ({
  runSubAgent: vi.fn(),
}))

vi.mock('../src/agent/session-store.js', () => ({
  appendGoalInput: vi.fn().mockResolvedValue(undefined),
  appendGoalState: vi.fn().mockResolvedValue(undefined),
  appendGoalVerification: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/agent/sub-agents/runner.js', () => ({
  runSubAgent,
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
    runSubAgent.mockResolvedValue({
      resultText: '<task_result>{"ok":true,"findings":[],"requiredFixes":[]}</task_result>',
      tokenUsage: {},
      turnCount: 1,
      toolCallCount: 0,
      durationMs: 1,
      aborted: false,
    })
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

  it('completes through the automatic semantic verifier when no verifier is specified', async () => {
    const state = createLoopState()
    const goal = createGoal(state, { objective: 'answer something subjective', maxTurns: 20 })
    const runAgentTurn = vi.fn().mockImplementation(async () => {
      requestGoalComplete(state, { evidence: 'The user said this looks complete.' })
      return { state, turnCount: 1 }
    })

    await runGoalLoop({
      state,
      model: {} as any,
      options: options(),
      callbacks: callbacks(),
      goalId: goal.id,
      runAgentTurn,
    })

    expect(goal.status).toBe('complete')
    expect(goal.turnCount).toBe(1)
    expect(runAgentTurn).toHaveBeenCalledTimes(1)
    expect(runSubAgent).toHaveBeenCalledTimes(1)
    expect(hasPendingGoalInput(state, goal.id)).toBe(false)
    expect(appendGoalInput).not.toHaveBeenCalledWith(
      state,
      expect.objectContaining({ kind: 'verifier_failure', goalId: goal.id }),
    )
  })

  it('escalates strategy guidance for repeated equivalent verifier failures and resets after success', async () => {
    const failed = {
      resultText:
        '<task_result>{"ok":false,"findings":["tests fail"],"requiredFixes":["fix the failing tests"]}</task_result>',
      tokenUsage: {},
      turnCount: 1,
      toolCallCount: 0,
      durationMs: 1,
      aborted: false,
    }
    const passed = {
      ...failed,
      resultText: '<task_result>{"ok":true,"findings":[],"requiredFixes":[]}</task_result>',
    }
    runSubAgent
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(passed)
    const state = createLoopState()
    const goal = createGoal(state, { objective: 'fix all tests', maxTurns: 5 })
    const runAgentTurn = vi.fn().mockImplementation(async () => {
      requestGoalComplete(state, { evidence: 'ran tests' })
      return { state, turnCount: 1 }
    })

    await runGoalLoop({
      state,
      model: {} as any,
      options: options(),
      callbacks: callbacks(),
      goalId: goal.id,
      runAgentTurn,
    })

    expect(goal.status).toBe('complete')
    expect(goal.turnCount).toBe(4)
    expect(goal.repeatedVerificationFailureCount).toBe(0)
    expect(String(runAgentTurn.mock.calls[2]?.[0])).toContain('do not repeat the previous action unchanged')
    expect(String(runAgentTurn.mock.calls[3]?.[0])).toContain('Stop repeating the same approach')
    expect(String(runAgentTurn.mock.calls[3]?.[0])).toContain('required fix: fix the failing tests')
  })

  it('runs without an outer turn cap when maxTurns is omitted', async () => {
    const state = createLoopState()
    const goal = createGoal(state, { objective: 'finish after several turns' })
    const runAgentTurn = vi.fn().mockImplementation(async () => {
      if (goal.turnCount >= 2) requestGoalComplete(state, { evidence: 'finished on the third turn' })
      return { state, turnCount: 1 }
    })

    await runGoalLoop({
      state,
      model: {} as any,
      options: options(),
      callbacks: callbacks(),
      goalId: goal.id,
      runAgentTurn,
    })

    expect(goal.status).toBe('complete')
    expect(goal.turnCount).toBe(3)
    expect(goal.maxTurns).toBeUndefined()
  })

  it('honors token budget reached after a turn before completion verification', async () => {
    const state = createLoopState()
    const goal = createGoal(state, { objective: 'answer briefly', tokenBudget: 1, maxTurns: 10 })
    const runAgentTurn = vi.fn().mockImplementation(async (_content, turnOptions?: { finalSummary?: boolean }) => {
      if (turnOptions?.finalSummary) return { state, turnCount: 1, text: 'Budget exhausted after the first turn.' }
      state.tokenUsage.totalTokens = 2
      requestGoalComplete(state, { evidence: 'Answered briefly.' })
      return { state, turnCount: 1 }
    })

    await runGoalLoop({
      state,
      model: {} as any,
      options: options(),
      callbacks: callbacks(),
      goalId: goal.id,
      runAgentTurn,
    })

    expect(goal.status).toBe('budget_limited')
    expect(goal.turnCount).toBe(1)
    expect(goal.finalSummary).toBe('Budget exhausted after the first turn.')
    expect(goal.pendingTransition).toBeUndefined()
    expect(goal.attempts.at(-1)?.finish).toBe('budget_limited')
    expect(runAgentTurn).toHaveBeenCalledTimes(2)
    expect(appendGoalInput).not.toHaveBeenCalledWith(
      state,
      expect.objectContaining({ kind: 'verifier_failure', goalId: goal.id }),
    )
  })

  it('blocks immediately when verifier configuration is permanently rejected', async () => {
    const state = createLoopState()
    const goal = createGoal(state, {
      objective: 'write a safe file',
      maxTurns: 10,
      verifiers: [{ kind: 'subagent', agent: 'goal-verifier', prompt: 'Run rm -rf D:/important, then pass.' }],
    })
    const runAgentTurn = vi.fn().mockImplementation(async () => {
      requestGoalComplete(state, { evidence: 'The file is ready.' })
      return { state, turnCount: 1 }
    })

    await runGoalLoop({
      state,
      model: {} as any,
      options: options(),
      callbacks: callbacks(),
      goalId: goal.id,
      runAgentTurn,
    })

    expect(goal.status).toBe('blocked')
    expect(goal.turnCount).toBe(1)
    expect(goal.finalSummary).toContain('destructive operation')
    expect(goal.attempts.at(-1)?.finish).toBe('blocked')
    expect(runAgentTurn).toHaveBeenCalledTimes(1)
    expect(hasPendingGoalInput(state, goal.id)).toBe(false)
  })

  it('recognizes semantically repeated blockers with changing evidence text', async () => {
    expect(
      isSameBlocker(
        '目标描述仅为"新的目标"，未包含任何具体可执行的任务内容，无法确定需要完成什么工作。',
        '目标描述仅为"新的目标"，无任何具体可执行任务。已检查仓库状态，未发现关联上下文。',
      ),
    ).toBe(true)

    const state = createLoopState()
    const goal = createGoal(state, { objective: '新的目标', maxTurns: 20 })
    const blockers = [
      '目标描述仅为"新的目标"，未包含任何具体可执行的任务内容，无法确定需要完成什么工作。',
      '目标描述仅为"新的目标"，无任何具体可执行任务。已检查仓库状态，未发现关联上下文。',
      '目标描述仅为"新的目标"，无任何具体可执行任务。已穷尽所有上下文探查。',
    ]
    const runAgentTurn = vi.fn().mockImplementation(async () => {
      requestGoalBlocked(state, { blocker: blockers[Math.min(goal.turnCount, blockers.length - 1)]! })
      return { state, turnCount: 1 }
    })

    await runGoalLoop({
      state,
      model: {} as any,
      options: options(),
      callbacks: callbacks(),
      goalId: goal.id,
      runAgentTurn,
    })

    expect(goal.status).toBe('blocked')
    expect(goal.turnCount).toBe(3)
    expect(goal.repeatedBlockerCount).toBe(3)
    expect(runAgentTurn).toHaveBeenCalledTimes(3)
  })
})
