// Tests for agent/plan-tools.ts (handleExitPlanMode)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createLoopState } from '../src/agent/loop-state.js'
import { handleExitPlanMode } from '../src/agent/plan-tools.js'
import type { AgentCallbacks } from '../src/types/index.js'

function makeCallbacks(overrides: Partial<AgentCallbacks> = {}): AgentCallbacks {
  return {
    onTextDelta: vi.fn(),
    onToolCall: vi.fn(),
    onToolProgress: vi.fn(),
    onToolResult: vi.fn(),
    onAskPermission: vi.fn().mockResolvedValue('yes'),
    onAskUser: vi.fn().mockResolvedValue('option1'),
    onPlanApprovalRequest: vi.fn().mockResolvedValue(true),
    onPlanModeChange: vi.fn(),
    onShellOutput: vi.fn(),
    onUsageUpdate: vi.fn(),
    onContextCompressed: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  }
}

const captured: Array<{ toolName: string; output: string; isError: boolean }> = []
function recordPushToolResult(
  _state: unknown,
  _callbacks: unknown,
  _toolCallId: string,
  toolName: string,
  output: string,
  isError = false,
): void {
  captured.push({ toolName, output, isError })
}

let tmpHome: string

beforeEach(async () => {
  tmpHome = path.join(os.tmpdir(), 'x-code-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
  await fs.mkdir(tmpHome, { recursive: true })
  process.env.X_CODE_HOME = tmpHome
  captured.length = 0
})

afterEach(async () => {
  delete process.env.X_CODE_HOME
  await fs.rm(tmpHome, { recursive: true, force: true })
})

describe('handleExitPlanMode', () => {
  it('rejects the call when not currently in plan mode', async () => {
    const state = createLoopState('default')
    const callbacks = makeCallbacks()
    await handleExitPlanMode({ plan: 'something' }, 'tc1', state, callbacks, recordPushToolResult)
    expect(captured[0].isError).toBe(true)
    expect(captured[0].output).toContain('not in plan mode')
  })

  it('errors when the plan body is empty', async () => {
    const state = createLoopState('plan')
    state.currentPlanPath = path.join(tmpHome, 'plan.md')
    const callbacks = makeCallbacks()
    await handleExitPlanMode({}, 'tc1', state, callbacks, recordPushToolResult)
    expect(captured[0].isError).toBe(true)
    expect(captured[0].output).toContain('empty')
    expect(state.permissionMode).toBe('plan')
  })

  it('switches to acceptEdits and emits a plan-approved result on user approval', async () => {
    const state = createLoopState('plan')
    state.systemPromptCache = 'cached'
    const planPath = path.join(tmpHome, 'plan-test.md')
    state.currentPlanPath = planPath
    const callbacks = makeCallbacks({
      onPlanApprovalRequest: vi.fn().mockResolvedValue(true),
    })
    await handleExitPlanMode({ plan: 'My plan body' }, 'tc1', state, callbacks, recordPushToolResult)

    expect(state.permissionMode).toBe('acceptEdits')
    expect(state.systemPromptCache).toBeNull()
    expect(state.currentPlanPath).toBeNull()
    expect(callbacks.onPlanModeChange).toHaveBeenCalledWith('acceptEdits')
    expect(captured[0].output).toContain('Plan approved')
    expect(captured[0].output).not.toContain('todoWrite')

    // The override body was persisted to disk.
    const written = await fs.readFile(planPath, 'utf-8')
    expect(written).toBe('My plan body')

    // A follow-up user message is appended so the model knows the gate flipped.
    const lastMsg = state.messages[state.messages.length - 1]
    expect(lastMsg.role).toBe('user')
  })

  it('stays in plan mode and pushes an errored result when user rejects', async () => {
    const state = createLoopState('plan')
    state.currentPlanPath = path.join(tmpHome, 'plan-rej.md')
    const callbacks = makeCallbacks({
      onPlanApprovalRequest: vi.fn().mockResolvedValue(false),
    })
    await handleExitPlanMode({ plan: 'rejected plan' }, 'tc1', state, callbacks, recordPushToolResult)
    expect(state.permissionMode).toBe('plan')
    expect(captured[0].isError).toBe(true)
    expect(captured[0].output).toContain('Plan rejected')
  })
})
