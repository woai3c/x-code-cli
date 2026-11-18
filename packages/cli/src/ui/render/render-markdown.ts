// @x-code-cli/cli — Markdown-to-ANSI renderer (token-based)
//
// Port of Claude Code's formatToken() in src/utils/markdown.ts, adapted for
// direct stdout writing (no React/Ink wrapper). Uses marked.lexer() to parse
// Markdown into an AST, then recursively renders each token to ANSI-styled
// text using chalk.
//
// Style choices: h1 is bold+underline, h2/h3+ bold (Codex's scale — CC's
// bold+italic+underline triple-stack reads heavy). Blockquote uses
// U+258E ▎ as a muted prefix bar with italic text, code blocks emit raw
// text without indent, inline code and links use the brand `primary`
// token, list bullets sit on the `textDim` gray rung (color is reserved
// for semantics), and links become OSC 8 hyperlinks. All colors resolve
// through tokens.ts so `/theme` switches apply to committed markdown too.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { type Token, type Tokens, marked } from 'marked'

import { stripTerminalControls } from '@x-code-cli/core'

import { highlightCodeShiki } from './shiki-highlight.js'
import { detectFenceLanguage, highlightLine } from './syntax-highlight.js'
import { GLYPH_BLOCKQUOTE_BAR, GLYPH_LIST_BULLET } from './terminal-glyphs.js'
import { charWidth, graphemes } from './text-width.js'
import { chalk as c, paint } from './tokens.js'

const EOL = '\n'

const BLOCKQUOTE_BAR = GLYPH_BLOCKQUOTE_BAR

let markedConfigured = false
function configureMarked(): void {
  if (markedConfigured) return
  markedConfigured = true
  // Disable strikethrough: the model often writes ~N for "approximately N"
  // and almost never means real strikethrough. Matches Claude Code.
  marked.use({
    tokenizer: {
      del() {
        return undefined as any
      },
    },
  })
}

// Fast path: skip full lexer when the text contains no Markdown markers.
// Covers short plain-sentence assistant replies (the common case).
const MD_SYNTAX_RE = /[#*`|[>_~\-]|\n\n|^\d+\. |\n\d+\. /
function hasMarkdownSyntax(s: string): boolean {
  if (s.length > 500) return true
  return MD_SYNTAX_RE.test(s)
}

// Strip renderer-generated CSI and OSC 8 sequences so visual width
// calculations only count printable cells.
const ANSI_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g
function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '')
}

function safeHyperlinkHref(href: string): string | null {
  if (!href || href.length > 4096) return null
  try {
    const parsed = new URL(href)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

function numberToLetter(n: number): string {
  let result = ''
  while (n > 0) {
    n--
    result = String.fromCharCode(97 + (n % 26)) + result
    n = Math.floor(n / 26)
  }
  return result
}

const ROMAN_VALUES: ReadonlyArray<[number, string]> = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
]

function numberToRoman(n: number): string {
  let result = ''
  for (const [value, numeral] of ROMAN_VALUES) {
    while (n >= value) {
      result += numeral
      n -= value
    }
  }
  return result
}

function getListNumber(listDepth: number, orderedListNumber: number): string {
  switch (listDepth) {
    case 0:
    case 1:
      return orderedListNumber.toString()
    case 2:
      return numberToLetter(orderedListNumber)
    case 3:
      return numberToRoman(orderedListNumber)
    default:
      return orderedListNumber.toString()
  }
}

function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: 'left' | 'center' | 'right' | null | undefined,
): string {
  const padding = Math.max(0, targetWidth - displayWidth)
  if (align === 'center') {
    const leftPad = Math.floor(padding / 2)
    return ' '.repeat(leftPad) + content + ' '.repeat(padding - leftPad)
  }
  if (align === 'right') {
    return ' '.repeat(padding) + content
  }
  return content + ' '.repeat(padding)
}

// Table layout calls `visualWidth` / `graphemes` / `charWidth` from
// text-width.js — single source of truth so CJK headers and wrapped cells
// count consistently with the chat-input frame and scrollback diff.

interface CellTextStyle {
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  fg: string
  href: string
}

interface StyledGrapheme {
  char: string
  width: number
  style: CellTextStyle
}

interface WrappedCellLine {
  items: StyledGrapheme[]
  width: number
}

const CLOSING_PUNCT_RE = /^[，。！？、；：）》」』】〉”’,.!?;:)\]}]+$/
const SOFT_BREAK_DELIM_RE = /[\/\-_.:?&=]/

function parseStyledLines(ansiText: string, baseBold: boolean): StyledGrapheme[][] {
  const boldActive = baseBold && c.bold('x') !== 'x'
  const lines: StyledGrapheme[][] = [[]]
  let bold = boldActive
  let dim = false
  let italic = false
  let underline = false
  let fg = ''
  let href = ''

  let i = 0
  while (i < ansiText.length) {
    const ch = ansiText[i]!
    if (ch === '\x1b') {
      // OSC sequence: \x1b] ... (\x07 | \x1b\\)
      if (ansiText[i + 1] === ']') {
        let end = i + 2
        let termLen = 0
        while (end < ansiText.length) {
          if (ansiText[end] === '\x07') {
            termLen = 1
            break
          }
          if (ansiText[end] === '\x1b' && ansiText[end + 1] === '\\') {
            termLen = 2
            break
          }
          end++
        }
        if (termLen > 0) {
          const body = ansiText.slice(i + 2, end)
          if (body.startsWith('8;')) {
            const semi = body.indexOf(';', 2)
            href = semi >= 0 ? body.slice(semi + 1) : ''
          }
          i = end + termLen
          continue
        }
      }
      // CSI sequence: \x1b[ ... [@-~]
      if (ansiText[i + 1] === '[') {
        let end = i + 2
        while (end < ansiText.length) {
          const code = ansiText.charCodeAt(end)
          if (code >= 0x40 && code <= 0x7e) break
          end++
        }
        if (end < ansiText.length) {
          if (ansiText[end] === 'm') {
            const rawParams = ansiText.slice(i + 2, end)
            const codes = rawParams === '' ? [0] : rawParams.split(';').map((p) => (p === '' ? 0 : Number(p)))
            for (let k = 0; k < codes.length; k++) {
              const code = codes[k]!
              if (code === 0) {
                bold = boldActive
                dim = false
                italic = false
                underline = false
                fg = ''
              } else if (code === 1) {
                bold = true
              } else if (code === 2) {
                dim = true
              } else if (code === 22) {
                bold = boldActive
                dim = false
              } else if (code === 3) {
                italic = true
              } else if (code === 23) {
                italic = false
              } else if (code === 4) {
                underline = true
              } else if (code === 24) {
                underline = false
              } else if (code === 39) {
                fg = ''
              } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
                fg = `\x1b[${code}m`
              } else if (code === 38) {
                if (codes[k + 1] === 2) {
                  fg = `\x1b[38;2;${codes[k + 2] ?? 0};${codes[k + 3] ?? 0};${codes[k + 4] ?? 0}m`
                  k += 4
                } else if (codes[k + 1] === 5) {
                  fg = `\x1b[38;5;${codes[k + 2] ?? 0}m`
                  k += 2
                }
              }
            }
          }
          i = end + 1
          continue
        }
      }
      i++
      continue
    }

    if (ch === '\n') {
      lines.push([])
      i++
      continue
    }

    let nextSpecial = i
    while (nextSpecial < ansiText.length && ansiText[nextSpecial] !== '\x1b' && ansiText[nextSpecial] !== '\n') {
      nextSpecial++
    }
    const run = ansiText.slice(i, nextSpecial).replace(/\t/g, '  ')
    const styleSnapshot: CellTextStyle = { bold, dim, italic, underline, fg, href }
    const currentLine = lines[lines.length - 1]!
    for (const seg of graphemes(run)) {
      const w = charWidth(seg)
      if (w > 0) {
        currentLine.push({ char: seg, width: w, style: styleSnapshot })
      }
    }
    i = nextSpecial
  }

  return lines
}

function renderStyledGraphemes(items: StyledGrapheme[]): string {
  if (items.length === 0) return ''
  let out = ''
  let bold = false
  let dim = false
  let italic = false
  let underline = false
  let fg = ''
  let href = ''

  for (const item of items) {
    const s = item.style
    if (href && href !== s.href) {
      out += '\x1b]8;;\x1b\\'
      href = ''
    }
    // SGR 22 resets both bold and dim, so handle them together.
    if ((bold && !s.bold) || (dim && !s.dim)) {
      out += '\x1b[22m'
      bold = false
      dim = false
    }
    if (italic && !s.italic) {
      out += '\x1b[23m'
      italic = false
    }
    if (underline && !s.underline) {
      out += '\x1b[24m'
      underline = false
    }
    if (fg && !s.fg) {
      out += '\x1b[39m'
      fg = ''
    }
    if (!bold && s.bold) {
      out += '\x1b[1m'
      bold = true
    }
    if (!dim && s.dim) {
      out += '\x1b[2m'
      dim = true
    }
    if (!italic && s.italic) {
      out += '\x1b[3m'
      italic = true
    }
    if (!underline && s.underline) {
      out += '\x1b[4m'
      underline = true
    }
    if (s.fg && s.fg !== fg) {
      out += s.fg
      fg = s.fg
    }
    if (s.href && !href) {
      out += `\x1b]8;;${s.href}\x1b\\`
      href = s.href
    }
    out += item.char
  }

  if (href) out += '\x1b]8;;\x1b\\'
  if (fg) out += '\x1b[39m'
  if (underline) out += '\x1b[24m'
  if (italic) out += '\x1b[23m'
  if (bold || dim) out += '\x1b[22m'

  return out
}

function trimStyledLine(items: StyledGrapheme[]): StyledGrapheme[] {
  let start = 0
  let end = items.length
  while (start < end && items[start]!.char === ' ') start++
  while (end > start && items[end - 1]!.char === ' ') end--
  return start === 0 && end === items.length ? items : items.slice(start, end)
}

function lineVisualWidth(items: StyledGrapheme[]): number {
  let w = 0
  for (const item of items) w += item.width
  return w
}

function splitAtSoftDelimiters(items: StyledGrapheme[]): { items: StyledGrapheme[]; width: number }[] {
  const parts: { items: StyledGrapheme[]; width: number }[] = []
  let cur: StyledGrapheme[] = []
  let curW = 0
  for (let i = 0; i < items.length; i++) {
    const g = items[i]!
    cur.push(g)
    curW += g.width
    if (SOFT_BREAK_DELIM_RE.test(g.char) && i + 1 < items.length && !SOFT_BREAK_DELIM_RE.test(items[i + 1]!.char)) {
      parts.push({ items: cur, width: curW })
      cur = []
      curW = 0
    }
  }
  if (cur.length > 0) parts.push({ items: cur, width: curW })
  return parts
}

function sliceGraphemesByWidth(items: StyledGrapheme[], maxWidth: number): WrappedCellLine[] {
  const chunks: WrappedCellLine[] = []
  let cur: StyledGrapheme[] = []
  let curW = 0
  for (const g of items) {
    if (curW > 0 && curW + g.width > maxWidth) {
      chunks.push({ items: cur, width: curW })
      cur = []
      curW = 0
    }
    cur.push(g)
    curW += g.width
  }
  if (cur.length > 0) chunks.push({ items: cur, width: curW })
  return chunks
}

function wrapStyledLine(rawLine: StyledGrapheme[], colWidth: number): WrappedCellLine[] {
  const line = trimStyledLine(rawLine)
  if (line.length === 0) return [{ items: [], width: 0 }]
  const totalW = lineVisualWidth(line)
  if (totalW <= colWidth) return [{ items: line, width: totalW }]

  // Segment into spaces, individual wide (CJK/emoji) units, and narrow words,
  // keeping trailing closing punctuation attached to the preceding unit so a
  // wrapped CJK line doesn't start with a stray comma or period.
  const units: { isSpace: boolean; items: StyledGrapheme[]; width: number }[] = []
  let i = 0
  while (i < line.length) {
    const g = line[i]!
    if (g.char === ' ') {
      const sp: StyledGrapheme[] = []
      let spW = 0
      while (i < line.length && line[i]!.char === ' ') {
        sp.push(line[i]!)
        spW += line[i]!.width
        i++
      }
      units.push({ isSpace: true, items: sp, width: spW })
      continue
    }
    if (g.width > 1) {
      const grp: StyledGrapheme[] = [g]
      let grpW = g.width
      i++
      while (i < line.length && CLOSING_PUNCT_RE.test(line[i]!.char)) {
        grp.push(line[i]!)
        grpW += line[i]!.width
        i++
      }
      units.push({ isSpace: false, items: grp, width: grpW })
      continue
    }
    const word: StyledGrapheme[] = []
    let wordW = 0
    while (i < line.length && line[i]!.char !== ' ' && line[i]!.width <= 1) {
      word.push(line[i]!)
      wordW += line[i]!.width
      i++
    }
    while (i < line.length && CLOSING_PUNCT_RE.test(line[i]!.char)) {
      word.push(line[i]!)
      wordW += line[i]!.width
      i++
    }
    units.push({ isSpace: false, items: word, width: wordW })
  }

  const out: WrappedCellLine[] = []
  let curItems: StyledGrapheme[] = []
  let curWidth = 0
  let pendingSpaces: StyledGrapheme[] = []
  let pendingSpacesWidth = 0

  const flush = (): void => {
    if (curItems.length > 0) {
      out.push({ items: curItems, width: curWidth })
      curItems = []
      curWidth = 0
    }
    pendingSpaces = []
    pendingSpacesWidth = 0
  }

  const appendPiece = (piece: { items: StyledGrapheme[]; width: number }): void => {
    if (piece.width <= colWidth) {
      if (curWidth === 0) {
        curItems = [...piece.items]
        curWidth = piece.width
      } else if (curWidth + pendingSpacesWidth + piece.width <= colWidth) {
        curItems.push(...pendingSpaces, ...piece.items)
        curWidth += pendingSpacesWidth + piece.width
        pendingSpaces = []
        pendingSpacesWidth = 0
      } else {
        flush()
        curItems = [...piece.items]
        curWidth = piece.width
      }
      return
    }
    // Single delimiter-free piece exceeds colWidth — hard-wrap by grapheme.
    if (curWidth > 0) flush()
    const slices = sliceGraphemesByWidth(piece.items, colWidth)
    for (let s = 0; s < slices.length - 1; s++) {
      out.push(slices[s]!)
    }
    const last = slices[slices.length - 1]
    if (last) {
      curItems = last.items
      curWidth = last.width
    }
  }

  for (const unit of units) {
    if (unit.isSpace) {
      if (curWidth > 0) {
        pendingSpaces.push(...unit.items)
        pendingSpacesWidth += unit.width
      }
      continue
    }
    if (unit.width <= colWidth) {
      appendPiece(unit)
    } else {
      // Oversized token (long path, URL, identifier): break at `/`, `-`, `_`,
      // `.`, etc. first before falling back to grapheme-level slicing.
      const subParts = splitAtSoftDelimiters(unit.items)
      for (const sub of subParts) {
        appendPiece(sub)
      }
    }
  }

  flush()
  return out.length > 0 ? out : [{ items: [], width: 0 }]
}

function wrapCellLines(cellLines: StyledGrapheme[][], colWidth: number): WrappedCellLine[] {
  if (cellLines.length === 0) return [{ items: [], width: 0 }]
  const out: WrappedCellLine[] = []
  for (const line of cellLines) {
    out.push(...wrapStyledLine(line, colWidth))
  }
  return out.length > 0 ? out : [{ items: [], width: 0 }]
}

function headerMinTokenWidth(cellLines: StyledGrapheme[][]): number {
  let maxToken = 0
  for (const line of cellLines) {
    let run = 0
    for (const g of line) {
      if (g.char === ' ') {
        if (run > maxToken) maxToken = run
        run = 0
      } else if (g.width > 1) {
        if (run > maxToken) maxToken = run
        run = 0
        if (g.width > maxToken) maxToken = g.width
      } else {
        run += g.width
      }
    }
    if (run > maxToken) maxToken = run
  }
  return Math.min(maxToken, 12)
}

function allocateColumnWidths(
  naturalWidths: number[],
  headerMinWidths: number[],
  available: number,
  hardMin: number,
): number[] {
  const numCols = naturalWidths.length
  const desired = naturalWidths.map((w) => Math.max(hardMin, w))
  const desiredSum = desired.reduce((a, b) => a + b, 0)
  if (desiredSum <= available) return desired

  // Compact columns (<= 12 cells) keep their full width when room permits;
  // wider columns get a readable soft floor before proportional sharing.
  const floors = desired.map((d, i) =>
    d <= 12 ? d : Math.min(d, Math.max(hardMin, headerMinWidths[i] ?? hardMin, 10)),
  )
  let floorSum = floors.reduce((a, b) => a + b, 0)

  if (floorSum > available) {
    const widths = [...floors]
    while (floorSum > available) {
      let maxW = hardMin
      for (const w of widths) {
        if (w > maxW) maxW = w
      }
      if (maxW <= hardMin) break
      for (let i = numCols - 1; i >= 0 && floorSum > available; i--) {
        if (widths[i]! === maxW) {
          widths[i]!--
          floorSum--
        }
      }
    }
    return widths
  }

  const widths = [...floors]
  let remaining = available - floorSum
  const active = new Set<number>()
  for (let i = 0; i < numCols; i++) {
    if (widths[i]! < desired[i]!) active.add(i)
  }

  while (remaining > 0 && active.size > 0) {
    let totalWeight = 0
    for (const i of active) totalWeight += Math.sqrt(desired[i]!)

    let clampedAny = false
    for (const i of [...active]) {
      const share = (remaining * Math.sqrt(desired[i]!)) / totalWeight
      const cap = desired[i]! - widths[i]!
      if (share >= cap) {
        widths[i] = desired[i]!
        remaining -= cap
        active.delete(i)
        clampedAny = true
      }
    }
    if (clampedAny) continue

    const fractions: { idx: number; frac: number; want: number }[] = []
    let distributed = 0
    for (const i of active) {
      const exact = (remaining * Math.sqrt(desired[i]!)) / totalWeight
      const whole = Math.floor(exact)
      widths[i]! += whole
      distributed += whole
      fractions.push({ idx: i, frac: exact - whole, want: desired[i]! })
    }
    remaining -= distributed
    fractions.sort((a, b) => b.frac - a.frac || b.want - a.want)
    for (let k = 0; k < remaining && k < fractions.length; k++) {
      widths[fractions[k]!.idx]!++
    }
    remaining = 0
  }

  return widths
}

function renderVerticalTableCards(
  headerCells: StyledGrapheme[][][],
  bodyRows: StyledGrapheme[][][][],
  maxTableWidth: number,
): string {
  const TL = '\u250c',
    TR = '\u2510',
    BL = '\u2514',
    BR = '\u2518',
    ML = '\u251c',
    MR = '\u2524',
    H = '\u2500',
    V = '\u2502'
  const dim = paint('textMuted')
  const innerWidth = Math.max(2, maxTableWidth - 4)
  const top = dim(TL + H.repeat(innerWidth + 2) + TR) + EOL
  const mid = dim(ML + H.repeat(innerWidth + 2) + MR) + EOL
  const bot = dim(BL + H.repeat(innerWidth + 2) + BR) + EOL

  const emptyStyle: CellTextStyle = { bold: false, dim: false, italic: false, underline: false, fg: '', href: '' }
  const colonGraphemes = parseStyledLines(': ', false)[0] ?? []
  const records = bodyRows.length > 0 ? bodyRows : [headerCells]
  let out = top
  records.forEach((row, rowIdx) => {
    if (rowIdx > 0) out += mid
    for (let col = 0; col < headerCells.length; col++) {
      const hFlat =
        headerCells[col]?.flatMap((l, idx) =>
          idx > 0 ? [{ char: ' ', width: 1, style: l[0]?.style ?? emptyStyle }, ...l] : l,
        ) ?? []
      const valLines = bodyRows.length > 0 ? (row[col] ?? [[]]) : [[]]
      const firstCombined = bodyRows.length > 0 ? [...hFlat, ...colonGraphemes, ...(valLines[0] ?? [])] : hFlat
      const allLines = [firstCombined, ...valLines.slice(1)]
      for (const wrapped of wrapCellLines(allLines, innerWidth)) {
        const rendered = renderStyledGraphemes(wrapped.items)
        out += dim(V) + ' ' + padAligned(rendered, wrapped.width, innerWidth, 'left') + ' ' + dim(V) + EOL
      }
    }
  })
  out += bot
  return out
}

function lineHasUnescapedPipe(line: string): boolean {
  let i = 0
  while (i < line.length) {
    const code = line.charCodeAt(i)
    if (code === 0x5c /* \ */) {
      i += 2
      continue
    }
    if (code === 0x60 /* ` */) {
      let ticks = 1
      while (i + ticks < line.length && line.charCodeAt(i + ticks) === 0x60) ticks++
      let close = i + ticks
      let matched = -1
      while (close < line.length) {
        if (line.charCodeAt(close) === 0x60) {
          let run = 1
          while (close + run < line.length && line.charCodeAt(close + run) === 0x60) run++
          if (run === ticks) {
            matched = close + run
            break
          }
          close += run
          continue
        }
        close++
      }
      if (matched >= 0) {
        i = matched
        continue
      }
      i += ticks
      continue
    }
    if (code === 0x7c /* | */) return true
    i++
  }
  return false
}

function renderTable(tb: Tokens.Table, maxTableWidth: number): string {
  const numCols = tb.header.length
  if (numCols === 0) return ''

  // marked's GFM table rule absorbs trailing non-pipe lines (when the author
  // omits a blank line after a table) into single-cell body rows. Peel those
  // trailing pipe-less lines back out so they render as normal prose below
  // the table instead of stretching Column 0 and landing inside the box.
  let effectiveTableRows = tb.rows
  let spilloverSuffix = ''
  if (numCols >= 2 && tb.rows.length > 0 && tb.raw) {
    const rawBodyLines = tb.raw.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').slice(2)
    if (rawBodyLines.length === tb.rows.length) {
      let splitIdx = tb.rows.length
      while (splitIdx > 0 && !lineHasUnescapedPipe(rawBodyLines[splitIdx - 1]!)) {
        splitIdx--
      }
      if (splitIdx < tb.rows.length) {
        effectiveTableRows = tb.rows.slice(0, splitIdx)
        spilloverSuffix = tb.rows
          .slice(splitIdx)
          .map((r) => (r[0]?.tokens ?? []).map((t) => formatToken(t, 0, null, null, maxTableWidth)).join('') + EOL)
          .join('')
      }
    }
  }

  const formatCell = (tokens: Token[] | undefined, isHeader: boolean): StyledGrapheme[][] => {
    const ansi = (tokens ?? []).map((t) => formatToken(t, 0, null, null, maxTableWidth)).join('')
    return parseStyledLines(ansi, isHeader)
  }

  const headerCells = tb.header.map((h) => formatCell(h.tokens, true))
  const bodyRows = effectiveTableRows.map((row) =>
    Array.from({ length: numCols }, (_, col) => formatCell(row[col]?.tokens, false)),
  )

  const maxCellWidth = (cellLines: StyledGrapheme[][]): number => {
    let max = 0
    for (const line of cellLines) {
      const w = lineVisualWidth(trimStyledLine(line))
      if (w > max) max = w
    }
    return max
  }

  const naturalWidths = headerCells.map((hLines, col) => {
    let max = maxCellWidth(hLines)
    for (const row of bodyRows) {
      const w = maxCellWidth(row[col]!)
      if (w > max) max = w
    }
    return max
  })

  // Ultra-narrow fallback when even 2-cell columns with zero cell padding
  // (`│ab│cd│...`) cannot physically fit side-by-side in maxTableWidth.
  if (maxTableWidth < 3 * numCols + 1) {
    return renderVerticalTableCards(headerCells, bodyRows, maxTableWidth) + spilloverSuffix
  }

  const cellPad = maxTableWidth >= 5 * numCols + 1 ? 1 : 0
  const borderOverhead = (2 * cellPad + 1) * numCols + 1
  const available = maxTableWidth - borderOverhead
  const hardMin = cellPad === 1 && available >= 3 * numCols ? 3 : 2

  const headerMinWidths = headerCells.map(headerMinTokenWidth)
  const colWidths = allocateColumnWidths(naturalWidths, headerMinWidths, available, hardMin)

  // Box-drawing characters: a proper CLI table instead of echoing
  // the markdown pipes back to the user.
  const TL = '\u250c',
    TR = '\u2510',
    TM = '\u252c'
  const BL = '\u2514',
    BR = '\u2518',
    BM = '\u2534'
  const ML = '\u251c',
    MR = '\u2524',
    MM = '\u253c'
  const H = '\u2500',
    V = '\u2502'

  const padStr = ' '.repeat(cellPad)
  const makeDivider = (left: string, mid: string, right: string): string =>
    dim(left + colWidths.map((w) => H.repeat(w + cellPad * 2)).join(mid) + right) + EOL

  const wrappedHeader = headerCells.map((cell, col) => wrapCellLines(cell, colWidths[col]!))
  const wrappedBody = bodyRows.map((row) => row.map((cell, col) => wrapCellLines(cell, colWidths[col]!)))
  const hasMultiLineBodyRow = wrappedBody.some((row) => row.some((cellLines) => cellLines.length > 1))

  const dim = paint('textMuted')
  const renderWrappedRow = (wrappedCells: WrappedCellLine[][]): string => {
    const rowHeight = Math.max(1, ...wrappedCells.map((lines) => lines.length))
    let rowOut = ''
    for (let lineIdx = 0; lineIdx < rowHeight; lineIdx++) {
      rowOut += dim(V) + padStr
      for (let col = 0; col < numCols; col++) {
        if (col > 0) rowOut += padStr + dim(V) + padStr
        const sub = wrappedCells[col]?.[lineIdx]
        const rendered = sub ? renderStyledGraphemes(sub.items) : ''
        const width = sub ? sub.width : 0
        rowOut += padAligned(rendered, width, colWidths[col]!, tb.align?.[col])
      }
      rowOut += padStr + dim(V) + EOL
    }
    return rowOut
  }

  let out = makeDivider(TL, TM, TR)
  out += renderWrappedRow(wrappedHeader)

  if (wrappedBody.length > 0) {
    out += makeDivider(ML, MM, MR)
    wrappedBody.forEach((row, rowIdx) => {
      out += renderWrappedRow(row)
      if (hasMultiLineBodyRow && rowIdx + 1 < wrappedBody.length) {
        out += makeDivider(ML, MM, MR)
      }
    })
  }

  out += makeDivider(BL, BM, BR)
  return out + spilloverSuffix
}

function formatToken(
  token: Token,
  listDepth: number = 0,
  orderedListNumber: number | null = null,
  parent: Token | null = null,
  maxWidth: number = Math.max(20, (process.stdout.columns ?? 80) - 1),
): string {
  switch (token.type) {
    case 'blockquote': {
      const innerWidth = Math.max(10, maxWidth - 2)
      const inner = (token.tokens ?? []).map((t) => formatToken(t, 0, null, null, innerWidth)).join('')
      const bar = paint('textMuted')(BLOCKQUOTE_BAR)
      return inner
        .split(EOL)
        .map((line) => (stripAnsi(line).trim() ? `${bar} ${c.italic(line)}` : line))
        .join(EOL)
    }

    case 'code': {
      const code = token as Tokens.Code
      const text = code.text ?? ''
      // Map the fence language hint (` ```typescript`, ` ```bash`, etc.)
      // to one of our supported tokenisers. Unknown / missing langs fall
      // through to plain text — same as the prior behavior, just no
      // longer the universal default.
      // Prefer the shiki engine (TextMate grammars, ~50 langs, cross-line
      // state) once warmed up; it returns null for unknown langs, oversized
      // blocks, or the `ansi` palette — all of which fall through to the
      // in-house regex path below.
      const shikiHighlighted = highlightCodeShiki(text, code.lang)
      if (shikiHighlighted !== null) return shikiHighlighted + EOL
      const lang = detectFenceLanguage(code.lang)
      if (!lang) return text + EOL
      // Highlight per-line so embedded \n in `text` don't get fed into
      // the tokeniser as if they were source content (the tokenisers'
      // regexes are line-oriented).
      const highlighted = text
        .split('\n')
        .map((line) => highlightLine(line, lang))
        .join('\n')
      return highlighted + EOL
    }

    case 'codespan':
      return paint('primary')((token as Tokens.Codespan).text ?? '')

    case 'em':
      return c.italic((token.tokens ?? []).map((t) => formatToken(t, 0, null, parent, maxWidth)).join(''))

    case 'strong':
      return c.bold((token.tokens ?? []).map((t) => formatToken(t, 0, null, parent, maxWidth)).join(''))

    case 'heading': {
      const h = token as Tokens.Heading
      const content = (h.tokens ?? []).map((t) => formatToken(t, 0, null, null, maxWidth)).join('')
      // Always emit a blank line after the heading. marked never produces a
      // `space` token between a heading and the following block — even when
      // the source has `# H\n\nbody`, the blank is folded into the heading's
      // own `raw`. Without this second EOL, `# H\nbody` rendered as two
      // adjacent rows with no separation. Matches Claude Code.
      if (h.depth === 1) {
        return c.bold.underline(content) + EOL + EOL
      }
      return c.bold(content) + EOL + EOL
    }

    case 'hr': {
      // Full-width muted rule (Codex's turn separator proportions), not
      // an arbitrary fixed-length dash run. `---` needs its own
      // terminator — missing it made `hr` emit no newline, and the next
      // block's content landed on the same row as the rule.
      const cols = Math.max(10, maxWidth)
      return paint('textMuted')('─'.repeat(cols)) + EOL
    }

    case 'image':
      return (token as Tokens.Image).href ?? ''

    case 'link': {
      const l = token as Tokens.Link
      if (l.href?.startsWith('mailto:')) {
        return l.href.replace(/^mailto:/, '')
      }
      const linkText = (l.tokens ?? []).map((t) => formatToken(t, 0, null, l as Token, maxWidth)).join('')
      const href = l.href ?? ''
      const plain = stripAnsi(linkText)
      const styled = c.underline(paint('primary')(plain && plain !== href ? linkText : href))
      // OSC 8 hyperlink: modern terminals render the display text as a
      // clickable link that reveals `href` on hover / Ctrl+click. Older
      // terminals that don't support OSC 8 strip the escape bytes and
      // just show the underlined display text — graceful degradation in
      // both directions. Emitting the raw URL inline produced a cluttered
      // `text (url)text (url)...` output for web-fetch results.
      const safeHref = safeHyperlinkHref(href)
      return safeHref ? `\x1b]8;;${safeHref}\x1b\\${styled}\x1b]8;;\x1b\\` : styled
    }

    case 'list': {
      const list = token as Tokens.List
      return list.items
        .map((item, index) =>
          formatToken(
            item as Token,
            listDepth,
            list.ordered ? Number(list.start ?? 1) + index : null,
            list as Token,
            maxWidth,
          ),
        )
        .join('')
    }

    case 'list_item': {
      const indent = '  '.repeat(listDepth)
      const childWidth = Math.max(10, maxWidth - listDepth * 2)
      return (token.tokens ?? [])
        .map((t) => {
          const formatted = formatToken(t, listDepth + 1, orderedListNumber, token, childWidth)
          if (indent && t.type === 'table') {
            return formatted
              .split(EOL)
              .map((line) => (line ? `${indent}${line}` : line))
              .join(EOL)
          }
          return `${indent}${formatted}`
        })
        .join('')
    }

    case 'paragraph':
      return (token.tokens ?? []).map((t) => formatToken(t, 0, null, null, maxWidth)).join('') + EOL

    case 'space':
      return EOL

    case 'br':
      return EOL

    case 'text': {
      const tx = token as Tokens.Text
      if (parent?.type === 'link') {
        // Inside a link — don't wrap again; the link handler already emitted
        // the OSC 8 sequence.
        return tx.text
      }
      if (parent?.type === 'list_item') {
        // Visually distinct bullet so the rendered output can't be
        // confused with the raw markdown source. Unordered items get a
        // U+2022 • on the textDim gray rung; ordered items keep "N."
        // dimmed the same way. Markers deliberately DON'T take a hue —
        // color is reserved for semantics (Codex/Kimi convention), and a
        // unicode marker already makes it obvious marked.lexer parsed
        // the list (otherwise users see `-` both before and after
        // rendering and assume nothing happened).
        const marker =
          orderedListNumber === null
            ? paint('textDim')(GLYPH_LIST_BULLET)
            : paint('textDim')(`${getListNumber(listDepth, orderedListNumber)}.`)
        const content = tx.tokens
          ? tx.tokens.map((t) => formatToken(t, listDepth, orderedListNumber, token, maxWidth)).join('')
          : tx.text
        return `${marker} ${content}${EOL}`
      }
      if (tx.tokens && tx.tokens.length > 0) {
        return tx.tokens.map((t) => formatToken(t, listDepth, orderedListNumber, token, maxWidth)).join('')
      }
      return tx.text
    }

    case 'table':
      return renderTable(token as Tokens.Table, maxWidth)

    case 'escape':
      return (token as Tokens.Escape).text ?? ''

    case 'html': {
      const raw = (token as Tokens.HTML).text ?? ''
      return /^\s*<br\s*\/?>\s*$/i.test(raw) ? EOL : ''
    }

    case 'def':
    case 'del':
      return ''
  }
  return ''
}

/**
 * Lightweight inline-only markdown-to-ANSI pass.
 *
 * Handles **bold**, *italic*, and `code` — nothing block-level.
 * Returns a string containing ANSI escape sequences suitable for
 * consumption by ansiTextToCells().
 */
export function renderInlineMarkdown(text: string): string {
  if (!text) return ''
  text = stripTerminalControls(text)

  return (
    text
      // bold: **text** or __text__
      .replace(/(\*\*|__)(.+?)\1/g, (_m, _d, inner) => c.bold(inner as string))
      // italic: *text* or _text_ (but not inside a word for _)
      .replace(/(?<!\w)(\*|_)(?!\s)(.+?)(?<!\s)\1(?!\w)/g, (_m, _d, inner) => c.italic(inner as string))
      // inline code: `code`
      .replace(/`([^`]+)`/g, (_m, inner) => paint('primary')(inner as string))
  )
}

/**
 * Convert a Markdown string to ANSI-styled terminal text.
 *
 * Preserves trailing newlines emitted by the token formatters — the caller
 * (stdout-writer) relies on them for the streaming-chunk boundary logic.
 */
export function renderMarkdown(text: string, maxWidth?: number): string {
  if (!text) return ''
  text = stripTerminalControls(text)

  configureMarked()

  const effectiveWidth =
    maxWidth !== undefined ? Math.max(10, Math.floor(maxWidth)) : Math.max(20, (process.stdout.columns ?? 80) - 1)

  try {
    // Fast path — single paragraph for plain text
    if (!hasMarkdownSyntax(text)) {
      return text + EOL
    }
    const tokens = marked.lexer(text) as Token[]
    return tokens.map((t) => formatToken(t, 0, null, null, effectiveWidth)).join('')
  } catch {
    // Partial/invalid Markdown during streaming — fall back to raw text so
    // the user still sees something.
    return text
  }
}
