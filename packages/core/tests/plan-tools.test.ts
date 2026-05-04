// Tests for agent/plan-tools.ts (handleTodoWrite / handleEnterPlanMode / handleExitPlanMode)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createLoopState } from '../src/agent/loop-state.js'
import { handleEnterPlanMode, handleExitPlanMode, handleTodoWrite } from '../src/agent/plan-tools.js'
import type { AgentCallbacks, AgentOptions, TodoItem } from '../src/types/index.js'

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
    onTodosUpdate: vi.fn(),
    onShellOutput: vi.fn(),
    onUsageUpdate: vi.fn(),
    onContextCompressed: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  }
}

function makeOptions(overrides: Partial<AgentOptions> = {}): AgentOptions {
  return {
    modelId: 'test:model',
    trustMode: false,
    maxTurns: 10,
    printMode: false,
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

describe('handleTodoWrite', () => {
  it('normalizes todos and notifies the UI', async () => {
    const state = createLoopState()
    const callbacks = makeCallbacks()
    const todos: TodoItem[] = [
      { content: 'Step A', activeForm: 'Doing A', status: 'in_progress' },
      { content: 'Step B', activeForm: 'Doing B', status: 'pending' },
    ]
    await handleTodoWrite({ todos }, 'tc1', state, callbacks, recordPushToolResult)
    expect(state.todos).toEqual(todos)
    expect(callbacks.onTodosUpdate).toHaveBeenCalledWith(todos)
    expect(captured[0].output).toContain('Todo list updated')
    expect(captured[0].isError).toBe(false)
  })

  it('clears the list when every todo is completed', async () => {
    const state = createLoopState()
    state.todos = [{ content: 'old', activeForm: 'old', status: 'in_progress' }]
    const callbacks = makeCallbacks()
    const todos = [
      { content: 'Build', activeForm: 'Building', status: 'completed' },
      { content: 'Ship', activeForm: 'Shipping', status: 'completed' },
    ]
    await handleTodoWrite({ todos }, 'tc1', state, callbacks, recordPushToolResult)
    expect(state.todos).toEqual([])
    expect(callbacks.onTodosUpdate).toHaveBeenCalledWith([])
    expect(captured[0].output).toContain('All todos completed')
  })

  it('drops entries with neither content nor activeForm and reports the count', async () => {
    const state = createLoopState()
    const callbacks = makeCallbacks()
    const todos = [
      { content: 'good', activeForm: 'good', status: 'pending' },
      { content: '', activeForm: '', status: 'pending' },
      { status: 'pending' },
    ]
    await handleTodoWrite({ todos }, 'tc1', state, callbacks, recordPushToolResult)
    expect(state.todos).toHaveLength(1)
    expect(captured[0].output).toMatch(/2 entries were dropped/)
  })

  it('falls back to activeForm when only one of the two text fields is provided', async () => {
    const state = createLoopState()
    const callbacks = makeCallbacks()
    const todos = [{ activeForm: 'Doing thing', status: 'pending' }]
    await handleTodoWrite({ todos }, 'tc1', state, callbacks, recordPushToolResult)
    expect(state.todos[0]).toEqual({
      content: 'Doing thing',
      activeForm: 'Doing thing',
      status: 'pending',
    })
  })

  it('appends a verify-your-work nudge when wrapping up a multi-step list with no test/lint task', async () => {
    const state = createLoopState()
    const callbacks = makeCallbacks()
    const todos = [
      { content: 'Refactor module', activeForm: 'Refactoring', status: 'completed' },
      { content: 'Update callers', activeForm: 'Updating', status: 'completed' },
      { content: 'Document changes', activeForm: 'Documenting', status: 'completed' },
    ]
    await handleTodoWrite({ todos }, 'tc1', state, callbacks, recordPushToolResult)
    expect(captured[0].output).toMatch(/verify your work/i)
  })

  it('skips the verify nudge when the list already has a test/lint/build task', async () => {
    const state = createLoopState()
    const callbacks = makeCallbacks()
    const todos = [
      { content: 'Refactor module', activeForm: 'Refactoring', status: 'completed' },
      { content: 'Update callers', activeForm: 'Updating', status: 'completed' },
      { content: 'Run test suite', activeForm: 'Running tests', status: 'completed' },
    ]
    await handleTodoWrite({ todos }, 'tc1', state, callbacks, recordPushToolResult)
    expect(captured[0].output).not.toMatch(/verify your work/i)
  })

  it('defaults missing status to "pending"', async () => {
    const state = createLoopState()
    const callbacks = makeCallbacks()
    const todos = [{ content: 'Do thing', activeForm: 'Doing thing' }]
    await handleTodoWrite({ todos }, 'tc1', state, callbacks, recordPushToolResult)
    expect(state.todos[0].status).toBe('pending')
  })
})

describe('handleEnterPlanMode', () => {
  it('flips permissionMode and clears the system prompt cache when approved', async () => {
    const state = createLoopState('default')
    state.systemPromptCache = 'cached'
    const callbacks = makeCallbacks({ onAskPermission: vi.fn().mockResolvedValue('yes') })
    await handleEnterPlanMode({}, 'tc1', state, makeOptions(), callbacks, recordPushToolResult)
    expect(state.permissionMode).toBe('plan')
    expect(state.systemPromptCache).toBeNull()
    expect(state.currentPlanPath).toBeTruthy()
    expect(callbacks.onPlanModeChange).toHaveBeenCalledWith('plan')
    expect(captured[0].output).toContain('Entered plan mode')
  })

  it('returns a no-op result when already in plan mode', async () => {
    const state = createLoopState('plan')
    const callbacks = makeCallbacks()
    await handleEnterPlanMode({}, 'tc1', state, makeOptions(), callbacks, recordPushToolResult)
    expect(callbacks.onAskPermission).not.toHaveBeenCalled()
    expect(state.permissionMode).toBe('plan')
    expect(captured[0].output).toContain('Already in plan mode')
  })

  it('declines cleanly when the user rejects the permission prompt', async () => {
    const state = createLoopState('default')
    const callbacks = makeCallbacks({ onAskPermission: vi.fn().mockResolvedValue('no') })
    await handleEnterPlanMode({}, 'tc1', state, makeOptions(), callbacks, recordPushToolResult)
    expect(state.permissionMode).toBe('default')
    expect(callbacks.onPlanModeChange).not.toHaveBeenCalled()
    expect(captured[0].isError).toBe(true)
    expect(captured[0].output).toContain('User declined')
  })

  it('reports interruption when the abort signal fires after permission resolves', async () => {
    const state = createLoopState('default')
    const ac = new AbortController()
    const callbacks = makeCallbacks({
      onAskPermission: vi.fn().mockImplementation(async () => {
        ac.abort()
        return 'yes'
      }),
    })
    await handleEnterPlanMode(
      {},
      'tc1',
      state,
      makeOptions({ abortSignal: ac.signal }),
      callbacks,
      recordPushToolResult,
    )
    expect(state.permissionMode).toBe('default')
    expect(captured[0].output).toContain('interrupted')
    expect(captured[0].isError).toBe(true)
  })
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
