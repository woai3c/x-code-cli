import { PromptInputDecoder } from '../src/ui/chat-input/prompt-input-decoder.js'

describe('PromptInputDecoder', () => {
  it('separates batched text and Return input', () => {
    const decoder = new PromptInputDecoder()
    expect(decoder.push('abc\r')).toEqual([
      { type: 'normal', value: 'abc' },
      { type: 'normal', value: '\r' },
    ])
  })

  it('decodes repeated navigation keys from one chunk', () => {
    const decoder = new PromptInputDecoder()
    expect(decoder.push('\x1b[A\x1b[A')).toEqual([
      { type: 'normal', value: '\x1b[A' },
      { type: 'normal', value: '\x1b[A' },
    ])
  })

  it('reassembles a control sequence split across chunks', () => {
    const decoder = new PromptInputDecoder()
    expect(decoder.push('\x1b[')).toEqual([])
    expect(decoder.push('D')).toEqual([{ type: 'normal', value: '\x1b[D' }])
  })

  it('reassembles split bracketed-paste markers and normalizes line endings', () => {
    const decoder = new PromptInputDecoder()
    expect(decoder.push('\x1b[20')).toEqual([])
    expect(decoder.push('0~first\r\nsecond\x1b[20')).toEqual([])
    expect(decoder.push('1~')).toEqual([{ type: 'paste', value: 'first\nsecond' }])
  })

  it('flushes an incomplete standalone escape key', () => {
    const decoder = new PromptInputDecoder()
    expect(decoder.push('\x1b')).toEqual([])
    expect(decoder.flush()).toEqual([{ type: 'normal', value: '\x1b' }])
  })
})
