// Tests for agent/light-compact.ts
import { describe, expect, it } from 'vitest'

import type { ModelMessage } from 'ai'

import { lightCompactMessages } from '../src/agent/light-compact.js'

function toolResultMsg(toolCallId: string, text: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName: 'shell',
        output: { type: 'text', value: text },
      },
    ],
  } as ModelMessage
}

function assistantWithToolCall(toolCallId: string): ModelMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'calling shell' },
      { type: 'tool-call', toolCallId, toolName: 'shell', input: { command: 'ls' } },
    ],
  } as unknown as ModelMessage
}

describe('lightCompactMessages', () => {
  it('returns unchanged when there are no loop-guard notices', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      toolResultMsg('tc1', 'success output'),
    ]
    const out = lightCompactMessages(messages)
    expect(out.dropped).toBe(0)
    expect(out.messages).toBe(messages)
  })

  it('drops a tool-result whose payload starts with [loop-guard]', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hello' },
      assistantWithToolCall('tc1'),
      toolResultMsg('tc1', '[loop-guard] stop retrying'),
    ]
    const out = lightCompactMessages(messages)
    expect(out.dropped).toBeGreaterThan(0)
    // The tool-result message should be gone
    const hasToolResult = out.messages.some((m) => m.role === 'tool')
    expect(hasToolResult).toBe(false)
  })

  it('also strips the matching tool-call part from the preceding assistant message', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hello' },
      assistantWithToolCall('tc1'),
      toolResultMsg('tc1', '[loop-guard] blocked'),
    ]
    const out = lightCompactMessages(messages)
    const assistantMsg = out.messages.find((m) => m.role === 'assistant')
    if (assistantMsg && Array.isArray(assistantMsg.content)) {
      const parts = assistantMsg.content as Array<{ type?: string }>
      const hasToolCall = parts.some((p) => p.type === 'tool-call')
      expect(hasToolCall).toBe(false)
    }
  })

  it('drops an assistant message entirely if all its parts were tool-calls that got stripped', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'shell', input: { command: 'ls' } }],
      } as unknown as ModelMessage,
      toolResultMsg('tc1', '[loop-guard] blocked'),
    ]
    const out = lightCompactMessages(messages)
    const hasAssistant = out.messages.some((m) => m.role === 'assistant')
    expect(hasAssistant).toBe(false)
  })

  it('keeps unrelated tool-results intact', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hello' },
      assistantWithToolCall('good'),
      toolResultMsg('good', 'real output from a successful tool call'),
      assistantWithToolCall('bad'),
      toolResultMsg('bad', '[loop-guard] blocked retry'),
    ]
    const out = lightCompactMessages(messages)
    // 'good' tool-result must still be present
    const survivors = out.messages.filter((m) => m.role === 'tool')
    expect(survivors).toHaveLength(1)
    const survivor = survivors[0].content as Array<{ toolCallId?: string }>
    expect(survivor[0].toolCallId).toBe('good')
  })

  it('does not mutate the input array', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hello' },
      assistantWithToolCall('tc1'),
      toolResultMsg('tc1', '[loop-guard] blocked'),
    ]
    const before = messages.length
    lightCompactMessages(messages)
    expect(messages.length).toBe(before)
  })
})
