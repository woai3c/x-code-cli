// Tests for processToolCalls — ghost-call skip path
import { describe, expect, it, vi } from 'vitest'

import type { ModelMessage } from 'ai'

import { createLoopState } from '../src/agent/loop-state.js'
import { processToolCalls } from '../src/agent/tool-execution.js'
import type { AgentCallbacks, AgentOptions, LanguageModel } from '../src/types/index.js'

function makeCallbacks(overrides: Partial<AgentCallbacks> = {}): AgentCallbacks {
  return {
    onTextDelta: vi.fn(),
    onToolCall: vi.fn(),
    onToolProgress: vi.fn(),
    onToolResult: vi.fn(),
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

const options: AgentOptions = {
  modelId: 'test:model',
  trustMode: false,
  maxTurns: 10,
  printMode: false,
}

const stubModel = {} as LanguageModel

function assistantWithToolCalls(ids: string[]): ModelMessage {
  return {
    role: 'assistant',
    content: ids.map((toolCallId) => ({
      type: 'tool-call',
      toolCallId,
      toolName: 'askUser',
      input: { question: 'q', options: [{ label: 'a', description: 'a' }, { label: 'b', description: 'b' }] },
    })),
  } as ModelMessage
}

describe('processToolCalls ghost-call skip', () => {
  it('runs every tool when all ids appear in the assistant message', async () => {
    const state = createLoopState()
    state.messages.push(
      { role: 'user', content: 'hi' } as ModelMessage,
      assistantWithToolCalls(['tc-A', 'tc-B']),
    )
    const onAskUser = vi.fn().mockResolvedValue('a')
    const callbacks = makeCallbacks({ onAskUser })
    await processToolCalls(
      [
        { toolName: 'askUser', toolCallId: 'tc-A', input: { question: 'q', options: [{ label: 'a', description: 'a' }, { label: 'b', description: 'b' }] } },
        { toolName: 'askUser', toolCallId: 'tc-B', input: { question: 'q', options: [{ label: 'a', description: 'a' }, { label: 'b', description: 'b' }] } },
      ],
      state,
      options,
      callbacks,
      stubModel,
    )
    expect(onAskUser).toHaveBeenCalledTimes(2)
  })

  it('skips a ghost tool whose id is not in the assistant message', async () => {
    // Simulates the deepseek tool-error path: SDK rejected the tool_call
    // and excluded it from response.messages, but result.toolCalls still
    // surfaces it. We must NOT execute the ghost — for write/shell that
    // would be a real side effect for a call the model never committed.
    const state = createLoopState()
    state.messages.push(
      { role: 'user', content: 'hi' } as ModelMessage,
      assistantWithToolCalls(['tc-real']),
    )
    const onAskUser = vi.fn().mockResolvedValue('a')
    const callbacks = makeCallbacks({ onAskUser })
    await processToolCalls(
      [
        { toolName: 'askUser', toolCallId: 'tc-real', input: { question: 'q', options: [{ label: 'a', description: 'a' }, { label: 'b', description: 'b' }] } },
        { toolName: 'askUser', toolCallId: 'tc-ghost', input: { question: 'q', options: [{ label: 'a', description: 'a' }, { label: 'b', description: 'b' }] } },
      ],
      state,
      options,
      callbacks,
      stubModel,
    )
    expect(onAskUser).toHaveBeenCalledTimes(1)
    // No tool_result should have been pushed for the ghost — its
    // assistant message has no matching tool_call to anchor against.
    const ghostResult = state.messages.find(
      (m) =>
        m.role === 'tool' &&
        Array.isArray(m.content) &&
        (m.content as Array<{ toolCallId?: string }>).some((p) => p?.toolCallId === 'tc-ghost'),
    )
    expect(ghostResult).toBeUndefined()
  })

  it('falls back to running every tool when the assistant message has no tool_calls at all', async () => {
    // Edge case: if `activeIds` ends up empty we don't have evidence to
    // judge ghosts vs legit calls, so the conservative fallback runs
    // them all. The sanitizer still has the reverse-orphan check as
    // backstop.
    const state = createLoopState()
    state.messages.push(
      { role: 'user', content: 'hi' } as ModelMessage,
      { role: 'assistant', content: 'plain text reply' } as ModelMessage,
    )
    const onAskUser = vi.fn().mockResolvedValue('a')
    const callbacks = makeCallbacks({ onAskUser })
    await processToolCalls(
      [
        { toolName: 'askUser', toolCallId: 'tc-X', input: { question: 'q', options: [{ label: 'a', description: 'a' }, { label: 'b', description: 'b' }] } },
      ],
      state,
      options,
      callbacks,
      stubModel,
    )
    expect(onAskUser).toHaveBeenCalledTimes(1)
  })

  it('only inspects assistant messages from the current turn (stops at the previous user message)', async () => {
    // A tool_call id from an OLDER turn must not satisfy the activeIds
    // check for a CURRENT-turn ghost — turn boundaries are user-role
    // messages, so we walk back from end-of-messages and stop the first
    // time we see role==='user'. Without this stop, a ghost call could
    // sneak in by re-using a stale id.
    const state = createLoopState()
    state.messages.push(
      { role: 'user', content: 'turn 1' } as ModelMessage,
      assistantWithToolCalls(['old-id']),
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'old-id', toolName: 'askUser', output: { type: 'text', value: 'r' } },
        ],
      } as ModelMessage,
      { role: 'user', content: 'turn 2' } as ModelMessage,
      assistantWithToolCalls(['new-id']),
    )
    const onAskUser = vi.fn().mockResolvedValue('a')
    const callbacks = makeCallbacks({ onAskUser })
    await processToolCalls(
      [
        { toolName: 'askUser', toolCallId: 'new-id', input: { question: 'q', options: [{ label: 'a', description: 'a' }, { label: 'b', description: 'b' }] } },
        { toolName: 'askUser', toolCallId: 'old-id', input: { question: 'q', options: [{ label: 'a', description: 'a' }, { label: 'b', description: 'b' }] } },
      ],
      state,
      options,
      callbacks,
      stubModel,
    )
    // new-id runs; old-id is from a prior turn, must be treated as ghost.
    expect(onAskUser).toHaveBeenCalledTimes(1)
  })
})
