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
  loadRuleFiles: vi.fn().mockResolvedValue([]),
}))

vi.mock('../src/knowledge/session.js', () => ({
  loadLatestSession: vi.fn().mockResolvedValue(null),
  formatSessionForPrompt: vi.fn().mockReturnValue(''),
  generateSessionSummary: vi.fn().mockResolvedValue({}),
  saveSessionSummary: vi.fn().mockResolvedValue(undefined),
}))

describe('agent loop', () => {
  let mockCallbacks: AgentCallbacks

  beforeEach(() => {
    vi.clearAllMocks()
    mockCallbacks = {
      onTextDelta: vi.fn(),
      onToolCall: vi.fn(),
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

    const state = await agentLoop(
      'Say hello',
      {} as any,
      { modelId: 'anthropic:claude-sonnet-4-5', trustMode: false, maxTurns: 1, printMode: false },
      mockCallbacks,
    )

    expect(mockCallbacks.onTextDelta).toHaveBeenCalledWith('Hello')
    expect(mockCallbacks.onTextDelta).toHaveBeenCalledWith(' world')

    expect(mockCallbacks.onUsageUpdate).toHaveBeenCalled()
    const usageArg = vi.mocked(mockCallbacks.onUsageUpdate).mock.calls[0][0] as TokenUsage
    expect(usageArg.inputTokens).toBe(100)
    expect(usageArg.outputTokens).toBe(20)
    expect(usageArg.totalTokens).toBe(120)

    expect(state.turnCount).toBe(1)
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

    const state = await agentLoop(
      'Quick task',
      {} as any,
      { modelId: 'test:model', trustMode: false, maxTurns: 10, printMode: false },
      mockCallbacks,
    )

    expect(state.turnCount).toBe(1)
  })

  it('tracks cost estimation for known models', async () => {
    vi.mocked(streamText).mockReturnValue({
      fullStream: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: 'test' }
        },
      },
      response: Promise.resolve({ messages: [{ role: 'assistant', content: 'test' }] }),
      usage: Promise.resolve({ inputTokens: 10000, outputTokens: 2000 }),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    } as any)

    await agentLoop(
      'test',
      {} as any,
      { modelId: 'anthropic:claude-sonnet-4-5', trustMode: false, maxTurns: 1, printMode: false },
      mockCallbacks,
    )

    const usageArg = vi.mocked(mockCallbacks.onUsageUpdate).mock.calls[0][0] as TokenUsage
    // Sonnet: 10K * $3/M + 2K * $15/M = $0.03 + $0.03 = $0.06
    expect(usageArg.estimatedCost).toBeCloseTo(0.06, 3)
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
})
