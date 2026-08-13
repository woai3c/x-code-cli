import { describe, expect, it } from 'vitest'

import { stripTerminalControls } from '../src/peers/terminal-sanitize.js'

describe('stripTerminalControls', () => {
  it('strips ESC and C1 CSI sequences without removing their visible text', () => {
    expect(stripTerminalControls('plain\x1b[31mred\x1b[0m\u009b2Jtail')).toBe('plainredtail')
  })

  it('strips OSC 8 and OSC 52 through BEL, ST, and C1 ST terminators', () => {
    const value =
      'a\x1b]8;;https://evil.test\x1b\\link\x1b]8;;\x1b\\b' +
      '\x1b]52;c;Y2xpcGJvYXJk\x07c' +
      '\u009d52;c;bW9yZQ==\u009cd'
    expect(stripTerminalControls(value)).toBe('alinkbcd')
  })

  it('removes BEL, C0, DEL, C1, and dangerous bidi controls while preserving line breaks', () => {
    const controls = '\x00\x01\x07\x08\x09\x0b\x0c\x0e\x1f\x7f\u0080\u0085\u0096'
    const bidi = '\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069'
    expect(stripTerminalControls(`first\r\nsecond\rthird${controls}${bidi}end`)).toBe('first\nsecond\nthirdend')
  })

  it('preserves multiline CJK, emoji, variation selectors, and zero-width joiners', () => {
    const value = '你好，世界\nemoji: 👨‍👩‍👧‍👦 ❤️ 🧑🏽‍💻'
    expect(stripTerminalControls(value)).toBe(value)
  })

  it('drops unterminated control strings and incomplete escape sequences through EOF', () => {
    expect(stripTerminalControls('safe\x1b]52;c;unterminated')).toBe('safe')
    expect(stripTerminalControls('safe\x1b[31')).toBe('safe')
  })
})
