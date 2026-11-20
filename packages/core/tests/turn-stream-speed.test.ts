import { createLoopState } from '../src/agent/loop-state.js'
import { createStreamAttemptControl } from '../src/agent/stream-retry.js'
import {
  type StepSpeedAccumulator,
  type StreamAttemptTracker,
  collectTurnResponse,
  computeTurnSpeedSample,
  streamChunksToUI,
} from '../src/agent/turn-stream.js'
import type { AgentCallbacks, AgentOptions, TokenSpeedUpdate } from '../src/types/index.js'

vi.mock('../src/agent/session/session-store.js', () => ({
  appendUsage: vi.fn().mockResolvedValue(undefined),
}))

describe('token speed tracking', () => {
  it('excludes TTFT when a real streaming decode window exists', () => {
    // 2000ms TTFT + 1000ms decode for 80 tokens -> 80 tok/s (not 80 / 3s = 26.7 tok/s)
    const sample = computeTurnSpeedSample({
      requestStartedAtMs: 1000,
      firstOutputChunkAtMs: 3000,
      streamEndedAtMs: 4000,
      sawReasoningDelta: false,
      outputTokens: 80,
      reasoningTokens: 0,
    })
    expect(sample).toEqual({ tokens: 80, durationMs: 1000 })
  })

  it('prevents silent server-side reasoning from inflating visible decode tok/s', () => {
    // Provider thought silently for 5s (500 reasoning tokens), then streamed 100 visible tokens in 1s.
    const sample = computeTurnSpeedSample({
      requestStartedAtMs: 0,
      firstOutputChunkAtMs: 5000,
      streamEndedAtMs: 6000,
      sawReasoningDelta: false,
      outputTokens: 600,
      reasoningTokens: 500,
    })
    expect(sample).toEqual({ tokens: 100, durationMs: 1000 })

    // If almost all tokens were silent reasoning (only 1 visible token), fall back to E2E window.
    const fallback = computeTurnSpeedSample({
      requestStartedAtMs: 0,
      firstOutputChunkAtMs: 5000,
      streamEndedAtMs: 6000,
      sawReasoningDelta: false,
      outputTokens: 501,
      reasoningTokens: 500,
    })
    expect(fallback).toEqual({ tokens: 501, durationMs: 6000 })
  })

  it('keeps full outputTokens when reasoning deltas were actually streamed', () => {
    const sample = computeTurnSpeedSample({
      requestStartedAtMs: 0,
      firstOutputChunkAtMs: 500,
      streamEndedAtMs: 2500,
      sawReasoningDelta: true,
      outputTokens: 300,
      reasoningTokens: 200,
    })
    expect(sample).toEqual({ tokens: 300, durationMs: 2000 })
  })

  it('falls back to E2E duration for single-burst responses and ignores sub-threshold noise', () => {
    // Single-chunk tool call arriving 400ms after request start (decode window = 0ms)
    expect(
      computeTurnSpeedSample({
        requestStartedAtMs: 100,
        firstOutputChunkAtMs: 500,
        streamEndedAtMs: 500,
        sawReasoningDelta: false,
        outputTokens: 40,
        reasoningTokens: 0,
      }),
    ).toEqual({ tokens: 40, durationMs: 400 })

    // Instant 2ms canned mock response -> ignored
    expect(
      computeTurnSpeedSample({
        requestStartedAtMs: 100,
        firstOutputChunkAtMs: 101,
        streamEndedAtMs: 102,
        sawReasoningDelta: false,
        outputTokens: 100,
        reasoningTokens: 0,
      }),
    ).toBeNull()

    // Fewer than 3 output tokens -> ignored
    expect(
      computeTurnSpeedSample({
        requestStartedAtMs: 0,
        firstOutputChunkAtMs: 100,
        streamEndedAtMs: 500,
        sawReasoningDelta: false,
        outputTokens: 2,
        reasoningTokens: 0,
      }),
    ).toBeNull()
  })

  it('emits throttled live estimates during streaming, transitions to exact speed, and excludes tool wait', async () => {
    let clock = 0
    const now = () => clock
    const updates: TokenSpeedUpdate[] = []
    const state = createLoopState()
    const stepSpeed: StepSpeedAccumulator = { outputTokens: 0, durationMs: 0 }
    const callbacks = {
      onTextDelta: vi.fn(),
      onToolCall: vi.fn(),
      onToolProgress: vi.fn(),
      onToolResult: vi.fn(),
      onUsageUpdate: vi.fn(),
      onTokenSpeedUpdate: (u: TokenSpeedUpdate) => updates.push(u),
    } as unknown as AgentCallbacks

    // Turn 1: 500ms TTFT, then 1000ms streaming -> 100 exact output tokens (= 100 tok/s)
    const tracker1: StreamAttemptTracker = {
      visibleText: '',
      toolActivity: false,
      receivedData: false,
      suppressedReplay: false,
      requestStartedAtMs: 0,
    }
    const control1 = createStreamAttemptControl(undefined, 0)
    const stream1 = (async function* () {
      clock = 500
      yield { type: 'text-delta', text: 'a'.repeat(60) } // t_first = 500
      clock = 700
      yield { type: 'text-delta', text: 'b'.repeat(60) } // elapsed 200ms < 300ms -> no live emit yet
      clock = 950
      yield { type: 'text-delta', text: 'c'.repeat(60) } // elapsed 450ms >= 300ms -> live emit #1
      clock = 1100
      yield { type: 'text-delta', text: 'd'.repeat(60) } // +150ms < 400ms throttle -> throttled
      clock = 1500
      yield { type: 'text-delta', text: 'e'.repeat(60) } // +550ms >= 400ms -> live emit (if rounded differs)
    })()

    await streamChunksToUI(
      { stream: stream1 } as never,
      callbacks,
      state,
      {} as AgentOptions,
      tracker1,
      control1,
      '',
      false,
      stepSpeed,
      now,
    )
    control1.dispose()

    expect(updates.length).toBeGreaterThanOrEqual(1)
    expect(updates.every((u) => u.isEstimate)).toBe(true)

    await collectTurnResponse(
      {
        stream: stream1,
        response: Promise.resolve({ messages: [{ role: 'assistant', content: 'done' }] }),
        usage: Promise.resolve({ inputTokens: 200, outputTokens: 100 }),
        finishReason: Promise.resolve('tool-calls'),
        toolCalls: Promise.resolve([]),
      } as never,
      state,
      'openai:gpt-6.2-sol',
      callbacks,
      [],
      '',
      false,
      new Date(0).toISOString(),
      null,
      tracker1,
      stepSpeed,
      now,
    )

    expect(updates[updates.length - 1]).toEqual({ tokensPerSecond: 100, isEstimate: false })

    // Simulate a 10-second shell tool execution gap between Turn 1 and Turn 2
    clock = 11_500

    // Turn 2: 200ms TTFT, 500ms decode for 25 exact tokens (= 50 tok/s alone, combined = 125 / 1.5s = 83.33 tok/s)
    const tracker2: StreamAttemptTracker = {
      visibleText: '',
      toolActivity: false,
      receivedData: false,
      suppressedReplay: false,
      requestStartedAtMs: clock,
    }
    const control2 = createStreamAttemptControl(undefined, 0)
    const stream2 = (async function* () {
      clock = 11_700
      yield { type: 'text-delta', text: 'hello ' }
      clock = 12_200
      yield { type: 'text-delta', text: 'world!' }
    })()

    await streamChunksToUI(
      { stream: stream2 } as never,
      callbacks,
      state,
      {} as AgentOptions,
      tracker2,
      control2,
      '',
      false,
      stepSpeed,
      now,
    )
    control2.dispose()

    await collectTurnResponse(
      {
        stream: stream2,
        response: Promise.resolve({ messages: [{ role: 'assistant', content: 'hello world!' }] }),
        usage: Promise.resolve({ inputTokens: 250, outputTokens: 25 }),
        finishReason: Promise.resolve('stop'),
        toolCalls: Promise.resolve([]),
      } as never,
      state,
      'openai:gpt-6.2-sol',
      callbacks,
      [],
      '',
      false,
      new Date(0).toISOString(),
      null,
      tracker2,
      stepSpeed,
      now,
    )

    const finalUpdate = updates[updates.length - 1]!
    expect(finalUpdate.isEstimate).toBe(false)
    expect(finalUpdate.tokensPerSecond).toBeCloseTo(125 / 1.5, 5)
  })

  it('does not emit token speed updates from sub-agents', async () => {
    let clock = 0
    const onTokenSpeedUpdate = vi.fn()
    const subAgentState = createLoopState('default', { agentRole: 'sub-agent' })
    const tracker: StreamAttemptTracker = {
      visibleText: '',
      toolActivity: false,
      receivedData: false,
      suppressedReplay: false,
      requestStartedAtMs: 0,
    }
    const control = createStreamAttemptControl(undefined, 0)
    const stream = (async function* () {
      clock = 100
      yield { type: 'text-delta', text: 'x'.repeat(120) }
      clock = 700
      yield { type: 'text-delta', text: 'y'.repeat(120) }
    })()
    const callbacks = {
      onTextDelta: vi.fn(),
      onToolCall: vi.fn(),
      onToolProgress: vi.fn(),
      onToolResult: vi.fn(),
      onUsageUpdate: vi.fn(),
      onTokenSpeedUpdate,
    } as unknown as AgentCallbacks

    await streamChunksToUI(
      { stream } as never,
      callbacks,
      subAgentState,
      {} as AgentOptions,
      tracker,
      control,
      '',
      false,
      undefined,
      () => clock,
    )
    control.dispose()
    await collectTurnResponse(
      {
        stream,
        response: Promise.resolve({ messages: [] }),
        usage: Promise.resolve({ inputTokens: 50, outputTokens: 80 }),
        finishReason: Promise.resolve('stop'),
        toolCalls: Promise.resolve([]),
      } as never,
      subAgentState,
      'openai:gpt-6.2-sol',
      callbacks,
      [],
      '',
      false,
      new Date(0).toISOString(),
      null,
      tracker,
      undefined,
      () => clock,
    )

    expect(onTokenSpeedUpdate).not.toHaveBeenCalled()
  })

  it('excludes inline stream tool execution latency and emits live speed when process clock < 400ms', async () => {
    let clock = 10
    const now = () => clock
    const updates: TokenSpeedUpdate[] = []
    const state = createLoopState()
    const tracker: StreamAttemptTracker = {
      visibleText: '',
      toolActivity: false,
      receivedData: false,
      suppressedReplay: false,
      requestStartedAtMs: 10,
    }
    const control = createStreamAttemptControl(undefined, 0)
    const callbacks = {
      onTextDelta: vi.fn(),
      onToolCall: vi.fn(),
      onToolProgress: vi.fn(),
      onToolResult: vi.fn(),
      onUsageUpdate: vi.fn(),
      onTokenSpeedUpdate: (u: TokenSpeedUpdate) => updates.push(u),
    } as unknown as AgentCallbacks

    // First chunk at 30ms, second at 350ms (elapsed 320ms >= 300ms, while absolute clock 350ms < 400ms),
    // tool-call finishes at 530ms (decode = 500ms), then inline tool executes for 2500ms until 3030ms.
    const stream = (async function* () {
      clock = 30
      yield { type: 'tool-input-delta', id: 'tc-1', delta: '{"query":"' + 'x'.repeat(40) }
      clock = 350
      yield { type: 'tool-input-delta', id: 'tc-1', delta: 'y'.repeat(40) + '"}' }
      clock = 530
      yield { type: 'tool-call', toolCallId: 'tc-1', toolName: 'toolSearch', input: { query: 'xy' } }
      yield { type: 'tool-call', toolCallId: 'tc-2', toolName: 'listMcpResources', input: { server: 'docs' } }
      clock = 3030
      yield { type: 'tool-result', toolCallId: 'tc-1', output: 'ok' }
    })()

    await streamChunksToUI(
      { stream } as never,
      callbacks,
      state,
      {} as AgentOptions,
      tracker,
      control,
      '',
      false,
      undefined,
      now,
    )
    control.dispose()

    expect(updates.length).toBe(1)
    expect(updates[0]!.isEstimate).toBe(true)
    expect(tracker.streamEndedAtMs).toBe(530)

    await collectTurnResponse(
      {
        stream,
        response: Promise.resolve({ messages: [] }),
        usage: Promise.resolve({ inputTokens: 100, outputTokens: 50 }),
        finishReason: Promise.resolve('tool-calls'),
        toolCalls: Promise.resolve([]),
      } as never,
      state,
      'openai:gpt-6.2-sol',
      callbacks,
      [],
      '',
      false,
      new Date(0).toISOString(),
      null,
      tracker,
      undefined,
      now,
    )

    // 50 tokens over 500ms decode (530 - 30) = 100 tok/s, unaffected by the 2500ms inline tool wait.
    expect(updates[updates.length - 1]).toEqual({ tokensPerSecond: 100, isEstimate: false })
  })
})
