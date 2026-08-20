import { createUsageBreakdown, scanCacheMisses } from '@x-code-cli/core'
import type { EditDiffPayload } from '@x-code-cli/core'

import { createGoalToolLifecycleCallbacks, createToolLifecycleCallbacks } from '../src/ui/agent/agent-tool-lifecycle.js'
import type { AgentState } from '../src/ui/agent/types.js'

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    messages: [],
    isLoading: true,
    activeToolCalls: [],
    shellOutput: '',
    permissionQueue: [],
    pendingQuestion: null,
    queuedMessages: [],
    restoredDraft: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      currentContextTokens: 0,
    },
    usageBreakdown: createUsageBreakdown(),
    cacheMissSummary: scanCacheMisses([]),
    error: null,
    modelId: 'test:model',
    permissionMode: 'default',
    todos: [],
    bufferingReads: false,
    compressionLabel: null,
    reconnectLabel: null,
    goalStatus: null,
    goalRunnerActive: false,
    goalVerificationActive: false,
    stepStats: [],
    backgroundTerminals: [],
    shellWaitStreak: null,
    ...overrides,
  }
}

function setup(initial = makeState()) {
  let state = initial
  const pendingToolsRef = { current: new Map() }
  const pendingEditDiffsRef = { current: new Map<string, EditDiffPayload>() }
  const flushBuffer = vi.fn()
  let now = 1000
  const callbacks = createToolLifecycleCallbacks({
    setState: (update) => {
      state = typeof update === 'function' ? update(state) : update
    },
    flushBuffer,
    pendingToolsRef,
    pendingEditDiffsRef,
    now: () => now,
  })

  return {
    callbacks,
    flushBuffer,
    pendingToolsRef,
    pendingEditDiffsRef,
    getState: () => state,
    setNow: (value: number) => {
      now = value
    },
  }
}

describe('createToolLifecycleCallbacks', () => {
  it('tracks read tools, progress, edit payloads, and completed results consistently', () => {
    const test = setup()

    test.callbacks.onToolCall('read-1', 'readFile', { filePath: 'a.ts' })
    expect(test.flushBuffer).toHaveBeenCalledOnce()
    expect(test.getState().bufferingReads).toBe(true)
    expect(test.getState().activeToolCalls).toEqual([
      { id: 'read-1', toolName: 'readFile', input: { filePath: 'a.ts' } },
    ])

    test.callbacks.onToolProgress('read-1', 'Reading a.ts')
    expect(test.getState().activeToolCalls[0]?.progress).toBe('Reading a.ts')
    test.callbacks.onShellOutput?.('first')
    test.callbacks.onShellOutput?.(' second')
    expect(test.getState().shellOutput).toBe('first second')

    const editPayload: EditDiffPayload = {
      filePath: 'a.ts',
      hunks: [],
      additions: 1,
      removals: 1,
      isCreate: false,
    }
    test.callbacks.onFileEdit?.('read-1', editPayload)
    test.setNow(1250)
    test.callbacks.onToolResult('read-1', 'done')

    expect(test.getState().activeToolCalls).toEqual([])
    expect(test.getState().shellOutput).toBe('')
    expect(test.getState().messages[0]?.toolCalls?.[0]).toMatchObject({
      toolName: 'readFile',
      output: 'done',
      status: 'completed',
      durationMs: 250,
      editPayload,
    })
    expect(test.pendingToolsRef.current.size).toBe(0)
    expect(test.pendingEditDiffsRef.current.size).toBe(0)
  })

  it('keeps toolSearch out of live state and scrollback', () => {
    const test = setup()

    test.callbacks.onToolCall('search-1', 'toolSearch', { query: 'browser' })
    expect(test.getState().activeToolCalls).toEqual([])
    expect(test.pendingToolsRef.current.has('search-1')).toBe(true)

    test.callbacks.onToolResult('search-1', 'loaded')
    expect(test.getState().messages).toEqual([])
    expect(test.pendingToolsRef.current.size).toBe(0)
  })

  it('keeps passive shellOutput waits out of generic tool rows and scrollback', () => {
    const test = setup()

    test.callbacks.onToolCall('wait-1', 'shellOutput', { shellId: 'bg_1', chars: '' })
    expect(test.getState().activeToolCalls).toEqual([])
    expect(test.pendingToolsRef.current.has('wait-1')).toBe(true)

    test.callbacks.onToolResult('wait-1', '[shell bg_1 running]')
    expect(test.getState().messages).toEqual([])
    expect(test.pendingToolsRef.current.size).toBe(0)
  })

  it('keeps PTY input and resize visible as mutating shellOutput tool rows', () => {
    const test = setup()

    test.callbacks.onToolCall('input-1', 'shellOutput', {
      shellId: 'bg_1',
      chars: 'status\r',
      cols: 100,
      rows: 35,
    })

    expect(test.getState().activeToolCalls).toEqual([
      expect.objectContaining({ id: 'input-1', toolName: 'shellOutput' }),
    ])
  })

  it('breaks a read chain when a non-collapsible tool starts', () => {
    const test = setup(makeState({ bufferingReads: true }))

    test.callbacks.onToolCall('shell-1', 'shell', { command: 'pnpm test' })

    expect(test.getState().bufferingReads).toBe(false)
    expect(test.getState().activeToolCalls[0]?.toolName).toBe('shell')
  })

  it('projects sub-agent tool history and completion statistics into the parent tool row', () => {
    const test = setup(
      makeState({
        activeToolCalls: [{ id: 'task-1', toolName: 'task', input: { description: 'inspect' } }],
      }),
    )

    test.callbacks.onSubAgentEvent?.({
      kind: 'tool-call',
      toolCallId: 'task-1',
      subToolName: 'grep',
      subInput: { pattern: 'TODO' },
    })
    expect(test.getState().activeToolCalls[0]?.subToolHistory).toEqual(['grep: TODO'])

    test.callbacks.onSubAgentEvent?.({
      kind: 'end',
      toolCallId: 'task-1',
      finalText: 'done',
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        currentContextTokens: 1500,
      },
      turnCount: 3,
      durationMs: 2400,
      aborted: false,
    })
    expect(test.getState().activeToolCalls[0]?.progress).toBe('Done (3t, 1.5k tok, 2.4s)')
  })
})

describe('createGoalToolLifecycleCallbacks', () => {
  it('preserves the goal runner tool-row behavior without adding normal-mode projections', () => {
    let state = makeState({ bufferingReads: true })
    const pendingToolsRef = { current: new Map() }
    const callbacks = createGoalToolLifecycleCallbacks({
      setState: (update) => {
        state = typeof update === 'function' ? update(state) : update
      },
      flushBuffer: vi.fn(),
      pendingToolsRef,
      now: () => 1000,
    })

    callbacks.onToolCall('search-1', 'toolSearch', { query: 'browser' })

    expect(state.activeToolCalls).toEqual([{ id: 'search-1', toolName: 'toolSearch', input: { query: 'browser' } }])
    expect(state.bufferingReads).toBe(true)
    expect(callbacks).not.toHaveProperty('onFileEdit')
    expect(callbacks).not.toHaveProperty('onSubAgentEvent')
  })
})
