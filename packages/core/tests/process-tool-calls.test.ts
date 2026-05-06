// Tests for processToolCalls — ghost-call skip path
import { describe, expect, it, vi } from 'vitest'

import type { ModelMessage } from 'ai'

import { createLoopState } from '../src/agent/loop-state.js'
import { partitionToolCalls, processToolCalls } from '../src/agent/tool-execution.js'
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
      input: {
        question: 'q',
        options: [
          { label: 'a', description: 'a' },
          { label: 'b', description: 'b' },
        ],
      },
    })),
  } as ModelMessage
}

describe('processToolCalls ghost-call skip', () => {
  it('runs every tool when all ids appear in the assistant message', async () => {
    const state = createLoopState()
    state.messages.push({ role: 'user', content: 'hi' } as ModelMessage, assistantWithToolCalls(['tc-A', 'tc-B']))
    const onAskUser = vi.fn().mockResolvedValue('a')
    const callbacks = makeCallbacks({ onAskUser })
    await processToolCalls(
      [
        {
          toolName: 'askUser',
          toolCallId: 'tc-A',
          input: {
            question: 'q',
            options: [
              { label: 'a', description: 'a' },
              { label: 'b', description: 'b' },
            ],
          },
        },
        {
          toolName: 'askUser',
          toolCallId: 'tc-B',
          input: {
            question: 'q',
            options: [
              { label: 'a', description: 'a' },
              { label: 'b', description: 'b' },
            ],
          },
        },
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
    state.messages.push({ role: 'user', content: 'hi' } as ModelMessage, assistantWithToolCalls(['tc-real']))
    const onAskUser = vi.fn().mockResolvedValue('a')
    const callbacks = makeCallbacks({ onAskUser })
    await processToolCalls(
      [
        {
          toolName: 'askUser',
          toolCallId: 'tc-real',
          input: {
            question: 'q',
            options: [
              { label: 'a', description: 'a' },
              { label: 'b', description: 'b' },
            ],
          },
        },
        {
          toolName: 'askUser',
          toolCallId: 'tc-ghost',
          input: {
            question: 'q',
            options: [
              { label: 'a', description: 'a' },
              { label: 'b', description: 'b' },
            ],
          },
        },
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
        {
          toolName: 'askUser',
          toolCallId: 'tc-X',
          input: {
            question: 'q',
            options: [
              { label: 'a', description: 'a' },
              { label: 'b', description: 'b' },
            ],
          },
        },
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
        {
          toolName: 'askUser',
          toolCallId: 'new-id',
          input: {
            question: 'q',
            options: [
              { label: 'a', description: 'a' },
              { label: 'b', description: 'b' },
            ],
          },
        },
        {
          toolName: 'askUser',
          toolCallId: 'old-id',
          input: {
            question: 'q',
            options: [
              { label: 'a', description: 'a' },
              { label: 'b', description: 'b' },
            ],
          },
        },
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

function shellAssistant(ids: string[]): ModelMessage {
  return {
    role: 'assistant',
    content: ids.map((toolCallId) => ({
      type: 'tool-call',
      toolCallId,
      toolName: 'shell',
      input: { command: 'echo hi' },
    })),
  } as ModelMessage
}

function toolResult(
  toolCallId: string,
  toolName: string,
  value: string,
  type: 'text' | 'error-text' = 'text',
): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type, value },
      },
    ],
  } as ModelMessage
}

describe('processToolCalls skip-fulfilled (SDK already produced a tool-result)', () => {
  it('skips writeFile when the SDK auto-rejected it as unavailable', async () => {
    // Real failure case from the disk-info sub-agent in a.log: the
    // general-purpose agent's tool filter excluded writeFile, but the
    // model emitted a writeFile tool_call anyway. The SDK auto-emitted
    // an `error-text` tool-result for the unavailable tool. Without the
    // skip-fulfilled check we'd dispatch executeWriteTool by name (it
    // doesn't consult the filter), creating a real file AND pushing a
    // duplicate tool-result that DeepSeek then 400s on.
    const state = createLoopState()
    state.messages.push(
      { role: 'user', content: 'hi' } as ModelMessage,
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc-write',
            toolName: 'writeFile',
            input: { filePath: '/tmp/should-not-exist.txt', content: 'x' },
          },
        ],
      } as ModelMessage,
      toolResult('tc-write', 'writeFile', "Model tried to call unavailable tool 'writeFile'.", 'error-text'),
    )
    const askPermission = vi.fn().mockResolvedValue('yes')
    const callbacks = makeCallbacks({ onAskPermission: askPermission })
    await processToolCalls(
      [
        {
          toolName: 'writeFile',
          toolCallId: 'tc-write',
          input: { filePath: '/tmp/should-not-exist.txt', content: 'x' },
        },
      ],
      state,
      options,
      callbacks,
      stubModel,
    )
    // Permission must NOT have been asked — that would mean we were
    // about to run the tool.
    expect(askPermission).not.toHaveBeenCalled()
    // No second tool-result for tc-write should have been appended.
    const toolResults = state.messages.filter(
      (m) =>
        m.role === 'tool' &&
        Array.isArray(m.content) &&
        (m.content as Array<{ toolCallId?: string }>).some((p) => p?.toolCallId === 'tc-write'),
    )
    expect(toolResults).toHaveLength(1)
  })

  it('skips an auto-executed tool whose result already lives in state.messages', async () => {
    // readFile/grep/listDir/etc. are auto-executed by the SDK and their
    // result is in `response.messages` before processToolCalls runs.
    // Re-running here would either no-op (executeWriteOrShell returns
    // null for these names) or, in the worst case, trigger the
    // loop-guard which used to push a user message mid-iteration.
    const state = createLoopState()
    state.messages.push(
      { role: 'user', content: 'hi' } as ModelMessage,
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc-read',
            toolName: 'readFile',
            input: { filePath: '/x' },
          },
          {
            type: 'tool-call',
            toolCallId: 'tc-shell',
            toolName: 'shell',
            input: { command: 'echo manual' },
          },
        ],
      } as ModelMessage,
      toolResult('tc-read', 'readFile', '/x contents'),
    )
    const askPermission = vi.fn().mockResolvedValue('yes')
    const callbacks = makeCallbacks({ onAskPermission: askPermission })
    // shell will fail to spawn in tests (no real shell provider); we
    // only care that processToolCalls reaches it and does NOT try to
    // execute readFile a second time.
    await processToolCalls(
      [
        { toolName: 'readFile', toolCallId: 'tc-read', input: { filePath: '/x' } },
        { toolName: 'shell', toolCallId: 'tc-shell', input: { command: 'echo manual' } },
      ],
      state,
      options,
      callbacks,
      stubModel,
    ).catch(() => {})
    // Only one tool-result for tc-read should exist (the original).
    const readResults = state.messages.filter(
      (m) =>
        m.role === 'tool' &&
        Array.isArray(m.content) &&
        (m.content as Array<{ toolCallId?: string }>).some((p) => p?.toolCallId === 'tc-read'),
    )
    expect(readResults).toHaveLength(1)
  })

  it('runs consecutive task tool-calls in a single parallel batch', async () => {
    // The whole point of partition + Promise.all: 3 task tool-calls
    // emitted in one assistant turn must launch concurrently, not wait
    // for each previous one to finish. We don't have a real
    // subAgentRegistry in this test, so handleTask short-circuits to
    // '[Sub-agent system not initialized]' and pushToolResult fires
    // immediately for each. Track the order in which tool-results land
    // — for a parallel batch the registry-missing branch is synchronous
    // enough that all three fire before processToolCalls returns.
    const state = createLoopState()
    const ids = ['tc-task-1', 'tc-task-2', 'tc-task-3']
    state.messages.push(
      { role: 'user', content: 'hi' } as ModelMessage,
      {
        role: 'assistant',
        content: ids.map((toolCallId) => ({
          type: 'tool-call',
          toolCallId,
          toolName: 'task',
          input: { description: 'd', subagent_type: 'general-purpose', prompt: 'p' },
        })),
      } as ModelMessage,
    )
    const seen: string[] = []
    const callbacks = makeCallbacks({
      onToolResult: (id) => {
        seen.push(id)
      },
    })
    await processToolCalls(
      ids.map((toolCallId) => ({
        toolName: 'task',
        toolCallId,
        input: { description: 'd', subagent_type: 'general-purpose', prompt: 'p' },
      })),
      state,
      options,
      callbacks,
      stubModel,
    )
    expect(seen).toHaveLength(3)
    expect(new Set(seen)).toEqual(new Set(ids))
  })

  it('flushes deferred messages AFTER all tool-results — no user message between assistant and a tool result', async () => {
    // The bug we're guarding against: a user-role message inserted
    // between assistant.tool_calls and a later tool-result. DeepSeek
    // 400s with "Messages with role 'tool' must be a response to a
    // preceding message with 'tool_calls'". We test the deferred-flush
    // path indirectly by checking message-shape invariants after the
    // call returns.
    const state = createLoopState()
    state.messages.push(
      { role: 'user', content: 'hi' } as ModelMessage,
      shellAssistant(['tc-1', 'tc-2']),
      toolResult('tc-1', 'shell', 'first result'), // already fulfilled by SDK
    )
    const callbacks = makeCallbacks()
    await processToolCalls(
      [
        { toolName: 'shell', toolCallId: 'tc-1', input: { command: 'echo hi' } },
        { toolName: 'shell', toolCallId: 'tc-2', input: { command: 'echo bye' } },
      ],
      state,
      options,
      callbacks,
      stubModel,
    ).catch(() => {})
    // Walk the messages — every tool-role message must have an
    // assistant-role message earlier in the array (no user message
    // between an assistant.tool_calls and a tool result).
    let lastAssistantWithToolCalls = -1
    let lastUserMessage = -1
    for (let i = 0; i < state.messages.length; i++) {
      const m = state.messages[i]!
      if (m.role === 'user') lastUserMessage = i
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        const hasToolCall = (m.content as Array<{ type?: string }>).some((p) => p?.type === 'tool-call')
        if (hasToolCall) lastAssistantWithToolCalls = i
      }
      if (m.role === 'tool') {
        // The most-recent assistant.tool_calls must come AFTER the
        // most-recent user message.
        expect(lastAssistantWithToolCalls).toBeGreaterThan(lastUserMessage)
      }
    }
  })
})

describe('partitionToolCalls', () => {
  const tc = (toolName: string, toolCallId: string) => ({ toolName, toolCallId, input: {} })

  it('returns no batches for an empty list', () => {
    expect(partitionToolCalls([])).toEqual([])
  })

  it('puts every non-task tool in its own singleton batch', () => {
    const calls = [tc('shell', '1'), tc('writeFile', '2'), tc('edit', '3')]
    const batches = partitionToolCalls(calls)
    expect(batches.map((b) => b.length)).toEqual([1, 1, 1])
  })

  it('groups consecutive task tool-calls into a single batch', () => {
    const calls = [tc('task', '1'), tc('task', '2'), tc('task', '3')]
    const batches = partitionToolCalls(calls)
    expect(batches).toHaveLength(1)
    expect(batches[0]!.map((c) => c.toolCallId)).toEqual(['1', '2', '3'])
  })

  it('breaks the parallel batch when a non-task slips between tasks', () => {
    // [task, task, shell, task, task] →
    //   [[task, task], [shell], [task, task]]
    // The shell must run alone and serialize what comes before/after,
    // because shell mutates parent UI state (stdout streaming).
    const calls = [tc('task', '1'), tc('task', '2'), tc('shell', '3'), tc('task', '4'), tc('task', '5')]
    const batches = partitionToolCalls(calls)
    expect(batches.map((b) => b.map((c) => c.toolCallId))).toEqual([['1', '2'], ['3'], ['4', '5']])
  })

  it('handles a single task call as its own batch', () => {
    const batches = partitionToolCalls([tc('task', '1')])
    expect(batches).toEqual([[tc('task', '1')]])
  })

  it('keeps a trailing task batch separate from leading non-task work', () => {
    const calls = [tc('shell', '1'), tc('task', '2'), tc('task', '3')]
    const batches = partitionToolCalls(calls)
    expect(batches.map((b) => b.length)).toEqual([1, 2])
    expect(batches[1]!.map((c) => c.toolCallId)).toEqual(['2', '3'])
  })
})
