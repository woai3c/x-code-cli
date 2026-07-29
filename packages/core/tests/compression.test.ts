// Tests for agent/compression.ts — progress callbacks and token stats
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { generateText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'

import {
  KEEP_RECENT,
  KEEP_RECENT_TOKENS,
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

// Each message pair is ~10K chars → ~3.3K tokens. This ensures a
// modest count exceeds KEEP_RECENT_TOKENS (20K) so compaction triggers.
const PAD_SIZE = 5000

function padMessages(count: number): ModelMessage[] {
  const msgs: ModelMessage[] = []
  for (let i = 0; i < count; i++) {
    msgs.push(
      { role: 'user', content: `message ${i} ${'x'.repeat(PAD_SIZE)}` },
      { role: 'assistant', content: `reply ${i} ${'y'.repeat(PAD_SIZE)}` },
    )
  }
  return msgs
}

// ── compressMessages ──

describe('compressMessages', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns messages unchanged when they all fit in the keep window', async () => {
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
    // 10 pairs × ~10K chars = ~100K chars → ~33K tokens, exceeds 20K budget
    const msgs = padMessages(10)
    const result = await compressMessages(msgs, fakeModel)

    expect(generateText).toHaveBeenCalledOnce()
    expect(result[0].role).toBe('user')
    expect(result[0].content).toContain('[Previous conversation summary]')
    expect(result[0].content).toContain('Summary of old conversation')
    expect(result.length).toBeLessThan(msgs.length)
  })

  it('passes the abort signal to the summary request', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'summary' } as any)
    const controller = new AbortController()

    await compressMessages(padMessages(10), fakeModel, undefined, undefined, controller.signal)

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: controller.signal,
      }),
    )
  })

  it('compresses old structured tool results that exceed the recent-token window', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'tool result summary' } as any)
    const msgs: ModelMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'readFile', input: { path: 'old-a.txt' } }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'readFile',
            output: { type: 'text', value: 'a'.repeat(35_000) },
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call-2', toolName: 'readFile', input: { path: 'old-b.txt' } }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-2',
            toolName: 'readFile',
            output: { type: 'text', value: 'b'.repeat(35_000) },
          },
        ],
      },
      { role: 'user', content: 'What did those files contain?' },
      { role: 'assistant', content: 'They contained test data.' },
    ]

    const result = await compressMessages(msgs, fakeModel)

    expect(generateText).toHaveBeenCalledOnce()
    expect(result).not.toBe(msgs)
    expect(result[0].content).toContain('tool result summary')
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
    state.messages = padMessages(10)
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
    state.messages = padMessages(10)
    state.lastInputTokens = 999_999

    const cb = makeCallbacks()
    delete (cb as any).onCompressionProgress

    await expect(checkAndCompressContext(state, fakeModel, 1, cb)).resolves.toBeUndefined()
    expect(cb.onContextCompressed).toHaveBeenCalled()
  })

  it('resets lastInputTokens and sets expectCacheMiss after deep compression', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'summary' } as any)
    const state = createLoopState()
    state.messages = padMessages(10)
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
    state.messages = padMessages(10)

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
    state.messages = padMessages(10)

    await handleContextTooLong(state, fakeModel, makeCallbacks())

    expect(state.lastInputTokens).toBe(0)
    expect(state.expectCacheMiss).toBe(true)
  })

  it('bails (no retry) when compression cannot shrink the kept recent messages', async () => {
    // Anti-spin guard: tiny old history that summarizes to almost nothing, but
    // a huge message inside the KEEP_RECENT window that compression keeps
    // verbatim (mirrors a giant tool-result the provider rejected). Token count
    // barely drops → retrying would loop forever → must return false.
    vi.mocked(generateText).mockResolvedValue({ text: 'tiny summary' } as any)
    const state = createLoopState()
    const huge = 'z'.repeat(200_000)
    state.messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
      { role: 'user', content: 'e' },
      { role: 'assistant', content: 'f' },
      { role: 'user', content: 'g' },
      { role: 'assistant', content: huge }, // kept verbatim — the unshrinkable bloat
    ]

    const cb = makeCallbacks()
    const result = await handleContextTooLong(state, fakeModel, cb)

    expect(result).toBe(false)
    // Bailed before announcing a retry.
    expect(cb.onContextCompressed).not.toHaveBeenCalled()
  })
})
