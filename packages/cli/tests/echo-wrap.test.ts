import { countContentRows } from '../src/ui/chat-input/text-helpers.js'
import { resetScrollbackSpacing, writeMessageToStdout } from '../src/ui/render/stdout-writer.js'
import { visualWidth } from '../src/ui/render/text-width.js'

// Regression: an over-wide echo line used to be left to the terminal's
// auto-wrap — the wrapped remainder row kept the bg behind its text but got
// no trailing padding, tearing the card's right edge. The echo now hard-wraps
// at cols-3 and pads every physical row to the full terminal width.

const COLS = 80
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;:]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '')

function echo(content: string): string {
  let out = ''
  writeMessageToStdout(
    (chunk) => {
      out += chunk
    },
    { id: 'u', role: 'user', content, timestamp: 0 },
  )
  return out
}

function physicalRows(out: string): string[] {
  const rows = stripAnsi(out).replace(/\r\n/g, '\n').split('\n')
  // Drop the trailing empty segment produced by the final newline.
  if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop()
  return rows
}

describe('user echo card wrapping', () => {
  let originalColumns: number | undefined

  beforeEach(() => {
    resetScrollbackSpacing()
    originalColumns = process.stdout.columns
    Object.defineProperty(process.stdout, 'columns', { value: COLS, configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true })
  })

  it('pads every physical row of a wrapped long CJK line to full width', () => {
    const out = echo(
      '我通过 /ps 命令来查看后台 shell 的时候，发现执行的时候只是打印了一下当前后台 shell 的执行情况，codex cli 也是这样的吗 还是说一直实时显示状态的 先确认我们产品和 codex cli 的实现是 /ps 只打印当前状态还是实时显示状态的  d:\\res\\codex',
    )
    const rows = physicalRows(out)
    // padRow + at least 2 wrapped text rows + padRow, plus the leading blank.
    expect(rows.filter((r) => r.length > 0).length).toBeGreaterThanOrEqual(4)
    for (const row of rows) {
      if (row.length === 0) continue
      // Printable cells stop one column short of the wrap column; the
      // in-span \x1b[K (stripped here) carries the bg to the right edge.
      expect(visualWidth(row)).toBe(COLS - 1)
    }
    // Row accounting used by the frame geometry must match reality.
    expect(countContentRows(out, COLS)).toBe(rows.length)
    // Bg is applied (dark card #3c3836 → 48;2;60;56;54) and the erase-to-EOL
    // rides inside the bg span so the last cell picks up the card color.
    expect(out).toContain('\x1b[48;2;60;56;54m')
    expect(out).toContain('\x1b[K\x1b[49m')
  })

  it('pads continuation rows of an explicit multi-line message', () => {
    const out = echo('第一行文本\nsecond line with ascii')
    const rows = physicalRows(out)
    expect(rows.filter((r) => r.length > 0).length).toBe(4)
    for (const row of rows) {
      if (row.length === 0) continue
      expect(visualWidth(row)).toBe(COLS - 1)
    }
    expect(countContentRows(out, COLS)).toBe(rows.length)
  })

  it('aligns wrapped continuation text under the first row text (3-cell prefix)', () => {
    const out = echo('x'.repeat(COLS)) // 80 ascii chars → wraps once at budget 76
    const rows = physicalRows(out).filter((r) => r.length > 0)
    expect(rows.length).toBe(4)
    expect(rows[1]!.startsWith(' ❯ ')).toBe(true)
    expect(rows[2]!.startsWith('   x')).toBe(true)
  })
})
