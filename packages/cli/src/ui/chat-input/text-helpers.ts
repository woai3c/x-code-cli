// Width/path/ANSI helpers used by the ChatInput cell-diff renderer.
// `isWide` / `charWidth` / `visualWidth` / `sliceByWidth` live in
// `../../text-width.js` — the single source of truth for the chat-input
// frame, scrollback diff, and markdown table layout. The helpers below
// build on top of those primitives.
import os from 'node:os'

import { stripTerminalControls } from '@x-code-cli/core'

import { GLYPH_ELLIPSIS } from '../render/terminal-glyphs.js'
import { charWidth, sliceByWidth, visualWidth } from '../render/text-width.js'
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

function parseCrossPlatformPath(raw: string): {
  prefix: string
  segments: string[]
  normalized: string
  isWindows: boolean
} {
  const slashed = raw.replace(/\\/g, '/')
  const uncMatch = slashed.match(/^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/)
  if (uncMatch) {
    const prefix = `//${uncMatch[1]}/${uncMatch[2]}`
    const rest = uncMatch[3] ?? ''
    const segments = rest.split('/').filter(Boolean)
    const normalized = segments.length > 0 ? `${prefix}/${segments.join('/')}` : prefix
    return { prefix, segments, normalized, isWindows: true }
  }
  const driveMatch = slashed.match(/^([a-zA-Z]:)(?:\/(.*))?$/)
  if (driveMatch) {
    const drive = driveMatch[1]!
    const rest = driveMatch[2] ?? ''
    const segments = rest.split('/').filter(Boolean)
    const normalized = segments.length > 0 ? `${drive}/${segments.join('/')}` : `${drive}/`
    return { prefix: `${drive}/`, segments, normalized, isWindows: true }
  }
  if (slashed.startsWith('/')) {
    const segments = slashed.slice(1).split('/').filter(Boolean)
    const normalized = segments.length > 0 ? `/${segments.join('/')}` : '/'
    return { prefix: '/', segments, normalized, isWindows: false }
  }
  const segments = slashed.split('/').filter(Boolean)
  return { prefix: '', segments, normalized: segments.join('/'), isWindows: false }
}

function safeHomeDir(): string {
  try {
    return os.homedir()
  } catch {
    return ''
  }
}

function sanitizeSingleLinePath(value: string): string {
  return stripTerminalControls(value.replace(/[\r\n\t]+/g, ' ')).replace(/\n+/g, ' ')
}

/** Format a working-directory path for the single-line status footer.
 *  Contracts the user's home directory to `~`, preserves up to the trailing two
 *  directory segments (`~/…/parent/leaf`), and degrades gracefully down to the
 *  leaf directory name as `maxCols` shrinks. Returns `''` when budget is too
 *  small to display a recognizable name. */
export function formatCwdForFooter(cwd: string, maxCols: number, homeDir?: string): string {
  if (!cwd || maxCols <= 0) return ''
  const cleanCwd = sanitizeSingleLinePath(cwd)
  if (!cleanCwd) return ''
  const resolvedHome = homeDir !== undefined ? homeDir : safeHomeDir()
  const cleanHome = resolvedHome ? sanitizeSingleLinePath(resolvedHome) : ''

  const parsedCwd = parseCrossPlatformPath(cleanCwd)
  const parsedHome = cleanHome ? parseCrossPlatformPath(cleanHome) : null

  let candidates: string[] | null = null
  if (parsedHome && parsedHome.prefix !== '' && (parsedHome.segments.length > 0 || parsedHome.prefix !== '/')) {
    const caseInsensitive = parsedCwd.isWindows || parsedHome.isWindows
    const cwdKey = caseInsensitive ? parsedCwd.normalized.toLowerCase() : parsedCwd.normalized
    const homeBase = parsedHome.normalized.replace(/\/$/, '')
    const homeKey = caseInsensitive ? homeBase.toLowerCase() : homeBase
    if (cwdKey === (caseInsensitive ? parsedHome.normalized.toLowerCase() : parsedHome.normalized)) {
      candidates = ['~']
    } else if (homeKey.length > 0 && cwdKey.startsWith(`${homeKey}/`)) {
      const relSegs = parsedCwd.segments.slice(parsedHome.segments.length)
      if (relSegs.length === 1) {
        candidates = [`~/${relSegs[0]!}`, relSegs[0]!]
      } else if (relSegs.length === 2) {
        candidates = [`~/${relSegs[0]!}/${relSegs[1]!}`, `~/${GLYPH_ELLIPSIS}/${relSegs[1]!}`, relSegs[1]!]
      } else if (relSegs.length > 2) {
        const parent = relSegs[relSegs.length - 2]!
        const leaf = relSegs[relSegs.length - 1]!
        candidates = [`~/${GLYPH_ELLIPSIS}/${parent}/${leaf}`, `~/${GLYPH_ELLIPSIS}/${leaf}`, leaf]
      }
    }
  }

  if (!candidates) {
    const { prefix, segments } = parsedCwd
    const joinPrefix = prefix.endsWith('/') || !prefix ? prefix : `${prefix}/`
    if (segments.length === 0) {
      candidates = [prefix || cleanCwd]
    } else if (segments.length === 1) {
      candidates = [`${joinPrefix}${segments[0]!}`, segments[0]!]
    } else if (segments.length === 2) {
      candidates = [
        `${joinPrefix}${segments[0]!}/${segments[1]!}`,
        `${joinPrefix}${GLYPH_ELLIPSIS}/${segments[1]!}`,
        segments[1]!,
      ]
    } else {
      const parent = segments[segments.length - 2]!
      const leaf = segments[segments.length - 1]!
      candidates = [`${joinPrefix}${GLYPH_ELLIPSIS}/${parent}/${leaf}`, `${joinPrefix}${GLYPH_ELLIPSIS}/${leaf}`, leaf]
    }
  }

  for (const candidate of candidates) {
    if (visualWidth(candidate) <= maxCols) return candidate
  }
  const fallbackLeaf = candidates[candidates.length - 1]!
  if (maxCols >= 8) {
    const sliced = sliceByWidth(fallbackLeaf, maxCols - 1)
    return sliced ? `${sliced}${GLYPH_ELLIPSIS}` : ''
  }
  return ''
}

/** Format live or finalized token generation throughput for the footer. */
export function formatTokenSpeed(speed: { tokensPerSecond: number; isEstimate: boolean }): string {
  const { tokensPerSecond, isEstimate } = speed
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return ''
  if (isEstimate) {
    return `~${Math.max(1, Math.round(tokensPerSecond))} tok/s`
  }
  if (tokensPerSecond >= 100) {
    return `${Math.round(tokensPerSecond)} tok/s`
  }
  return `${tokensPerSecond.toFixed(1)} tok/s`
}

export function sameFormattedTokenSpeed(
  a: { tokensPerSecond: number; isEstimate: boolean } | null | undefined,
  b: { tokensPerSecond: number; isEstimate: boolean } | null | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.isEstimate === b.isEstimate && formatTokenSpeed(a) === formatTokenSpeed(b)
}

/** Strip ANSI CSI + OSC escape sequences so visual width math ignores them.
 *  Used to count how many TERMINAL rows a scrollback payload will occupy,
 *  which drives the pre-scroll line count — over/under-counting would leave
 *  visible gaps or let content overflow into the frame area. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
}

/** Count frame-top rows that may have been physically overwritten by a
 *  scrollback commit whose row count was under-estimated. The MINIMAL-WRITE
 *  commit path writes content directly above the live frame; when the
 *  terminal wraps a line one row later than countContentRows predicted, the
 *  wrapped tail spills onto the frame's top rows. The cell-diff loop can't
 *  see the spill — it diffs against the in-memory prevFrame, not the screen
 *  — so it rewrites only cells that differ, leaving the spill's first
 *  column and tail characters painted inside frame rows.
 *
 *  A line is a spill risk when its tail lands at or near the right edge:
 *  an exact multiple of `termWidth` triggers the delayed-wrap corner some
 *  terminals materialize as a real row (conhost / Windows Terminal — see
 *  writeUserMessage's last-column guard), and a line ending within a few
 *  cells of the edge wraps one row late on terminals whose wide/ambiguous
 *  widths disagree with our table (the common CJK case). Tabs are always
 *  risky: charWidth counts `\t` as 1 cell but the terminal jumps to the
 *  next 8-col stop, so any computed wrap point is unreliable. */
export function countSpillRiskRows(content: string, termWidth: number): number {
  const clean = stripAnsi(content).replace(/\r\n/g, '\n').replace(/\r/g, '')
  const w = Math.max(1, termWidth)
  const margin = Math.min(4, w - 1)
  let risk = 0
  for (const line of clean.split('\n')) {
    if (line.includes('\t')) {
      risk++
      continue
    }
    const width = visualWidth(line)
    if (width === 0) continue
    const rem = width % w
    if (rem === 0 || rem >= w - margin) risk++
  }
  return risk
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
