// Width/path/ANSI helpers used by the ChatInput cell-diff renderer.
// `isWide` / `charWidth` / `visualWidth` / `sliceByWidth` live in
// `../../text-width.js` — the single source of truth for the chat-input
// frame, scrollback diff, and markdown table layout. The helpers below
// build on top of those primitives.
import { GLYPH_ELLIPSIS } from '../../terminal-glyphs.js'
import { charWidth, visualWidth } from '../../text-width.js'
import type { Cell } from './cells.js'

export function truncateCellRow(cells: Cell[], maxWidth: number): Cell[] {
  let w = 0
  for (let i = 0; i < cells.length; i++) {
    if (w + cells[i]!.width > maxWidth) {
      const truncated = cells.slice(0, i)
      if (w + 1 <= maxWidth) {
        truncated.push({ char: GLYPH_ELLIPSIS, style: cells[i]!.style, width: 1 })
      }
      return truncated
    }
    w += cells[i]!.width
  }
  return cells
}

/** Hard-wrap `cells` across up to `maxRows` rows of `maxWidth` width each.
 *  When content overflows the row budget, trims trailing cells from the
 *  last row and appends an ellipsis. Char-based wrap (no word boundaries)
 *  — same model as `truncateCellRow`, just multi-row. */
export function wrapCellsToRows(cells: Cell[], maxWidth: number, maxRows: number): Cell[][] {
  if (maxRows <= 0 || maxWidth <= 0) return []
  const rows: Cell[][] = []
  let current: Cell[] = []
  let currentWidth = 0
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!
    if (currentWidth + c.width > maxWidth) {
      rows.push(current)
      if (rows.length >= maxRows) {
        const last = rows[rows.length - 1]!
        let lastW = currentWidth
        const ellipsisStyle = last.length > 0 ? last[last.length - 1]!.style : c.style
        while (last.length > 0 && lastW + 1 > maxWidth) {
          lastW -= last.pop()!.width
        }
        last.push({ char: GLYPH_ELLIPSIS, style: ellipsisStyle, width: 1 })
        return rows
      }
      current = []
      currentWidth = 0
    }
    current.push(c)
    currentWidth += c.width
  }
  if (current.length > 0) rows.push(current)
  return rows
}

export function skipByWidth(str: string, skipCols: number): number {
  let w = 0,
    i = 0
  for (const ch of str) {
    if (w >= skipCols) break
    w += charWidth(ch)
    i += ch.length
  }
  return i
}

/** Truncate a slash-separated path FROM THE START so the basename always
 *  survives. `packages/core/src/agent/very-long-name.ts` → `…/agent/very-long-name.ts`.
 *  Only used by the @-completion menu — readers care about WHICH file far
 *  more than they care about its top-level package, so dropping leading
 *  directories preserves the most informative chars. Falls back to a
 *  tail-trim only when the basename itself overflows. */
export function truncatePathFromStart(p: string, maxCols: number): string {
  if (visualWidth(p) <= maxCols) return p
  const segs = p.split('/')
  const basename = segs[segs.length - 1] ?? ''
  // Basename alone overflows: tail-trim it (rare — basenames rarely exceed
  // a terminal width, but a single very-long file shouldn't crash render).
  if (visualWidth(basename) >= maxCols - 1) {
    return '…' + basename.slice(basename.length - Math.max(1, maxCols - 1))
  }
  let acc = basename
  for (let i = segs.length - 2; i >= 0; i--) {
    const next = segs[i] + '/' + acc
    if (visualWidth('…/' + next) > maxCols) break
    acc = next
  }
  return '…/' + acc
}

/** Strip ANSI CSI + OSC escape sequences so visual width math ignores them.
 *  Used to count how many TERMINAL rows a scrollback payload will occupy,
 *  which drives the pre-scroll line count — over/under-counting would leave
 *  visible gaps or let content overflow into the frame area. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
}

/** Count display rows that `content` will occupy when written at the top of
 *  a blank area. Accounts for line wrap at `termWidth` using visual (CJK-aware)
 *  widths. A trailing `\n` is not counted as a row (cursor just advances to
 *  the next row but that row has no content). */
export function countContentRows(content: string, termWidth: number): number {
  const clean = stripAnsi(content).replace(/\r\n/g, '\n').replace(/\r/g, '')
  const lines = clean.split('\n')
  const effective = clean.endsWith('\n') ? lines.slice(0, -1) : lines
  const w = Math.max(1, termWidth)
  let rows = 0
  for (const line of effective) {
    rows += Math.max(1, Math.ceil(visualWidth(line) / w))
  }
  return rows
}
