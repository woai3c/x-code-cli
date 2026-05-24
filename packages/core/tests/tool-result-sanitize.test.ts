// Tests for agent/tool-result-sanitize.ts
import { describe, expect, it } from 'vitest'

import type { ModelMessage } from 'ai'

import { repairOrphanToolCalls, truncateToolResultsInMessages } from '../src/agent/tool-result-sanitize.js'

function assistantToolCallMsg(toolCallId: string, toolName: string): ModelMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId, toolName, input: {} }],
  } as ModelMessage
}

function toolResultMsg(toolCallId: string, toolName: string, value: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'text', value },
      },
    ],
  } as ModelMessage
}

function toolMsg(toolName: string, value: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'tc',
        toolName,
        output: { type: 'text', value },
      },
    ],
  } as ModelMessage
}

describe('truncateToolResultsInMessages', () => {
  it('truncates an oversized readFile result in place', () => {
    const huge = 'line\n'.repeat(5000) // 5000 lines, over default 2000
    const messages: ModelMessage[] = [toolMsg('readFile', huge)]
    truncateToolResultsInMessages(messages)
    const after = (messages[0].content as unknown as Array<{ output: { value: string } }>)[0].output.value
    expect(after.length).toBeLessThan(huge.length)
    expect(after).toMatch(/truncated/)
  })

  it('applies head-only policy to grep', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `match-${i}: something`).join('\n')
    const messages: ModelMessage[] = [toolMsg('grep', lines)]
    truncateToolResultsInMessages(messages)
    const after = (messages[0].content as unknown as Array<{ output: { value: string } }>)[0].output.value
    // grep policy is head-only; the tail should NOT be preserved
    expect(after).toContain('match-0')
    expect(after).not.toContain('match-1999')
  })

  it('leaves non-tool messages untouched', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'x'.repeat(100000) } as ModelMessage,
      toolMsg('readFile', 'short'),
    ]
    truncateToolResultsInMessages(messages)
    expect((messages[0].content as string).length).toBe(100000)
  })

  it('handles content-type output arrays with text entries', () => {
    const huge = 'x'.repeat(100000)
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc',
            toolName: 'readFile',
            output: {
              type: 'content',
              value: [{ type: 'text', text: huge }],
            },
          },
        ],
      } as ModelMessage,
    ]
    truncateToolResultsInMessages(messages)
    const entry = (messages[0].content as unknown as Array<{ output: { value: Array<{ text: string }> } }>)[0].output
      .value[0]
    expect(entry.text.length).toBeLessThan(huge.length)
  })
})

describe('repairOrphanToolCalls', () => {
  it('appends a synthetic error result for an assistant tool_call with no result', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' } as ModelMessage,
      assistantToolCallMsg('tc1', 'todoWrite'),
    ]
    repairOrphanToolCalls(messages)
    expect(messages).toHaveLength(3)
    const synth = messages[2]
    expect(synth.role).toBe('tool')
    const part = (synth.content as unknown as Array<{ toolCallId: string; output: { value: string } }>)[0]
    expect(part.toolCallId).toBe('tc1')
    expect(part.output.value).toMatch(/Tool input failed validation/)
  })

  it('drops a tool_result whose toolCallId never appeared in any assistant message', () => {
    // SDK rejected the model's malformed tool input → no tool_call in
    // response.messages, but processToolCalls still ran the tool and
    // pushed a tool_result. The orphan must not survive into the next
    // API request body.
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' } as ModelMessage,
      { role: 'assistant', content: 'plain reply, no tool call' } as ModelMessage,
      toolResultMsg('orphan-id', 'todoWrite', 'Todo list updated.'),
    ]
    repairOrphanToolCalls(messages)
    expect(messages).toHaveLength(2)
    expect(messages[1].role).toBe('assistant')
  })

  it('keeps a tool_result whose toolCallId is fulfilled and drops only the orphan part', () => {
    // Mixed tool message: one valid result + one orphan in the same
    // tool message. Only the orphan should be filtered; the valid part
    // (and the surrounding message structure) must survive.
    const messages: ModelMessage[] = [
      assistantToolCallMsg('tc-valid', 'readFile'),
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc-valid',
            toolName: 'readFile',
            output: { type: 'text', value: 'file contents' },
          },
          {
            type: 'tool-result',
            toolCallId: 'tc-orphan',
            toolName: 'todoWrite',
            output: { type: 'text', value: 'orphan result' },
          },
        ],
      } as ModelMessage,
    ]
    repairOrphanToolCalls(messages)
    expect(messages).toHaveLength(2)
    const parts = messages[1].content as unknown as Array<{ toolCallId: string }>
    expect(parts).toHaveLength(1)
    expect(parts[0].toolCallId).toBe('tc-valid')
  })

  it('is idempotent — running twice produces the same result', () => {
    const messages: ModelMessage[] = [
      assistantToolCallMsg('tc1', 'todoWrite'),
      toolResultMsg('orphan', 'shell', 'orphan'),
    ]
    repairOrphanToolCalls(messages)
    const first = messages.length
    repairOrphanToolCalls(messages)
    expect(messages.length).toBe(first)
    // Forward-orphan synthetic result for tc1 must still be present.
    const ids = messages
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as unknown as Array<{ toolCallId?: string }>) : []))
      .map((p) => p.toolCallId)
      .filter(Boolean)
    expect(ids).toContain('tc1')
    expect(ids).not.toContain('orphan')
  })

  it('leaves a fully valid sequence untouched', () => {
    const messages: ModelMessage[] = [
      assistantToolCallMsg('tc1', 'readFile'),
      toolResultMsg('tc1', 'readFile', 'file body'),
      assistantToolCallMsg('tc2', 'shell'),
      toolResultMsg('tc2', 'shell', 'shell output'),
    ]
    const before = JSON.stringify(messages)
    repairOrphanToolCalls(messages)
    expect(JSON.stringify(messages)).toBe(before)
  })

  // Bug 1: tool message that's only orphan and sits between two
  // assistants must NOT be spliced — that would leave assistant→assistant,
  // which Anthropic 400s with "messages: roles must alternate". Replace
  // with a user-text placeholder instead.
  it('replaces empty-orphan tool message with user placeholder when between two assistants', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' } as ModelMessage,
      { role: 'assistant', content: [{ type: 'text', text: 'doing it' }] } as ModelMessage,
      toolResultMsg('orphan_1', 'shell', 'stale'),
      { role: 'assistant', content: [{ type: 'text', text: 'continued' }] } as ModelMessage,
    ]
    repairOrphanToolCalls(messages)
    expect(messages).toHaveLength(4)
    expect(messages[2].role).toBe('user')
    const blocks = messages[2].content as Array<{ type: string; text?: string }>
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.text).toMatch(/stale tool result/i)
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].role).not.toBe(messages[i - 1].role)
    }
  })

  // Bug 1 boundary: when at least one neighbor is not assistant,
  // dropping the orphan tool message is still the right call (no
  // assistant→assistant gap is created by the splice).
  it('still splices the orphan tool message when neighbors are not both assistant', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' } as ModelMessage,
      { role: 'assistant', content: [{ type: 'text', text: 'plain reply' }] } as ModelMessage,
      toolResultMsg('orphan_x', 'shell', 'stale'),
    ]
    repairOrphanToolCalls(messages)
    expect(messages).toHaveLength(2)
    expect(messages[1].role).toBe('assistant')
  })

  // Bug 2: multiple forward-orphan tool_calls must collapse into ONE
  // trailing tool message, not N adjacent tool messages. The Anthropic
  // SDK happens to merge consecutive same-role messages today, but the
  // Google converter does not — emitting one tool message is the
  // provider-agnostic safe shape.
  it('collapses multiple forward-orphan synthetics into a single tool message', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'do two things' } as ModelMessage,
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'tc_a', toolName: 'shell', input: {} },
          { type: 'tool-call', toolCallId: 'tc_b', toolName: 'shell', input: {} },
        ],
      } as ModelMessage,
    ]
    repairOrphanToolCalls(messages)
    const last = messages[messages.length - 1]
    expect(last.role).toBe('tool')
    const parts = last.content as unknown as Array<{ toolCallId: string }>
    expect(parts).toHaveLength(2)
    const ids = parts.map((p) => p.toolCallId).sort()
    expect(ids).toEqual(['tc_a', 'tc_b'])
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].role).not.toBe(messages[i - 1].role)
    }
  })

  // Bug 2 defense in depth: if a tool message already sits at the tail
  // (e.g. processToolCalls pushed real results for the fulfilled
  // tool_calls in the same turn), orphan synthetics merge into it
  // instead of producing a new adjacent tool message.
  it('merges synthetic results into an existing trailing tool message', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' } as ModelMessage,
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'tc_done', toolName: 'shell', input: {} },
          { type: 'tool-call', toolCallId: 'tc_orphan', toolName: 'shell', input: {} },
        ],
      } as ModelMessage,
      toolResultMsg('tc_done', 'shell', 'ok'),
    ]
    repairOrphanToolCalls(messages)
    expect(messages).toHaveLength(3)
    const last = messages[messages.length - 1]
    expect(last.role).toBe('tool')
    const parts = last.content as unknown as Array<{ toolCallId: string }>
    const ids = parts.map((p) => p.toolCallId).sort()
    expect(ids).toEqual(['tc_done', 'tc_orphan'])
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].role).not.toBe(messages[i - 1].role)
    }
  })
})
