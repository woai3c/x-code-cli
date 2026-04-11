// Tests for message helpers
import { describe, expect, it } from 'vitest'

import { toolResultMessage, userMessage } from '../src/agent/messages.js'

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
