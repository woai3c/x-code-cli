import { countSpillRiskRows } from '../src/ui/chat-input/text-helpers.js'

// Spill-heal accounting: lines whose rendered tail lands at or near the
// right edge may wrap one row later than countContentRows predicted on
// some terminals (delayed-wrap phantom rows, wide/ambiguous width
// disagreement). The MINIMAL-WRITE commit path force-repaints that many
// top frame rows so spilled characters can't survive inside the frame.

const COLS = 80

describe('countSpillRiskRows', () => {
  it('returns 0 for short lines well clear of the right edge', () => {
    expect(countSpillRiskRows('short line\nanother one\n', COLS)).toBe(0)
  })

  it('flags a line whose width is an exact multiple of the terminal width', () => {
    expect(countSpillRiskRows('x'.repeat(COLS), COLS)).toBe(1)
    expect(countSpillRiskRows('x'.repeat(COLS * 2), COLS)).toBe(1)
  })

  it('flags a line ending within the safety margin of the edge', () => {
    expect(countSpillRiskRows('x'.repeat(COLS - 1), COLS)).toBe(1)
    expect(countSpillRiskRows('x'.repeat(COLS - 4), COLS)).toBe(1)
    expect(countSpillRiskRows('x'.repeat(COLS - 5), COLS)).toBe(0)
  })

  it('measures CJK lines by visual width, not code-unit length', () => {
    // 37 wide chars = 74 cells → clear of the edge; 40 chars = 80 → exact fit.
    expect(countSpillRiskRows('冒'.repeat(37), COLS)).toBe(0)
    expect(countSpillRiskRows('冒'.repeat(40), COLS)).toBe(1)
  })

  it('accumulates risk across lines', () => {
    const content = ['x'.repeat(COLS), 'safe', 'y'.repeat(COLS - 2)].join('\n')
    expect(countSpillRiskRows(content, COLS)).toBe(2)
  })

  it('always flags tab-containing lines (tab stops defeat width math)', () => {
    expect(countSpillRiskRows('a\tb', COLS)).toBe(1)
  })

  it('ignores ANSI styling when measuring width', () => {
    expect(countSpillRiskRows(`\x1b[1m${'x'.repeat(COLS)}\x1b[0m`, COLS)).toBe(1)
    expect(countSpillRiskRows('\x1b[1mshort\x1b[0m', COLS)).toBe(0)
  })

  it('does not count the empty segment after a trailing newline', () => {
    expect(countSpillRiskRows('safe\n', COLS)).toBe(0)
  })
})
