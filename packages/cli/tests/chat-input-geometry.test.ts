import { describe, expect, it } from 'vitest'

import { computePostContentScrollRows, moveCursorVisual } from '../src/ui/components/chat-input/geometry.js'

describe('ChatInput large commit geometry', () => {
  it('reserves the frame rows after content taller than the viewport', () => {
    expect(computePostContentScrollRows(1, 40, 35, 38)).toBe(4)
  })

  it('scrolls only rows overlapping the frame for a long tool summary', () => {
    expect(computePostContentScrollRows(1, 36, 34, 38)).toBe(3)
  })

  it('does not scroll when committed content ends above the frame', () => {
    expect(computePostContentScrollRows(12, 9, 21, 38)).toBe(0)
  })
})

describe('moveCursorVisual (soft-wrap aware up/down)', () => {
  // 'abcdefghij|klmno' — one logical line wrapped into two visual lines.
  const wrapped = 'abcdefghijklmno'

  it('moves up one visual line within a soft-wrapped single line', () => {
    expect(moveCursorVisual(wrapped, 12, -1, 10)).toBe(2)
  })

  it('round-trips down to the same column', () => {
    expect(moveCursorVisual(wrapped, 2, 1, 10)).toBe(12)
  })

  it('returns null on the first visual line so Up falls through to history', () => {
    expect(moveCursorVisual(wrapped, 4, -1, 10)).toBeNull()
  })

  it('returns null on the last visual line so Down falls through to history', () => {
    expect(moveCursorVisual(wrapped, 12, 1, 10)).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(moveCursorVisual('', 0, -1, 10)).toBeNull()
    expect(moveCursorVisual('', 0, 1, 10)).toBeNull()
  })

  it('treats the wrap boundary as the next visual line leading position', () => {
    // Cursor at offset 10 = end of 'abcdefghij' = start of 'klmno'.
    // Ownership goes to the continuation line, so Up lands at column 0.
    expect(moveCursorVisual(wrapped, 10, -1, 10)).toBe(0)
  })

  it('moves across hard newlines and wrapped lines alike', () => {
    // raw: 'abc' + '\n' + 'defghijklm|no' (second raw line wraps at col 10)
    const text = 'abc\ndefghijklmno'
    // v2 'no' col 2 (raw offset 4+10+2=16, end of text) → v1 'defghijklm' col 2 → 4+2=6
    expect(moveCursorVisual(text, 16, -1, 10)).toBe(6)
    // v1 col 2 → v0 'abc' col 2
    expect(moveCursorVisual(text, 6, -1, 10)).toBe(2)
    // v0 → null (top edge)
    expect(moveCursorVisual(text, 2, -1, 10)).toBeNull()
    // v0 col 2 → v1 col 2
    expect(moveCursorVisual(text, 2, 1, 10)).toBe(6)
  })

  it('clamps the column when the target visual line is shorter', () => {
    // 'abcd' + '\n' + 'xy': from col 3 down lands at end of 'xy' (offset 5+2=7).
    expect(moveCursorVisual('abcd\nxy', 3, 1, 10)).toBe(7)
  })

  it('handles CJK wide chars (two terminal cells each)', () => {
    // 8 wide chars, width 16; vpWidth 10 → v0 = 5 chars, v1 = 3 chars.
    const cjk = '你好世界你好世界'
    // End of input (v1 col 3, display col 6) → v0 display col 6 = char 3.
    expect(moveCursorVisual(cjk, 8, -1, 10)).toBe(3)
    // Round-trip: v0 char 3 (display col 6) → v1 end.
    expect(moveCursorVisual(cjk, 3, 1, 10)).toBe(8)
    // Top edge still falls through.
    expect(moveCursorVisual(cjk, 2, -1, 10)).toBeNull()
  })
})
