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
})
