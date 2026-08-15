import type { ModelMessage } from 'ai'

import { createLoopState } from '../src/agent/loop-state.js'
import { processToolCalls } from '../src/agent/tool-execution.js'
import { HookBus, type ToolHookSnapshot } from '../src/hooks/bus.js'
import { HookRegistry } from '../src/hooks/registry.js'
import type {
  ManagedProcess,
  ManagedProcessFrame,
  ManagedShellProvider,
  ManagedShellSpawnOptions,
  ManagedSpawnAttempt,
  SpawnReadyResult,
} from '../src/tools/shell-session/provider.js'
import type {
  ProcessTerminationResult,
  TerminationBudget,
  TerminationReason,
} from '../src/tools/shell-session/types.js'
import type { AgentCallbacks, AgentOptions, LanguageModel } from '../src/types/index.js'

const CONFIRMED_TERMINATION: ProcessTerminationResult = {
  gracefulAttempted: true,
  forceAttempted: false,
  rootExited: true,
  treeConfirmedExited: true,
  exitCode: 0,
}

class FakeProcess implements ManagedProcess {
  readonly rootPid = 4321
  terminationCalls: TerminationReason[] = []
  writes: string[] = []
  resizes: Array<{ cols: number; rows: number }> = []

  constructor(private readonly finish: () => void) {}

  async write(chars: string): Promise<void> {
    this.writes.push(chars)
  }

  async resize(cols: number, rows: number): Promise<void> {
    this.resizes.push({ cols, rows })
  }

  waitForRootExit(): Promise<{ exitCode: number }> {
    return new Promise(() => {})
  }

  waitForTreeExit(): Promise<void> {
    return new Promise(() => {})
  }

  async probeTree(): Promise<'live' | 'confirmed-exited'> {
    return this.terminationCalls.length > 0 ? 'confirmed-exited' : 'live'
  }

  async terminateTree(reason: TerminationReason, _budget: TerminationBudget): Promise<ProcessTerminationResult> {
    this.terminationCalls.push(reason)
    await new Promise<void>((resolve) => setImmediate(resolve))
    this.finish()
    return CONFIRMED_TERMINATION
  }

  forceTreeSync(): 'force-sent-unconfirmed' {
    return 'force-sent-unconfirmed'
  }
}

class FakeAttempt implements ManagedSpawnAttempt {
  readonly ready: Promise<SpawnReadyResult> = Promise.resolve({ rootPid: 4321, treeKind: 'windows-job-object' })
  readonly handle: FakeProcess
  private listener?: (frame: ManagedProcessFrame) => void
  private completed = false

  constructor() {
    this.handle = new FakeProcess(() => this.complete())
  }

  activate(listener: (frame: ManagedProcessFrame) => void): void {
    this.listener = listener
  }

  discardBufferedFrames(): ManagedProcessFrame[] {
    return []
  }

  async cancelBeforeReady(): Promise<ProcessTerminationResult> {
    this.complete()
    return CONFIRMED_TERMINATION
  }

  complete(output = 'done\n'): void {
    if (this.completed) return
    this.completed = true
    this.listener?.({ kind: 'output', stream: 'stdout', chunk: Buffer.from(output) })
    this.listener?.({ kind: 'stream-end', stream: 'stdout' })
    this.listener?.({ kind: 'stream-end', stream: 'stderr' })
    this.listener?.({ kind: 'root-exit', exitCode: 0 })
    this.listener?.({ kind: 'tree-exit' })
  }
}

class FakeProvider implements ManagedShellProvider {
  readonly attempts: FakeAttempt[] = []
  readonly spawnOptions: ManagedShellSpawnOptions[] = []

  spawnManaged(_command: string, options: ManagedShellSpawnOptions): ManagedSpawnAttempt {
    const attempt = new FakeAttempt()
    this.attempts.push(attempt)
    this.spawnOptions.push(options)
    return attempt
  }
}

function makeCallbacks(overrides: Partial<AgentCallbacks> = {}): AgentCallbacks {
  return {
    onTextDelta: vi.fn(),
    onToolCall: vi.fn(),
    onToolProgress: vi.fn(),
    onToolResult: vi.fn(),
    onFileEdit: vi.fn(),
    onAskPermission: vi.fn().mockResolvedValue('yes'),
    onAskUser: vi.fn().mockResolvedValue('answer'),
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

function snapshot(generation: number): ToolHookSnapshot {
  return Object.freeze({
    generation,
    toolName: 'shell',
    preHooks: Object.freeze([{} as never]),
    postHooks: Object.freeze([{} as never]),
  })
}

function resultPart(state: ReturnType<typeof createLoopState>, toolCallId: string) {
  for (const message of state.messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue
    const part = (message.content as Array<Record<string, unknown>>).find(
      (entry) => entry.type === 'tool-result' && entry.toolCallId === toolCallId,
    )
    if (part) return part
  }
  return undefined
}

const stubModel = {} as LanguageModel

describe('PTY shell tool transport', () => {
  it('enables tty launches and forwards terminal input and resize through shellOutput', async () => {
    const provider = new FakeProvider()
    const state = createLoopState('default', { projectCwd: process.cwd(), shellProvider: provider })
    const options: AgentOptions = { modelId: 'test-model', trustMode: true, printMode: false }
    const callbacks = makeCallbacks()

    await processToolCalls(
      [
        {
          toolName: 'shell',
          toolCallId: 'call-pty',
          input: { command: 'interactive-command', tty: true, runInBackground: true },
        },
      ],
      state,
      options,
      callbacks,
      stubModel,
    )
    const shellId = state.shellSessions.list()[0]!.shellId

    await processToolCalls(
      [
        {
          toolName: 'shellOutput',
          toolCallId: 'call-pty-input',
          input: { shellId, chars: '你好\r', cols: 100, rows: 35, block: false },
        },
      ],
      state,
      options,
      callbacks,
      stubModel,
    )

    expect(provider.spawnOptions[0]?.tty).toBe(true)
    expect(provider.attempts[0]!.handle.resizes).toEqual([{ cols: 100, rows: 35 }])
    expect(provider.attempts[0]!.handle.writes).toEqual(['你好\r'])
    await state.shellSessions.dispose('manager-dispose', { gracefulMs: 5, forceMs: 5, confirmMs: 5 })
  })

  it('requires peer authority for both passive reads and terminal mutations', async () => {
    const provider = new FakeProvider()
    const state = createLoopState('default', { projectCwd: process.cwd(), shellProvider: provider })
    const options: AgentOptions = { modelId: 'test-model', trustMode: true, printMode: false }
    const onAskAuthority = vi.fn(async (request: Parameters<NonNullable<AgentCallbacks['onAskAuthority']>>[0]) => ({
      decision: request.toolCallId === 'call-peer-write' ? ('deny' as const) : ('allow-once' as const),
      viewedComplete: true,
      canonicalPayloadSha256: request.preview.outboundPayload?.sha256,
      canonicalCallSha256: request.preview.canonicalCallSha256,
      authorityHash: request.preview.authorityHash,
    }))
    const callbacks = makeCallbacks({ onAskAuthority })

    await processToolCalls(
      [
        {
          toolName: 'shell',
          toolCallId: 'call-peer-shell',
          input: { command: 'interactive-command', tty: true, runInBackground: true },
        },
      ],
      state,
      options,
      callbacks,
      stubModel,
    )
    const shellId = state.shellSessions.list()[0]!.shellId
    state.executionAuthority = { source: 'peer', peerTainted: true }

    await processToolCalls(
      [
        {
          toolName: 'shellOutput',
          toolCallId: 'call-peer-read',
          input: { shellId, chars: '', block: false },
        },
      ],
      state,
      { ...options, trustMode: false },
      callbacks,
      stubModel,
    )
    await processToolCalls(
      [
        {
          toolName: 'shellOutput',
          toolCallId: 'call-peer-write',
          input: { shellId, chars: 'unsafe input', block: false },
        },
      ],
      state,
      { ...options, trustMode: false },
      callbacks,
      stubModel,
    )

    expect(onAskAuthority.mock.calls.map(([request]) => request.toolCallId)).toEqual([
      'call-peer-read',
      'call-peer-write',
    ])
    expect(provider.attempts[0]!.handle.writes).toEqual([])
    expect(resultPart(state, 'call-peer-read')?.output).toMatchObject({ type: 'text' })
    expect(resultPart(state, 'call-peer-write')?.output).toMatchObject({ type: 'error-text' })
    await state.shellSessions.dispose('manager-dispose', { gracefulMs: 5, forceMs: 5, confirmMs: 5 })
  })
})

describe.each(['shellOutput', 'killShell'] as const)('%s shell transport hooks', (transportTool) => {
  it('commits the original shell Post hook from its launch snapshot exactly once', async () => {
    const provider = new FakeProvider()
    const state = createLoopState('default', { projectCwd: process.cwd(), shellProvider: provider })
    const oldSnapshot = snapshot(4)
    const refreshedSnapshot = snapshot(5)
    let currentSnapshot = oldSnapshot
    const hookBus = new HookBus(new HookRegistry())
    const capture = vi.spyOn(hookBus, 'captureToolSnapshot').mockImplementation(() => currentSnapshot)
    const emitCurrent = vi.spyOn(hookBus, 'emit')
    const emitSnapshot = vi.spyOn(hookBus, 'emitToolSnapshot').mockImplementation(async (captured, phase, event) => {
      if (phase === 'pre') {
        return [
          {
            decision: 'modify',
            args: { ...(event.tool.args as Record<string, unknown>), command: 'hook-modified-command' },
          },
        ]
      }
      expect(captured).toBe(oldSnapshot)
      return [{ decision: 'modify', output: 'post-processed-output' }]
    })
    const options: AgentOptions = {
      modelId: 'launch-model',
      trustMode: true,
      printMode: false,
      hookBus,
    }
    const observerCallId = `call-${transportTool}`
    const onToolResult = vi.fn((toolCallId: string) => {
      if (toolCallId !== observerCallId) return
      expect(resultPart(state, observerCallId)).toBeDefined()
      expect(state.shellSessions.list()).toEqual([])
      throw new Error('renderer callback failed after transcript commit')
    })
    const callbacks = makeCallbacks({ onToolResult })

    await processToolCalls(
      [
        {
          toolName: 'shell',
          toolCallId: 'call-shell',
          input: { command: 'original-command', runInBackground: true },
        },
      ],
      state,
      options,
      callbacks,
      stubModel,
    )
    const shellId = state.shellSessions.list()[0]!.shellId
    currentSnapshot = refreshedSnapshot
    if (transportTool === 'shellOutput') provider.attempts[0]!.complete()

    await processToolCalls(
      [
        {
          toolName: transportTool,
          toolCallId: observerCallId,
          input: { shellId, block: false, ...(transportTool === 'shellOutput' ? { maxOutputTokens: 1 } : {}) },
        },
      ],
      state,
      { ...options, modelId: 'observer-model' },
      callbacks,
      stubModel,
    )

    const observerResult = resultPart(state, observerCallId)
    expect(observerResult?.toolName).toBe(transportTool)
    expect(observerResult?.output).toEqual({ type: 'text', value: 'post-processed-output' })
    expect(state.shellSessions.list()).toEqual([])
    expect(onToolResult).toHaveBeenCalledWith(observerCallId, 'post-processed-output', false)

    await processToolCalls(
      [{ toolName: transportTool, toolCallId: 'call-repeat', input: { shellId, block: false } }],
      state,
      options,
      callbacks,
      stubModel,
    )

    const postCalls = emitSnapshot.mock.calls.filter((call) => call[1] === 'post')
    expect(postCalls).toHaveLength(1)
    const postEvent = postCalls[0]![2]
    expect(postEvent.session).toEqual({ cwd: process.cwd(), modelId: 'launch-model' })
    expect(postEvent.tool).toMatchObject({
      name: 'shell',
      callId: 'call-shell',
      args: { command: 'hook-modified-command', cwd: process.cwd(), runInBackground: true },
      output: 'done\n',
      isError: false,
    })
    expect(capture).toHaveBeenCalledTimes(1)
    expect(emitCurrent).not.toHaveBeenCalled()
    expect(resultPart(state, 'call-repeat')?.output).toMatchObject({ type: 'error-text' })

    await processToolCalls(
      [
        {
          toolName: 'shell',
          toolCallId: 'call-shell-after-refresh',
          input: { command: 'next-command', runInBackground: true },
        },
      ],
      state,
      options,
      callbacks,
      stubModel,
    )
    expect(capture).toHaveBeenLastCalledWith('shell')
    expect(emitSnapshot.mock.calls.filter((call) => call[1] === 'pre').at(-1)?.[0]).toBe(refreshedSnapshot)
    await state.shellSessions.dispose('manager-dispose', { gracefulMs: 5, forceMs: 5, confirmMs: 5 })
  })
})

describe('shell terminal observation abort handling', () => {
  it('acks the final lease and writes a matching result when the original Post hook is aborted', async () => {
    const provider = new FakeProvider()
    const state = createLoopState('default', { projectCwd: process.cwd(), shellProvider: provider })
    const hookSnapshot = snapshot(1)
    const controller = new AbortController()
    const hookBus = new HookBus(new HookRegistry())
    vi.spyOn(hookBus, 'captureToolSnapshot').mockReturnValue(hookSnapshot)
    const emitSnapshot = vi.spyOn(hookBus, 'emitToolSnapshot').mockImplementation(async (_snapshot, phase) => {
      if (phase === 'pre') return []
      controller.abort()
      throw new DOMException('Post hook aborted', 'AbortError')
    })
    const options: AgentOptions = {
      modelId: 'test-model',
      trustMode: true,
      printMode: false,
      hookBus,
      abortSignal: controller.signal,
    }
    const callbacks = makeCallbacks()

    await processToolCalls(
      [{ toolName: 'shell', toolCallId: 'call-shell', input: { command: 'command', runInBackground: true } }],
      state,
      options,
      callbacks,
      stubModel,
    )
    const shellId = state.shellSessions.list()[0]!.shellId
    provider.attempts[0]!.complete()

    await processToolCalls(
      [{ toolName: 'shellOutput', toolCallId: 'call-observe', input: { shellId, block: false } }],
      state,
      options,
      callbacks,
      stubModel,
    )

    expect(emitSnapshot.mock.calls.filter((call) => call[1] === 'post')).toHaveLength(1)
    expect(resultPart(state, 'call-observe')).toBeDefined()
    expect(state.shellSessions.list()).toEqual([])
  })
})
