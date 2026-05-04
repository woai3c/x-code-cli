import { describe, expect, it } from 'vitest'

import { extractText } from '../src/utils/message-helpers.js'

describe('extractText', () => {
  it('returns string content as-is', () => {
    expect(extractText('hello world')).toBe('hello world')
  })

  it('extracts text from array of typed parts', () => {
    const content = [
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ]
    expect(extractText(content)).toBe('hello world')
  })

  it('filters out non-text parts', () => {
    const content = [
      { type: 'text', text: 'visible' },
      { type: 'image', image: 'data:...' },
      { type: 'tool-call', toolCallId: '1', toolName: 'readFile' },
      { type: 'text', text: ' text' },
    ]
    expect(extractText(content as any)).toBe('visible text')
  })

  it('returns empty string for empty array', () => {
    expect(extractText([])).toBe('')
  })

  it('returns empty string for non-string non-array content', () => {
    expect(extractText(undefined as any)).toBe('')
    expect(extractText(null as any)).toBe('')
    expect(extractText(42 as any)).toBe('')
  })

  it('handles parts with missing text field', () => {
    const content = [{ type: 'text' }, { type: 'text', text: 'ok' }]
    expect(extractText(content as any)).toBe('ok')
  })
})
