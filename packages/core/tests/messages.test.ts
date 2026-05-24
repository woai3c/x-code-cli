// Tests for agent/messages.ts helpers
import { describe, expect, it } from 'vitest'

import {
  isToolErrorString,
  toolErrorFromUnknown,
  toolErrorString,
  toolResultMessage,
  userMessage,
} from '../src/agent/messages.js'

describe('toolResultMessage', () => {
  it('builds a tool-role message with one tool-result content part', () => {
    const msg = toolResultMessage('tc_1', 'shell', 'done')
    expect(msg.role).toBe('tool')
    expect(Array.isArray(msg.content)).toBe(true)
    const parts = msg.content as Array<{
      type: string
      toolCallId: string
      toolName: string
      output: { type: string; value: string }
    }>
    expect(parts).toHaveLength(1)
    expect(parts[0]).toEqual({
      type: 'tool-result',
      toolCallId: 'tc_1',
      toolName: 'shell',
      output: { type: 'text', value: 'done' },
    })
  })
})

describe('userMessage', () => {
  it('wraps a string', () => {
    expect(userMessage('hi')).toEqual({ role: 'user', content: 'hi' })
  })

  it('preserves a parts array', () => {
    const parts = [{ type: 'text' as const, text: 'hi' }]
    expect(userMessage(parts)).toEqual({ role: 'user', content: parts })
  })
})

describe('toolErrorFromUnknown', () => {
  it('extracts the message from an Error instance', () => {
    expect(toolErrorFromUnknown(new Error('disk full'))).toBe('Error: disk full')
  })

  it('stringifies non-Error values', () => {
    expect(toolErrorFromUnknown('plain string')).toBe('Error: plain string')
    expect(toolErrorFromUnknown(42)).toBe('Error: 42')
    expect(toolErrorFromUnknown(null)).toBe('Error: null')
    expect(toolErrorFromUnknown(undefined)).toBe('Error: undefined')
  })
})

describe('isToolErrorString', () => {
  it('matches the prefix produced by toolErrorString', () => {
    expect(isToolErrorString(toolErrorString('x'))).toBe(true)
    expect(isToolErrorString('Error: anything')).toBe(true)
  })

  it('returns false for non-error strings', () => {
    expect(isToolErrorString('File written: foo.ts')).toBe(false)
    expect(isToolErrorString('')).toBe(false)
    expect(isToolErrorString('error: lower-case')).toBe(false)
  })
})
