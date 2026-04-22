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

import { ACCENT_DIM as LINK_URL, BLUE_PURPLE, SPINNER_BLUE as LINK } from './theme.js'

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
      if (h.depth === 1) {
        return c.bold.italic.underline(content) + EOL + EOL
      }
      return c.bold(content) + EOL + EOL
    }

    case 'hr':
      return '---'

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
      // No OSC 8 — emitting the hyperlink start/end sequences leaked into
      // subsequent Ink frames on some terminals and desynced the input
      // cursor. Render as underlined text followed by the URL in dim.
      if (plain && plain !== href) {
        return `${c.hex(LINK).underline(linkText)} (${c.hex(LINK_URL)(href)})`
      }
      return c.hex(LINK).underline(href)
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
        const marker =
          orderedListNumber === null
            ? '-'
            : `${getListNumber(listDepth, orderedListNumber)}.`
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

      const displayTextOf = (tokens?: Token[]): string =>
        stripAnsi((tokens ?? []).map((t) => formatToken(t, 0, null, null)).join(''))

      const columnWidths = tb.header.map((header, index) => {
        let maxWidth = displayTextOf(header.tokens).length
        for (const row of tb.rows) {
          const cellLength = displayTextOf(row[index]?.tokens).length
          maxWidth = Math.max(maxWidth, cellLength)
        }
        return Math.max(maxWidth, 3)
      })

      let out = '| '
      tb.header.forEach((header, index) => {
        const content = (header.tokens ?? [])
          .map((t) => formatToken(t, 0, null, null))
          .join('')
        const displayText = displayTextOf(header.tokens)
        const width = columnWidths[index]!
        const align = tb.align?.[index]
        out += padAligned(content, displayText.length, width, align) + ' | '
      })
      out = out.trimEnd() + EOL

      out += '|'
      columnWidths.forEach((width) => {
        out += '-'.repeat(width + 2) + '|'
      })
      out += EOL

      tb.rows.forEach((row) => {
        out += '| '
        row.forEach((cell, index) => {
          const content = (cell.tokens ?? [])
            .map((t) => formatToken(t, 0, null, null))
            .join('')
          const displayText = displayTextOf(cell.tokens)
          const width = columnWidths[index]!
          const align = tb.align?.[index]
          out += padAligned(content, displayText.length, width, align) + ' | '
        })
        out = out.trimEnd() + EOL
      })

      return out + EOL
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
