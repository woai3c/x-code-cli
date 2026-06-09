// Tests for agent/compression.ts — progress callbacks and token stats
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { generateText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'

import {
  KEEP_RECENT,
  checkAndCompressContext,
  compressMessages,
  handleContextTooLong,
} from '../src/agent/compression.js'
import { createLoopState } from '../src/agent/loop-state.js'
import type { AgentCallbacks } from '../src/types/index.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual('ai')
  return { ...actual, generateText: vi.fn() }
})

vi.mock('../src/knowledge/session.js', () => ({
  generateSessionSummary: vi.fn().mockResolvedValue({ summary: 'session summary' }),
}))

vi.mock('../src/agent/session-store.js', () => ({
  markBoundaryAndReflush: vi.fn().mockResolvedValue(undefined),
}))

// ── Helpers ──

function makeCallbacks(overrides: Partial<AgentCallbacks> = {}): AgentCallbacks {
  return {
    onTextDelta: vi.fn(),
    onToolCall: vi.fn(),
    onToolProgress: vi.fn(),
    onToolResult: vi.fn(),
    onAskPermission: vi.fn().mockResolvedValue(true),
    onAskUser: vi.fn().mockResolvedValue('ok'),
    onPlanApprovalRequest: vi.fn().mockResolvedValue(true),
    onPlanModeChange: vi.fn(),
    onTodosUpdate: vi.fn(),
    onShellOutput: vi.fn(),
    onUsageUpdate: vi.fn(),
    onContextCompressed: vi.fn(),
    onCompressionProgress: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  }
}

const fakeModel = {} as LanguageModel

function padMessages(count: number): ModelMessage[] {
  const msgs: ModelMessage[] = []
  for (let i = 0; i < count; i++) {
    msgs.push(
      { role: 'user', content: `message ${i} ${'x'.repeat(500)}` },
      { role: 'assistant', content: `reply ${i} ${'y'.repeat(500)}` },
    )
  }
  return msgs
}

// ── compressMessages ──

describe('compressMessages', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns messages unchanged when there are fewer than KEEP_RECENT', async () => {
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    const result = await compressMessages(msgs, fakeModel)
    expect(result).toBe(msgs)
    expect(generateText).not.toHaveBeenCalled()
  })

  it('calls generateText and returns summary + recent messages', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'Summary of old conversation' } as any)
    const msgs = padMessages(KEEP_RECENT + 2)
    const result = await compressMessages(msgs, fakeModel)

    expect(generateText).toHaveBeenCalledOnce()
    expect(result[0].role).toBe('user')
    expect(result[0].content).toContain('[Previous conversation summary]')
    expect(result[0].content).toContain('Summary of old conversation')
    expect(result.length).toBeLessThan(msgs.length)
  })
})

// ── checkAndCompressContext (proactive) ──

describe('checkAndCompressContext', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does nothing when below threshold', async () => {
    const state = createLoopState()
    state.messages = padMessages(2)
    const cb = makeCallbacks()

    await checkAndCompressContext(state, fakeModel, 999_999, cb)

    expect(cb.onCompressionProgress).not.toHaveBeenCalled()
    expect(cb.onContextCompressed).not.toHaveBeenCalled()
  })

  it('emits progress phases and compressed message with token stats on full compression', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'compressed summary' } as any)
    const state = createLoopState()
    state.messages = padMessages(KEEP_RECENT + 4)
    state.lastInputTokens = 999_999

    const cb = makeCallbacks()
    await checkAndCompressContext(state, fakeModel, 1, cb)

    const progressCalls = vi.mocked(cb.onCompressionProgress!).mock.calls.map((c) => c[0])
    expect(progressCalls).toContain('Removing duplicate tool calls...')
    expect(progressCalls).toContain('Truncating old tool results...')
    expect(progressCalls).toContain('Generating session summary...')
    expect(progressCalls).toContain('Summarizing conversation...')

    expect(cb.onContextCompressed).toHaveBeenCalledOnce()
    const compressedMsg = vi.mocked(cb.onContextCompressed).mock.calls[0][0]
    expect(compressedMsg).toMatch(/Context compressed: ~\d+k → ~\d+k tokens\./)
  })

  it('works when onCompressionProgress is undefined', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'summary' } as any)
    const state = createLoopState()
    state.messages = padMessages(KEEP_RECENT + 4)
    state.lastInputTokens = 999_999

    const cb = makeCallbacks()
    delete (cb as any).onCompressionProgress

    await expect(checkAndCompressContext(state, fakeModel, 1, cb)).resolves.toBeUndefined()
    expect(cb.onContextCompressed).toHaveBeenCalled()
  })

  it('resets lastInputTokens and sets expectCacheMiss after deep compression', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'summary' } as any)
    const state = createLoopState()
    state.messages = padMessages(KEEP_RECENT + 4)
    state.lastInputTokens = 999_999

    await checkAndCompressContext(state, fakeModel, 1, makeCallbacks())

    expect(state.lastInputTokens).toBe(0)
    expect(state.expectCacheMiss).toBe(true)
  })
})

// ── handleContextTooLong (reactive) ──

describe('handleContextTooLong', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns false when messages are too few', async () => {
    const state = createLoopState()
    state.messages = [{ role: 'user', content: 'hi' }]
    const result = await handleContextTooLong(state, fakeModel, makeCallbacks())
    expect(result).toBe(false)
  })

  it('emits progress and compressed message with token stats', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'compressed' } as any)
    const state = createLoopState()
    state.messages = padMessages(KEEP_RECENT + 4)

    const cb = makeCallbacks()
    const result = await handleContextTooLong(state, fakeModel, cb)

    expect(result).toBe(true)
    expect(cb.onCompressionProgress).toHaveBeenCalledWith('Summarizing conversation...')

    const compressedMsg = vi.mocked(cb.onContextCompressed).mock.calls[0][0]
    expect(compressedMsg).toMatch(/Context too long — compressed \(~\d+k → ~\d+k tokens\)\. Retrying\.\.\./)
  })

  it('resets lastInputTokens and sets expectCacheMiss', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'compressed' } as any)
    const state = createLoopState()
    state.messages = padMessages(KEEP_RECENT + 4)

    await handleContextTooLong(state, fakeModel, makeCallbacks())

    expect(state.lastInputTokens).toBe(0)
    expect(state.expectCacheMiss).toBe(true)
  })
})
