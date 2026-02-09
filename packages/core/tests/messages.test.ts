// Tests for message helpers
import { describe, expect, it } from 'vitest'

import { estimateTokens, toolResultMessage, userMessage } from '../src/agent/messages.js'

describe('userMessage', () => {
  it('creates a user message', () => {
    const msg = userMessage('hello')
    expect(msg).toEqual({ role: 'user', content: 'hello' })
  })
})

describe('toolResultMessage', () => {
  it('creates a tool result message with proper format', () => {
    const msg = toolResultMessage('call-1', 'readFile', 'file contents here')
    expect(msg.role).toBe('tool')
    expect(msg.content).toBeInstanceOf(Array)
    expect(msg.content[0]).toMatchObject({
      type: 'tool-result',
      toolCallId: 'call-1',
      toolName: 'readFile',
      output: { type: 'text', value: 'file contents here' },
    })
  })
})

describe('estimateTokens', () => {
  it('estimates tokens from simple text messages', () => {
    const messages = [
      { role: 'user' as const, content: 'hello world' }, // 11 chars / 4 = ~3 tokens
    ]
    const tokens = estimateTokens(messages)
    expect(tokens).toBe(Math.ceil(11 / 4))
  })

  it('estimates tokens from multiple messages', () => {
    const messages = [
      { role: 'user' as const, content: 'a'.repeat(100) },
      { role: 'assistant' as const, content: 'b'.repeat(200) },
    ]
    const tokens = estimateTokens(messages)
    expect(tokens).toBe(Math.ceil(300 / 4))
  })

  it('handles array content with text parts', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'hello' }],
      },
    ]
    const tokens = estimateTokens(messages)
    expect(tokens).toBe(Math.ceil(5 / 4))
  })

  it('returns 0 for empty messages', () => {
    expect(estimateTokens([])).toBe(0)
  })
})
