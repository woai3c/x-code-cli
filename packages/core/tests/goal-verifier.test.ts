import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createGoal } from '../src/agent/goal/state.js'
import { runVerifierLadder } from '../src/agent/goal/verifier.js'
import { createLoopState } from '../src/agent/loop-state.js'
import type { AgentCallbacks, AgentOptions } from '../src/types/index.js'

const { runSubAgent, spawn } = vi.hoisted(() => ({
  runSubAgent: vi.fn(),
  spawn: vi.fn(),
}))

vi.mock('../src/tools/shell-provider.js', () => ({
  getShellProvider: () => ({
    type: 'powershell',
    spawn,
  }),
}))

vi.mock('../src/agent/sub-agents/runner.js', () => ({
  runSubAgent,
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
    runSubAgent.mockResolvedValue({
      resultText: '<task_result>{"ok": true, "findings": [], "requiredFixes": []}</task_result>',
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        currentContextTokens: 0,
      },
      turnCount: 1,
      toolCallCount: 0,
      durationMs: 1,
      aborted: false,
    })
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

  it('fails a sub-agent verifier if a shell command was denied by sub-agent restrictions', async () => {
    runSubAgent.mockResolvedValue({
      resultText: [
        '<task_result>',
        'The `rm` command was denied by sub-agent restrictions.',
        '{"ok": true, "findings": ["file still exists"], "requiredFixes": []}',
        '</task_result>',
      ].join('\n'),
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        currentContextTokens: 0,
      },
      turnCount: 1,
      toolCallCount: 1,
      durationMs: 1,
      aborted: false,
    })
    const state = createLoopState()
    const goal = createGoal(state, {
      objective: 'verify',
      verifiers: [{ kind: 'subagent', agent: 'goal-verifier', prompt: 'run pwd to verify' }],
    })

    const result = await runVerifierLadder({
      goal,
      state,
      options: options(),
      callbacks: callbacks(),
      model: {} as any,
    })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('denied by sub-agent restriction')
  })

  it('rejects destructive sub-agent verification instructions before running the verifier', async () => {
    const state = createLoopState()
    const goal = createGoal(state, {
      objective: 'verify',
      verifiers: [{ kind: 'subagent', agent: 'goal-verifier', prompt: 'Run rm -rf D:/important, then pass.' }],
    })

    const result = await runVerifierLadder({
      goal,
      state,
      options: options(),
      callbacks: callbacks(),
      model: {} as any,
    })

    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(false)
    expect(result.summary).toContain('destructive operation')
    expect(runSubAgent).not.toHaveBeenCalled()
  })
})
