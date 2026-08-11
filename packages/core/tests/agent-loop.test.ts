// Tests for agent loop (mock LLM responses)
import { beforeEach, describe, expect, it, vi } from 'vitest'

import os from 'node:os'
import path from 'node:path'

import { generateText, streamText } from 'ai'

import { createGoal, requestGoalBlocked } from '../src/agent/goal/state.js'
import { createLoopState } from '../src/agent/loop-state.js'
import type { LoopState } from '../src/agent/loop-state.js'
import { agentLoop } from '../src/agent/loop.js'
import { buildSystemPrompt } from '../src/agent/system-prompt.js'
import { isManagedMemoryAccess, isManagedMemoryMutation } from '../src/agent/tool-execution.js'
import type { LateRecallSignals, MemoryRecallAttachment } from '../src/knowledge/memory/types.js'
import type { AgentCallbacks, TokenUsage } from '../src/types/index.js'

// Mock cheerio + turndown (pulled in via toolRegistry → webFetch)
vi.mock('cheerio', () => ({
  load: vi.fn(() => {
    const $ = () => ({ remove: vi.fn(), first: vi.fn(() => ({ length: 0, html: () => '' })), html: () => '' })
    $.load = $
    return $
  }),
}))
vi.mock('turndown', () => ({
  default: class {
    turndown() {
      return ''
    }
  },
}))

// Mock AI SDK
vi.mock('ai', async () => {
  const actual = await vi.importActual('ai')
  return {
    ...actual,
    streamText: vi.fn(),
    generateText: vi.fn(),
  }
})

// Mock knowledge modules to avoid filesystem side effects
vi.mock('../src/knowledge/loader.js', () => ({
  buildKnowledgeContext: vi.fn().mockResolvedValue(''),
}))

vi.mock('../src/agent/session-summary.js', () => ({
  generateSessionSummary: vi.fn().mockResolvedValue({}),
}))

// Block jsonl persistence — keep tests free of fs side effects in the
// project's `.x-code/sessions/` (which would leak between runs and pollute
// developers' repos when they execute the suite locally).
vi.mock('../src/agent/session-store.js', () => ({
  appendHeader: vi.fn().mockResolvedValue(undefined),
  appendUsage: vi.fn().mockResolvedValue(undefined),
  appendInterrupted: vi.fn().mockResolvedValue(undefined),
  appendStepStats: vi.fn().mockResolvedValue(undefined),
  appendCheckpoint: vi.fn().mockResolvedValue(undefined),
  flushPendingMessages: vi.fn().mockResolvedValue(undefined),
  markBoundaryAndReflush: vi.fn().mockResolvedValue(undefined),
  getSessionFilePath: vi.fn().mockReturnValue(''),
  hydrateLoopState: vi.fn(),
  listSessions: vi.fn().mockResolvedValue([]),
  loadSession: vi.fn().mockResolvedValue(null),
  pickLatestSession: vi.fn().mockResolvedValue(null),
}))

describe('agent loop', () => {
  let mockCallbacks: AgentCallbacks

  beforeEach(() => {
    vi.clearAllMocks()
    mockCallbacks = {
      onTextDelta: vi.fn(),
      onToolCall: vi.fn(),
      onToolProgress: vi.fn(),
      onToolResult: vi.fn(),
      onAskPermission: vi.fn().mockResolvedValue(true),
      onAskUser: vi.fn().mockResolvedValue('option1'),
      onPlanApprovalRequest: vi.fn().mockResolvedValue(false),
      onPlanModeChange: vi.fn(),
      onTodosUpdate: vi.fn(),
      onShellOutput: vi.fn(),
      onUsageUpdate: vi.fn(),
      onContextCompressed: vi.fn(),
      onStreamRetry: vi.fn(),
      onError: vi.fn(),
    }
  })

  it('reconnects an interrupted text stream and persists one combined assistant response', async () => {
    const interrupted = new Error('terminated')
    vi.mocked(streamText)
      .mockReturnValueOnce({
        stream: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text-delta', text: 'partial-' }
            yield { type: 'error', error: interrupted }
          },
        },
        response: Promise.resolve({ messages: [] }),
        usage: Promise.resolve(undefined),
        finishReason: Promise.resolve('error'),
        toolCalls: Promise.resolve([]),
      } as any)
      .mockReturnValueOnce({
        stream: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text-delta', text: 'continued' }
          },
        },
        response: Promise.resolve({ messages: [{ role: 'assistant', content: 'continued' }] }),
        usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
        finishReason: Promise.resolve('stop'),
        toolCalls: Promise.resolve([]),
      } as any)

    const { state, turnCount } = await agentLoop(
      'recover this response',
      {} as any,
      {
        modelId: 'test:model',
        trustMode: false,
        maxTurns: 3,
        printMode: false,
        streamMaxRetries: 1,
        streamIdleTimeoutMs: 0,
      },
      mockCallbacks,
    )

    expect(turnCount).toBe(1)
    expect(streamText).toHaveBeenCalledTimes(2)
    expect(mockCallbacks.onTextDelta).toHaveBeenNthCalledWith(1, 'partial-')
    expect(mockCallbacks.onTextDelta).toHaveBeenNthCalledWith(2, 'continued')
    expect(mockCallbacks.onStreamRetry).toHaveBeenCalledWith({
      attempt: 1,
      maxAttempts: 1,
      delayMs: 1000,
      reason: 'network',
    })
    expect(mockCallbacks.onStreamRetry).toHaveBeenLastCalledWith(null)
    expect(mockCallbacks.onError).not.toHaveBeenCalled()

    const retryMessages = vi.mocked(streamText).mock.calls[1]![0].messages as Array<{
      role: string
      content: unknown
    }>
    expect(retryMessages.at(-2)).toEqual({ role: 'assistant', content: 'partial-' })
    expect(retryMessages.at(-1)?.role).toBe('user')
    expect(String(retryMessages.at(-1)?.content)).toContain('Continue directly')
    expect(state.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(state.messages.at(-1)).toEqual({ role: 'assistant', content: 'partial-continued' })
  })

  it('suppresses an exact prefix replay after reconnect', async () => {
    const interrupted = new Error('other side closed')
    vi.mocked(streamText)
      .mockReturnValueOnce({
        stream: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text-delta', text: 'prefix-' }
            yield { type: 'error', error: interrupted }
          },
        },
        response: Promise.resolve({ messages: [] }),
        usage: Promise.resolve(undefined),
        finishReason: Promise.resolve('error'),
        toolCalls: Promise.resolve([]),
      } as any)
      .mockReturnValueOnce({
        stream: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text-delta', text: 'prefix-' }
            yield { type: 'text-delta', text: 'rest' }
          },
        },
        response: Promise.resolve({ messages: [{ role: 'assistant', content: 'prefix-rest' }] }),
        usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
        finishReason: Promise.resolve('stop'),
        toolCalls: Promise.resolve([]),
      } as any)

    const { state } = await agentLoop(
      'deduplicate replay',
      {} as any,
      {
        modelId: 'test:model',
        trustMode: false,
        maxTurns: 3,
        printMode: false,
        streamMaxRetries: 1,
        streamIdleTimeoutMs: 0,
      },
      mockCallbacks,
    )

    expect(vi.mocked(mockCallbacks.onTextDelta).mock.calls.map(([text]) => text)).toEqual(['prefix-', 'rest'])
    expect(state.messages.at(-1)).toEqual({ role: 'assistant', content: 'prefix-rest' })
  })

  it('does not reconnect after tool activity makes replay unsafe', async () => {
    const interrupted = new Error('terminated')
    vi.mocked(streamText).mockReturnValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'tool-call', toolCallId: 'write-1', toolName: 'writeFile', input: { filePath: '/tmp/x' } }
          yield { type: 'error', error: interrupted }
        },
      },
      response: Promise.resolve({ messages: [] }),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve('error'),
      toolCalls: Promise.resolve([]),
    } as any)

    await agentLoop(
      'do not replay tools',
      {} as any,
      {
        modelId: 'test:model',
        trustMode: false,
        maxTurns: 3,
        printMode: false,
        streamMaxRetries: 5,
        streamIdleTimeoutMs: 0,
      },
      mockCallbacks,
    )

    expect(streamText).toHaveBeenCalledTimes(1)
    expect(mockCallbacks.onStreamRetry).not.toHaveBeenCalledWith(expect.objectContaining({ attempt: 1 }))
    expect(mockCallbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Network connection failed') }),
    )
  })

  it('does not apply the provider idle timeout while tool activity is in progress', async () => {
    vi.mocked(streamText).mockImplementation(
      (options) =>
        ({
          stream: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'tool-call', toolCallId: 'slow-1', toolName: 'slowTool', input: {} }
              await new Promise((resolve) => setTimeout(resolve, 250))
              if (options.abortSignal?.aborted) {
                yield { type: 'error', error: new Error('aborted while tool was running') }
                return
              }
              yield { type: 'text-delta', text: 'done' }
            },
          },
          response: Promise.resolve({ messages: [{ role: 'assistant', content: 'done' }] }),
          usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
          finishReason: Promise.resolve('stop'),
          toolCalls: Promise.resolve([]),
        }) as any,
    )

    const { state } = await agentLoop(
      'wait for the tool',
      {} as any,
      {
        modelId: 'test:model',
        trustMode: false,
        maxTurns: 3,
        printMode: false,
        streamMaxRetries: 1,
        streamIdleTimeoutMs: 100,
      },
      mockCallbacks,
    )

    expect(streamText).toHaveBeenCalledTimes(1)
    expect(mockCallbacks.onError).not.toHaveBeenCalled()
    expect(state.messages.at(-1)).toEqual({ role: 'assistant', content: 'done' })
  })

  it('marks string error results from auto-executed tools as UI failures', async () => {
    vi.mocked(streamText).mockReturnValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'tool-call', toolCallId: 'web-1', toolName: 'webFetch', input: { url: 'https://example.com' } }
          yield {
            type: 'tool-result',
            toolCallId: 'web-1',
            toolName: 'webFetch',
            output: 'Error fetching URL: fetch failed',
          }
        },
      },
      response: Promise.resolve({ messages: [{ role: 'assistant', content: 'failed' }] }),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    } as any)

    await agentLoop(
      'fetch example.com',
      {} as any,
      { modelId: 'test:model', trustMode: false, maxTurns: 3, printMode: false },
      mockCallbacks,
    )

    expect(mockCallbacks.onToolResult).toHaveBeenCalledWith('web-1', 'Error fetching URL: fetch failed', true)
  })

  it('enqueues exactly one durable memory job after a clean root stop and never for a sub-agent', async () => {
    const response = () => ({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: 'done' }
        },
      },
      response: Promise.resolve({ messages: [{ role: 'assistant', content: 'done' }] }),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    })
    vi.mocked(streamText).mockImplementation(() => response() as any)
    const memoryService = {
      setActiveModelId: vi.fn(),
      setNoticeHandler: vi.fn(),
      initialize: vi.fn().mockResolvedValue(undefined),
      recall: vi.fn().mockResolvedValue(null),
      getConfig: vi.fn().mockReturnValue({ maxInputTokens: 12_000 }),
      enqueuePostTurnJob: vi.fn().mockResolvedValue('created'),
      search: vi.fn().mockResolvedValue([]),
    }

    await agentLoop(
      'Remember that x-code is my product',
      {} as any,
      { modelId: 'test:model', trustMode: false, maxTurns: 3, printMode: false, memoryService: memoryService as any },
      mockCallbacks,
    )
    expect(memoryService.enqueuePostTurnJob).toHaveBeenCalledTimes(1)
    expect(memoryService.enqueuePostTurnJob.mock.calls[0]?.[0].projection.userMessages).toEqual([
      'Remember that x-code is my product',
    ])

    memoryService.enqueuePostTurnJob.mockClear()
    await agentLoop(
      'Remember this child result',
      {} as any,
      {
        modelId: 'test:model',
        trustMode: false,
        maxTurns: 3,
        printMode: false,
        memoryService: memoryService as any,
        toolFilter: { allow: [] },
      },
      mockCallbacks,
    )
    expect(memoryService.enqueuePostTurnJob).not.toHaveBeenCalled()
  })

  it('keeps memory-only requests and persistence details out of the general tool workflow', () => {
    const prompt = buildSystemPrompt({ modelId: 'test:model' })

    expect(prompt).toContain('do not call tools solely for that request')
    expect(prompt).toContain('Never modify the managed memory store with writeFile, edit, or shell')
    expect(prompt).toContain('do not narrate memory extraction, queues, internal paths')
  })

  it('classifies managed-memory mutations while preserving read-only diagnostics', () => {
    const memoryRoot = path.join(os.homedir(), '.x-code', 'memory')

    expect(
      isManagedMemoryMutation('edit', { filePath: path.join(memoryRoot, 'topics', 'profile.md') }, memoryRoot),
    ).toBe(true)
    expect(
      isManagedMemoryAccess('readFile', { filePath: path.join(memoryRoot, 'topics', 'profile.md') }, memoryRoot),
    ).toBe(true)
    expect(
      isManagedMemoryMutation('edit', { filePath: path.join(process.cwd(), 'src', 'profile.ts') }, memoryRoot),
    ).toBe(false)
    expect(isManagedMemoryMutation('shell', { command: 'ls ~/.x-code/memory/topics 2>/dev/null' }, memoryRoot)).toBe(
      false,
    )
    expect(
      isManagedMemoryMutation(
        'shell',
        { command: "sed -i 's/alpha/beta/' ~/.x-code/memory/topics/profile.md" },
        memoryRoot,
      ),
    ).toBe(true)
    expect(
      isManagedMemoryMutation('shell', { command: 'echo beta > ~/.x-code/memory/topics/profile.md' }, memoryRoot),
    ).toBe(true)
  })

  it('silently blocks a model from editing the managed memory store without asking permission', async () => {
    const memoryRoot = path.join(process.cwd(), '.managed-memory-test')
    const toolCall = {
      toolCallId: 'memory-edit-1',
      toolName: 'edit',
      input: {
        filePath: path.join(memoryRoot, 'topics', 'profile.md'),
        oldString: 'alpha',
        newString: 'beta',
      },
    }
    vi.mocked(streamText)
      .mockReturnValueOnce({
        stream: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'tool-call', ...toolCall }
          },
        },
        response: Promise.resolve({
          messages: [{ role: 'assistant', content: [{ type: 'tool-call', ...toolCall }] }],
        }),
        usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
        finishReason: Promise.resolve('tool-calls'),
        toolCalls: Promise.resolve([toolCall]),
      } as any)
      .mockReturnValueOnce({
        stream: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text-delta', text: '记住了。' }
          },
        },
        response: Promise.resolve({ messages: [{ role: 'assistant', content: '记住了。' }] }),
        usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
        finishReason: Promise.resolve('stop'),
        toolCalls: Promise.resolve([]),
      } as any)
    const memoryService = {
      memoryRoot,
      setActiveModelId: vi.fn(),
      setNoticeHandler: vi.fn(),
      initialize: vi.fn().mockResolvedValue(undefined),
      recall: vi.fn().mockResolvedValue(null),
      getConfig: vi.fn().mockReturnValue({ maxInputTokens: 12_000 }),
      enqueuePostTurnJob: vi.fn().mockResolvedValue('created'),
      search: vi.fn().mockResolvedValue([]),
    }

    const result = await agentLoop(
      '记住状态现在是 beta',
      {} as any,
      { modelId: 'test:model', trustMode: false, maxTurns: 3, printMode: false, memoryService: memoryService as any },
      mockCallbacks,
    )

    expect(mockCallbacks.onAskPermission).not.toHaveBeenCalled()
    expect(mockCallbacks.onToolCall).not.toHaveBeenCalled()
    expect(mockCallbacks.onToolResult).not.toHaveBeenCalled()
    expect(JSON.stringify(result.state.messages)).toContain(
      'Managed memory is written by the private post-turn service',
    )
    expect(memoryService.enqueuePostTurnJob).toHaveBeenCalledOnce()
  })

  it('keeps the root-turn projection intact when compaction rewrites the session message array', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'compressed old history' } as never)
    vi.mocked(streamText).mockReturnValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: 'current answer' }
        },
      },
      response: Promise.resolve({ messages: [{ role: 'assistant', content: 'current answer' }] }),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    } as any)
    const memoryService = {
      setActiveModelId: vi.fn(),
      setNoticeHandler: vi.fn(),
      initialize: vi.fn().mockResolvedValue(undefined),
      recall: vi.fn().mockResolvedValue(null),
      getConfig: vi.fn().mockReturnValue({ maxInputTokens: 12_000 }),
      enqueuePostTurnJob: vi.fn().mockResolvedValue('created'),
      search: vi.fn().mockResolvedValue([]),
    }
    const state = createLoopState()
    state.messages = Array.from({ length: 10 }, (_, index) => [
      { role: 'user' as const, content: `old question ${index} ${'x'.repeat(5000)}` },
      { role: 'assistant' as const, content: `old answer ${index} ${'y'.repeat(5000)}` },
    ]).flat()
    state.lastInputTokens = Number.MAX_SAFE_INTEGER

    await agentLoop(
      'current question',
      {} as any,
      { modelId: 'test:model', trustMode: false, maxTurns: 2, printMode: false, memoryService: memoryService as any },
      mockCallbacks,
      state,
    )

    const projection = memoryService.enqueuePostTurnJob.mock.calls[0]?.[0].projection
    expect(projection.userMessages).toEqual(['current question'])
    expect(projection.assistantFinal).toBe('current answer')
    expect(JSON.stringify(projection)).not.toContain('old question')
  })

  it('late-recalls successful auto tool signals into a queued user anchor', async () => {
    const firstResponseMessages = [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'auto-1', toolName: 'readFile', input: { path: '/repo' } }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'auto-1',
            toolName: 'readFile',
            output: { type: 'text', value: '/repo/src/new-worker.ts NewWorker' },
          },
          {
            type: 'tool-result',
            toolCallId: 'auto-2',
            toolName: 'readFile',
            output: { type: 'error-text', value: '/repo/private.ts FailedEntity' },
          },
        ],
      },
    ]
    vi.mocked(streamText)
      .mockReturnValueOnce({
        stream: { async *[Symbol.asyncIterator]() {} },
        response: Promise.resolve({ messages: firstResponseMessages }),
        usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
        finishReason: Promise.resolve('tool-calls'),
        toolCalls: Promise.resolve([]),
      } as any)
      .mockReturnValueOnce({
        stream: { async *[Symbol.asyncIterator]() {} },
        response: Promise.resolve({ messages: [{ role: 'assistant', content: 'done' }] }),
        usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
        finishReason: Promise.resolve('stop'),
        toolCalls: Promise.resolve([]),
      } as any)
    const lateRecall = vi.fn(async (signals: LateRecallSignals, recallState: LoopState) => {
      const attachment: MemoryRecallAttachment = {
        anchorMessageIndex: signals.anchorMessageIndex,
        placement: signals.placement,
        estimatedTokens: 10,
        topics: [
          {
            topicId: 'worker-memory',
            topicHash: 'worker-hash',
            factIds: [],
            factHashes: {},
            renderedContent: 'NewWorker uses the durable worker configuration.',
          },
        ],
      }
      recallState.memoryRecallAttachments.push(attachment)
      return attachment
    })
    const memoryService = {
      setActiveModelId: vi.fn(),
      setNoticeHandler: vi.fn(),
      initialize: vi.fn().mockResolvedValue(undefined),
      recall: vi.fn().mockResolvedValue(null),
      lateRecall,
      getConfig: vi.fn().mockReturnValue({ maxInputTokens: 12_000 }),
      enqueuePostTurnJob: vi.fn().mockResolvedValue('created'),
      search: vi.fn().mockResolvedValue([]),
    }
    const consumeQueuedInputs = vi
      .fn<() => string[] | undefined>()
      .mockReturnValueOnce(['continue with the worker'])
      .mockReturnValue(undefined)

    await agentLoop(
      'inspect the operation',
      {} as any,
      {
        modelId: 'test:model',
        trustMode: false,
        maxTurns: 3,
        printMode: false,
        consumeQueuedInputs,
        memoryService: memoryService as any,
      },
      mockCallbacks,
    )

    expect(lateRecall).toHaveBeenCalledTimes(1)
    expect(lateRecall.mock.calls[0]?.[0]).toMatchObject({
      placement: 'before-user',
      paths: ['/repo/src/new-worker.ts'],
    })
    expect(lateRecall.mock.calls[0]?.[0].identifiers).toContain('NewWorker')
    expect(lateRecall.mock.calls[0]?.[0].identifiers).not.toContain('FailedEntity')
    const secondCallMessages = vi.mocked(streamText).mock.calls[1]?.[0].messages as Array<{
      role: string
      content: unknown
    }>
    expect(
      secondCallMessages.some(
        (message) =>
          message.role === 'user' &&
          JSON.stringify(message.content).includes('NewWorker uses the durable worker configuration.'),
      ),
    ).toBe(true)
    expect(
      secondCallMessages.some(
        (message, index) => message.role === 'user' && secondCallMessages[index - 1]?.role === 'user',
      ),
    ).toBe(false)
  })

  it('streams text from LLM and collects usage', async () => {
    const mockChunks = [
      { type: 'text-delta', text: 'Hello' },
      { type: 'text-delta', text: ' world' },
    ]

    const mockAsyncIterable = {
      async *[Symbol.asyncIterator]() {
        for (const chunk of mockChunks) yield chunk
      },
    }

    vi.mocked(streamText).mockReturnValue({
      stream: mockAsyncIterable,
      response: Promise.resolve({ messages: [{ role: 'assistant', content: 'Hello world' }] }),
      usage: Promise.resolve({ inputTokens: 100, outputTokens: 20 }),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    } as any)

    const initialState = createLoopState()
    const providerTurnCountsAtUsageUpdate: number[] = []
    mockCallbacks.onUsageUpdate = vi.fn(() => {
      providerTurnCountsAtUsageUpdate.push(initialState.providerTurns.length)
    })

    const { state, turnCount } = await agentLoop(
      'Say hello',
      {} as any,
      { modelId: 'anthropic:claude-sonnet-5', trustMode: false, maxTurns: 1, printMode: false },
      mockCallbacks,
      initialState,
    )

    expect(mockCallbacks.onTextDelta).toHaveBeenCalledWith('Hello')
    expect(mockCallbacks.onTextDelta).toHaveBeenCalledWith(' world')
    expect(mockCallbacks.onStreamRetry).not.toHaveBeenCalled()

    expect(mockCallbacks.onUsageUpdate).toHaveBeenCalled()
    const usageArg = vi.mocked(mockCallbacks.onUsageUpdate).mock.calls[0][0] as TokenUsage
    expect(usageArg.inputTokens).toBe(100)
    expect(usageArg.outputTokens).toBe(20)
    expect(usageArg.totalTokens).toBe(120)
    expect(usageArg.currentContextTokens).toBe(120)
    expect(providerTurnCountsAtUsageUpdate).toEqual([1])

    expect(turnCount).toBe(1)
    expect(state.messages).toEqual([
      { role: 'user', content: 'Say hello' },
      { role: 'assistant', content: 'Hello world' },
    ])
  })

  it('stops at finishReason stop (single turn)', async () => {
    vi.mocked(streamText).mockReturnValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: 'done' }
        },
      },
      response: Promise.resolve({ messages: [{ role: 'assistant', content: 'done' }] }),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    } as any)

    const { turnCount } = await agentLoop(
      'Quick task',
      {} as any,
      { modelId: 'test:model', trustMode: false, maxTurns: 10, printMode: false },
      mockCallbacks,
    )

    expect(turnCount).toBe(1)
  })

  it('reports error when max turns exceeded', async () => {
    // Force tool-calls finish reason to keep looping
    vi.mocked(streamText).mockReturnValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: '' }
        },
      },
      response: Promise.resolve({ messages: [{ role: 'assistant', content: '' }] }),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 2 }),
      finishReason: Promise.resolve('tool-calls'),
      toolCalls: Promise.resolve([]),
    } as any)

    await agentLoop(
      'loop forever',
      {} as any,
      { modelId: 'test:model', trustMode: false, maxTurns: 2, printMode: false },
      mockCallbacks,
    )

    expect(mockCallbacks.onError).toHaveBeenCalled()
    const errArg = vi.mocked(mockCallbacks.onError).mock.calls[0][0]
    expect(errArg.message).toContain('maximum turns')
  })

  it('turn counter resets between submits sharing the same LoopState', async () => {
    // Regression: turnCount used to live on LoopState and accumulate across
    // every user submit within the same CLI session — after ~100 cumulative
    // turns every subsequent submit hit the cap immediately. Now it's a
    // per-invocation local, so two clean turns in a row each report 1.
    vi.mocked(streamText).mockReturnValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: 'ok' }
        },
      },
      response: Promise.resolve({ messages: [{ role: 'assistant', content: 'ok' }] }),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 1 }),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    } as any)

    const opts = { modelId: 'test:model', trustMode: false, maxTurns: 1, printMode: false }
    const first = await agentLoop('msg 1', {} as any, opts, mockCallbacks)
    expect(first.turnCount).toBe(1)

    // Re-enter with the same LoopState — simulates a second user submit.
    const second = await agentLoop('msg 2', {} as any, opts, mockCallbacks, first.state)
    expect(second.turnCount).toBe(1)
  })

  it('omitted maxTurns runs without a cap', async () => {
    // The fix also makes maxTurns optional. When unset, the loop runs to
    // a natural finish — no "Reached maximum turns" error.
    vi.mocked(streamText).mockReturnValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: 'done' }
        },
      },
      response: Promise.resolve({ messages: [{ role: 'assistant', content: 'done' }] }),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 1 }),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    } as any)

    const { turnCount } = await agentLoop(
      'no cap',
      {} as any,
      { modelId: 'test:model', trustMode: false, printMode: false },
      mockCallbacks,
    )
    expect(turnCount).toBe(1)
    expect(mockCallbacks.onError).not.toHaveBeenCalled()
  })

  it('returns to the goal runner as soon as updateGoal requests a transition', async () => {
    const state = createLoopState()
    createGoal(state, { objective: 'wait for an external value', maxTurns: 20 })
    vi.mocked(streamText).mockReturnValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          requestGoalBlocked(state, { blocker: 'missing environment variable' })
          yield { type: 'tool-call', toolCallId: 'goal-blocked', toolName: 'updateGoal', input: {} }
          yield {
            type: 'tool-result',
            toolCallId: 'goal-blocked',
            toolName: 'updateGoal',
            output: { ok: true },
          }
        },
      },
      response: Promise.resolve({ messages: [{ role: 'assistant', content: '' }] }),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 1 }),
      finishReason: Promise.resolve('tool-calls'),
      toolCalls: Promise.resolve([]),
    } as any)

    const result = await agentLoop(
      'check once',
      {} as any,
      { modelId: 'test:model', trustMode: false, maxTurns: 10, printMode: false },
      mockCallbacks,
      state,
    )

    expect(result.turnCount).toBe(1)
    expect(state.goal?.pendingTransition?.kind).toBe('blocked_requested')
    expect(streamText).toHaveBeenCalledTimes(1)
    expect(mockCallbacks.onError).not.toHaveBeenCalled()
  })

  it('injects queued user messages at the tool-call boundary', async () => {
    // Steering: the user types while tools run. The queued text must land
    // in state.messages BEFORE the next streamText call, merged into one
    // user message — never interleaved with pending tool_results.
    const stopResult = {
      stream: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: 'done' }
        },
      },
      response: Promise.resolve({ messages: [{ role: 'assistant', content: 'done' }] }),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 1 }),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    } as any
    vi.mocked(streamText)
      .mockReturnValueOnce({
        stream: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text-delta', text: 'working' }
          },
        },
        response: Promise.resolve({ messages: [{ role: 'assistant', content: 'working' }] }),
        usage: Promise.resolve({ inputTokens: 5, outputTokens: 1 }),
        finishReason: Promise.resolve('tool-calls'),
        toolCalls: Promise.resolve([]),
      } as any)
      .mockReturnValue(stopResult)

    const consumeQueuedInputs = vi
      .fn<() => string[] | undefined>()
      .mockReturnValueOnce(['first queued', 'second queued'])
      .mockReturnValue(undefined)

    const { state, turnCount } = await agentLoop(
      'start',
      {} as any,
      { modelId: 'test:model', trustMode: false, maxTurns: 10, printMode: false, consumeQueuedInputs },
      mockCallbacks,
    )

    expect(turnCount).toBe(2)
    const injected = state.messages.filter((m) => m.role === 'user').map((m) => m.content)
    // Multiple queued texts merge into ONE user message (back-to-back user
    // turns break some providers' tool-call sequencing), wrapped with the
    // mid-turn temporal marker so the model knows it arrived mid-task.
    const merged = injected.find((c) => typeof c === 'string' && c.includes('first queued\n\nsecond queued'))
    expect(merged).toBeDefined()
    expect(merged).toContain('while you were working')
    expect(injected.filter((c) => typeof c === 'string' && c.includes('first queued')).length).toBe(1)
    // The second API request must have carried the injected message.
    const secondCallMessages = vi.mocked(streamText).mock.calls[1][0].messages as { role: string; content: unknown }[]
    expect(
      secondCallMessages.some(
        (m) =>
          m.role === 'user' && typeof m.content === 'string' && m.content.includes('first queued\n\nsecond queued'),
      ),
    ).toBe(true)
  })

  it('follows up on stop when messages are still queued', async () => {
    // needs_follow_up: a message queued while the final reply streams must
    // keep the loop alive instead of returning to the UI idle.
    vi.mocked(streamText).mockReturnValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: 'reply' }
        },
      },
      response: Promise.resolve({ messages: [{ role: 'assistant', content: 'reply' }] }),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 1 }),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    } as any)

    const consumeQueuedInputs = vi
      .fn<() => string[] | undefined>()
      .mockReturnValueOnce(['late follow-up'])
      .mockReturnValue(undefined)

    const { state, turnCount } = await agentLoop(
      'start',
      {} as any,
      { modelId: 'test:model', trustMode: false, maxTurns: 10, printMode: false, consumeQueuedInputs },
      mockCallbacks,
    )

    expect(turnCount).toBe(2)
    expect(streamText).toHaveBeenCalledTimes(2)
    expect(
      state.messages.some(
        (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('late follow-up'),
      ),
    ).toBe(true)
  })

  it('runs without a queue when consumeQueuedInputs is absent', async () => {
    vi.mocked(streamText).mockReturnValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: 'done' }
        },
      },
      response: Promise.resolve({ messages: [{ role: 'assistant', content: 'done' }] }),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 1 }),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    } as any)

    const { turnCount } = await agentLoop(
      'plain',
      {} as any,
      { modelId: 'test:model', trustMode: false, maxTurns: 10, printMode: false },
      mockCallbacks,
    )

    expect(turnCount).toBe(1)
    expect(mockCallbacks.onError).not.toHaveBeenCalled()
  })
})
