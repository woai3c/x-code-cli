// @x-code-cli/cli — Markdown-to-ANSI renderer (token-based)
//
// Port of Claude Code's formatToken() in src/utils/markdown.ts, adapted for
// direct stdout writing (no React/Ink wrapper). Uses marked.lexer() to parse
// Markdown into an AST, then recursively renders each token to ANSI-styled
// text using chalk.
//
// Style choices mirror Claude Code verbatim: heading h1 is bold+italic+underline
// (no accent color), h2/h3+ are bold, blockquote uses U+258E ▎ as a dim prefix
// bar with italic text, code blocks emit raw text without indent, inline code
// is tinted in the brand blue-purple, list bullets use `-` (nested ordered
// levels switch to letter/roman), and links become OSC 8 hyperlinks.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Chalk } from 'chalk'
import { type Token, type Tokens, marked } from 'marked'

import { BLUE_PURPLE, SPINNER_BLUE as LINK } from './theme.js'

const c = new Chalk({ level: 3 })

const EOL = '\n'

// U+258E LEFT ONE QUARTER BLOCK — blockquote line prefix (Claude Code figures.ts)
const BLOCKQUOTE_BAR = '\u258e'

// Inline code tint — matches Claude Code's `permission` color (rgb(177,185,249))
const CODE_INLINE = BLUE_PURPLE

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
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /
function hasMarkdownSyntax(s: string): boolean {
  return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s)
}

// Strip CSI escapes (`\x1B[…m`, etc.) so visual width calculations work on
// colored text.
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g
function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '')
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

// Display width in terminal columns: CJK / full-width code points count as 2.
// Using `string.length` here would undercount headers like `运算` and the
// table's right border would walk leftward on each subsequent row.
function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  )
}

function displayWidth(text: string): number {
  let w = 0
  for (const ch of text) {
    w += isWideChar(ch.codePointAt(0) ?? 0) ? 2 : 1
  }
  return w
}

function formatToken(
  token: Token,
  listDepth: number = 0,
  orderedListNumber: number | null = null,
  parent: Token | null = null,
): string {
  switch (token.type) {
    case 'blockquote': {
      const inner = (token.tokens ?? [])
        .map((t) => formatToken(t, 0, null, null))
        .join('')
      const bar = c.dim(BLOCKQUOTE_BAR)
      return inner
        .split(EOL)
        .map((line) =>
          stripAnsi(line).trim() ? `${bar} ${c.italic(line)}` : line,
        )
        .join(EOL)
    }

    case 'code': {
      // No syntax highlighter wired up — plain text with trailing EOL,
      // same as Claude Code's highlight=null fallback path.
      return ((token as Tokens.Code).text ?? '') + EOL
    }

    case 'codespan':
      return c.hex(CODE_INLINE)((token as Tokens.Codespan).text ?? '')

    case 'em':
      return c.italic(
        (token.tokens ?? [])
          .map((t) => formatToken(t, 0, null, parent))
          .join(''),
      )

    case 'strong':
      return c.bold(
        (token.tokens ?? [])
          .map((t) => formatToken(t, 0, null, parent))
          .join(''),
      )

    case 'heading': {
      const h = token as Tokens.Heading
      const content = (h.tokens ?? [])
        .map((t) => formatToken(t, 0, null, null))
        .join('')
      // Single trailing EOL; blank row (if any) after the heading is
      // supplied by the adjacent `space` token, not by us doubling up.
      if (h.depth === 1) {
        return c.bold.italic.underline(content) + EOL
      }
      return c.bold(content) + EOL
    }

    case 'hr':
      // `---` needs its own terminator — missing it made `hr` emit no
      // newline, and the next block's content landed on the same row
      // as the rule.
      return c.hex('#999999')('\u2500'.repeat(20)) + EOL

    case 'image':
      return (token as Tokens.Image).href ?? ''

    case 'link': {
      const l = token as Tokens.Link
      if (l.href?.startsWith('mailto:')) {
        return l.href.replace(/^mailto:/, '')
      }
      const linkText = (l.tokens ?? [])
        .map((t) => formatToken(t, 0, null, l as Token))
        .join('')
      const href = l.href ?? ''
      const plain = stripAnsi(linkText)
      const styled = c.hex(LINK).underline(plain && plain !== href ? linkText : href)
      // OSC 8 hyperlink: modern terminals render the display text as a
      // clickable link that reveals `href` on hover / Ctrl+click. Older
      // terminals that don't support OSC 8 strip the escape bytes and
      // just show the underlined display text — graceful degradation in
      // both directions. Emitting the raw URL inline produced a cluttered
      // `text (url)text (url)...` output for web-fetch results.
      return href ? `\x1b]8;;${href}\x1b\\${styled}\x1b]8;;\x1b\\` : styled
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
          ),
        )
        .join('')
    }

    case 'list_item':
      return (token.tokens ?? [])
        .map(
          (t) =>
            `${'  '.repeat(listDepth)}${formatToken(t, listDepth + 1, orderedListNumber, token)}`,
        )
        .join('')

    case 'paragraph':
      return (
        (token.tokens ?? [])
          .map((t) => formatToken(t, 0, null, null))
          .join('') + EOL
      )

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
        // coloured U+2022 •; ordered items keep "N." but with the
        // digits accented. Claude Code's own render does the same (any
        // unicode marker makes it obvious marked.lexer actually parsed
        // the list — otherwise users see `-` both before and after
        // rendering and assume nothing happened).
        const marker =
          orderedListNumber === null
            ? c.hex(BLUE_PURPLE)('\u2022')
            : c.hex(BLUE_PURPLE)(`${getListNumber(listDepth, orderedListNumber)}.`)
        const content = tx.tokens
          ? tx.tokens
              .map((t) => formatToken(t, listDepth, orderedListNumber, token))
              .join('')
          : tx.text
        return `${marker} ${content}${EOL}`
      }
      return tx.text
    }

    case 'table': {
      const tb = token as Tokens.Table

      const displayWidthOf = (tokens?: Token[]): number =>
        displayWidth(stripAnsi((tokens ?? []).map((t) => formatToken(t, 0, null, null)).join('')))

      const colWidths = tb.header.map((header, index) => {
        let max = displayWidthOf(header.tokens)
        for (const row of tb.rows) {
          max = Math.max(max, displayWidthOf(row[index]?.tokens))
        }
        return Math.max(max, 3)
      })

      // Box-drawing characters: a proper CLI table instead of echoing
      // the markdown pipes back to the user.
      const TL = '\u250c', TR = '\u2510', TM = '\u252c'
      const BL = '\u2514', BR = '\u2518', BM = '\u2534'
      const ML = '\u251c', MR = '\u2524', MM = '\u253c'
      const H = '\u2500', V = '\u2502'

      const makeDivider = (left: string, mid: string, right: string): string =>
        left + colWidths.map((w) => H.repeat(w + 2)).join(mid) + right + EOL

      const padCell = (
        cell: { tokens?: Token[] },
        width: number,
        align: 'left' | 'center' | 'right' | null | undefined,
      ): string => {
        const content = (cell.tokens ?? [])
          .map((t) => formatToken(t, 0, null, null))
          .join('')
        const displayWidth = displayWidthOf(cell.tokens)
        return padAligned(content, displayWidth, width, align)
      }

      const dim = (s: string) => c.hex('#999999')(s)
      let out = dim(makeDivider(TL, TM, TR))

      out += dim(V) + ' '
      tb.header.forEach((header, index) => {
        if (index > 0) out += ' ' + dim(V) + ' '
        out += c.bold(padCell(header, colWidths[index]!, tb.align?.[index]))
      })
      out += ' ' + dim(V) + EOL

      out += dim(makeDivider(ML, MM, MR))

      tb.rows.forEach((row) => {
        out += dim(V) + ' '
        row.forEach((cell, index) => {
          if (index > 0) out += ' ' + dim(V) + ' '
          out += padCell(cell, colWidths[index]!, tb.align?.[index])
        })
        out += ' ' + dim(V) + EOL
      })

      out += dim(makeDivider(BL, BM, BR))
      // `out` already ends with EOL from the final divider — returning
      // `out + EOL` added an extra blank row that the adjacent `space`
      // token then doubled up.
      return out
    }

    case 'escape':
      return (token as Tokens.Escape).text ?? ''

    case 'def':
    case 'del':
    case 'html':
      return ''
  }
  return ''
}

/**
 * Convert a Markdown string to ANSI-styled terminal text.
 *
 * Preserves trailing newlines emitted by the token formatters — the caller
 * (stdout-writer) relies on them for the streaming-chunk boundary logic.
 */
export function renderMarkdown(text: string): string {
  if (!text) return ''

  configureMarked()

  try {
    // Fast path — single paragraph for plain text
    if (!hasMarkdownSyntax(text)) {
      return text + EOL
    }
    const tokens = marked.lexer(text) as Token[]
    return tokens.map((t) => formatToken(t, 0, null, null)).join('')
  } catch {
    // Partial/invalid Markdown during streaming — fall back to raw text so
    // the user still sees something.
    return text
  }
}
