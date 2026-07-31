// Tests for agent/messages.ts helpers
import { describe, expect, it } from 'vitest'

import {
  isToolErrorString,
  toolErrorFromUnknown,
  toolMediaUserMessage,
  toolResultMessage,
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

  it('switches to multimodal content output when images are supplied', () => {
    const msg = toolResultMessage('tc_2', 'browser_take_screenshot', '[image returned, image/png]', [
      { data: 'AAAA', mediaType: 'image/png' },
    ])
    const part = (msg.content as Array<{ output: { type: string; value: unknown } }>)[0]
    expect(part.output).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: '[image returned, image/png]' },
        { type: 'image-data', data: 'AAAA', mediaType: 'image/png' },
      ],
    })
  })

  it('keeps the plain text output when the images array is empty', () => {
    const msg = toolResultMessage('tc_3', 'shell', 'done', [])
    const part = (msg.content as Array<{ output: { type: string; value: string } }>)[0]
    expect(part.output).toEqual({ type: 'text', value: 'done' })
  })
})

describe('toolMediaUserMessage', () => {
  it('wraps base64 bytes in typed image parts instead of prompt text', () => {
    expect(toolMediaUserMessage([{ data: 'AAAA', mediaType: 'image/png' }])).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Attached media from tool result:' },
        {
          type: 'image',
          image: 'AAAA',
          mediaType: 'image/png',
        },
      ],
    })
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
  it('matches the tool error prefix', () => {
    expect(isToolErrorString('Error: anything')).toBe(true)
  })

  it('returns false for non-error strings', () => {
    expect(isToolErrorString('File written: foo.ts')).toBe(false)
    expect(isToolErrorString('')).toBe(false)
    expect(isToolErrorString('error: lower-case')).toBe(false)
  })
})
