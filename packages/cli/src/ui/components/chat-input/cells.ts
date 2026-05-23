// Cell representation + cell-builders for the cell-diff renderer.
//
// Each frame is a 2D grid of Cell. The diff loop in ChatInput.tsx walks
// the grid and only emits SGR/text bytes for cells whose `(char, style)`
// pair changed since the previous frame. `width` lets the diff loop
// skip the trailing half of a CJK pair without re-emitting the glyph.
import { charWidth } from '../../text-width.js'
import { S_NONE } from './palette.js'

export interface Cell {
  char: string
  style: string
  width: number
}

export function cellsEqual(a: Cell, b: Cell): boolean {
  return a.char === b.char && a.style === b.style
}

/** Render a row of cells to a single ANSI-styled string (no cursor moves,
 *  no trailing erase). Used by the scrollback-commit inline-stream path
 *  so frame rows can be emitted as part of the `content + frame` stream. */
export function renderRowToAnsi(cells: Cell[]): string {
  let out = '\x1b[0m'
  let lastStyle = '\x1b[0m'
  for (const cell of cells) {
    if (cell.style !== lastStyle) {
      out += cell.style
      lastStyle = cell.style
    }
    out += cell.char
  }
  return out + '\x1b[0m'
}

export function textToCells(text: string, style: string): Cell[] {
  const cells: Cell[] = []
  for (const ch of text) cells.push({ char: ch, style, width: charWidth(ch) })
  return cells
}

/** Parse a string that already contains ANSI SGR escapes into Cell[]. Used
 *  by the select-options dialog's preview pane so a `/syntax` preview row
 *  built by render-diff (full of fg/bg color escapes) can be drawn into
 *  the cell buffer with each char carrying its correct active style.
 *
 *  Each cell's `style` is `\x1b[0m` followed by every SGR escape that's
 *  active at that point — the cell-diff emitter relies on each cell's
 *  style being self-contained (it just blits `cell.style` on transitions
 *  without first resetting), so we always lead with reset to wipe
 *  whatever the previous cell left in the terminal SGR state. SGR resets
 *  (`\x1b[0m` / `\x1b[m`) clear the active stack; non-reset escapes are
 *  appended (we don't bother diffing fg-vs-bg-vs-attr buckets, since
 *  ANSI itself handles late escapes overriding earlier ones — the row
 *  may emit a few redundant bytes, but it always renders correctly). */
export function ansiTextToCells(text: string): Cell[] {
  const cells: Cell[] = []
  const active: string[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\x1b' && text[i + 1] === '[') {
      let j = i + 2
      while (j < text.length && !/[A-Za-z]/.test(text[j]!)) j++
      if (j >= text.length) {
        // Unterminated — treat as literal and bail out of escape mode.
        i++
        continue
      }
      const escape = text.slice(i, j + 1)
      if (/^\x1b\[0?m$/.test(escape)) {
        active.length = 0
      } else if (/^\x1b\[[0-9;]*m$/.test(escape)) {
        active.push(escape)
      }
      // Non-SGR CSI sequences are simply skipped — none should appear
      // in our preview rows but we don't want them as visible text.
      i = j + 1
      continue
    }
    const style = active.length === 0 ? S_NONE : '\x1b[0m' + active.join('')
    cells.push({ char: ch, style, width: charWidth(ch) })
    i++
  }
  return cells
}
