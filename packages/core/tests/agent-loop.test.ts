// Tests for agent loop (mock LLM responses)
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { streamText } from 'ai'

import { agentLoop } from '../src/agent/loop.js'
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

vi.mock('../src/knowledge/session.js', () => ({
  generateSessionSummary: vi.fn().mockResolvedValue({}),
}))

// Block jsonl persistence — keep tests free of fs side effects in the
// project's `.x-code/sessions/` (which would leak between runs and pollute
// developers' repos when they execute the suite locally).
vi.mock('../src/agent/session-store.js', () => ({
  appendHeader: vi.fn().mockResolvedValue(undefined),
  appendUsage: vi.fn().mockResolvedValue(undefined),
  appendInterrupted: vi.fn().mockResolvedValue(undefined),
  flushPendingMessages: vi.fn().mockResolvedValue(undefined),
  markBoundaryAndReflush: vi.fn().mockResolvedValue(undefined),
  getSessionFilePath: vi.fn().mockReturnValue(''),
  hydrateLoopState: vi.fn(),
  listSessions: vi.fn().mockResolvedValue([]),
  loadSession: vi.fn().mockResolvedValue(null),
  pickLatestSession: vi.fn().mockResolvedValue(null),
  shortIdFor: vi.fn().mockReturnValue(''),
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
      onShellOutput: vi.fn(),
      onUsageUpdate: vi.fn(),
      onContextCompressed: vi.fn(),
      onError: vi.fn(),
    }
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
      fullStream: mockAsyncIterable,
      response: Promise.resolve({ messages: [{ role: 'assistant', content: 'Hello world' }] }),
      usage: Promise.resolve({ inputTokens: 100, outputTokens: 20 }),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    } as any)

    const { state, turnCount } = await agentLoop(
      'Say hello',
      {} as any,
      { modelId: 'anthropic:claude-sonnet-4-6', trustMode: false, maxTurns: 1, printMode: false },
      mockCallbacks,
    )

    expect(mockCallbacks.onTextDelta).toHaveBeenCalledWith('Hello')
    expect(mockCallbacks.onTextDelta).toHaveBeenCalledWith(' world')

    expect(mockCallbacks.onUsageUpdate).toHaveBeenCalled()
    const usageArg = vi.mocked(mockCallbacks.onUsageUpdate).mock.calls[0][0] as TokenUsage
    expect(usageArg.inputTokens).toBe(100)
    expect(usageArg.outputTokens).toBe(20)
    expect(usageArg.totalTokens).toBe(120)
    expect(usageArg.currentContextTokens).toBe(120)

    expect(turnCount).toBe(1)
    expect(state.messages.length).toBeGreaterThan(0)
  })

  it('stops at finishReason stop (single turn)', async () => {
    vi.mocked(streamText).mockReturnValue({
      fullStream: {
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
      fullStream: {
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
      fullStream: {
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
      fullStream: {
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
})
