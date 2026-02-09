// @x-code/cli — Markdown-to-ANSI renderer (token-based)
//
// Uses `marked.lexer()` to parse Markdown into an AST (token tree), then
// recursively renders each token to ANSI-styled terminal text using chalk.
//
// This approach (identical to what Claude Code uses internally) is far more
// reliable than regex-based rendering because:
//   1. The parser correctly handles nested structures
//      (e.g. bold **inside** a list item inside a blockquote).
//   2. Code spans are protected — their content is never re-interpreted.
//   3. Streaming partial text degrades gracefully (unclosed tokens are
//      simply treated as plain text by the lexer).

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-explicit-any */
 

import { Chalk } from 'chalk'
import { marked, type Token } from 'marked'

// ── chalk instance with 24-bit colour ──
const c = new Chalk({ level: 3 })

// Disable del (strikethrough) extension to avoid conflicts with file paths
// containing tildes — same approach Claude Code uses.
marked.use({ tokenizer: { del() { return undefined as any } } })

// ── Theme colours (keep in sync with theme.ts) ──
const ACCENT = '#89b4fa'
const WARNING = '#f9e2af'

// Newline constant for joining blocks
const NL = '\n'

// ── Recursive token renderer ──────────────────────────────────────────
//
// Mirrors the approach from Claude Code's minified `CM` function:
//   - Each token type has a dedicated case
//   - Inline tokens (bold, italic, code, etc.) recurse into child tokens
//   - Block tokens (heading, list, code block, etc.) append newlines

function renderToken(
  token: Token,
  depth: number = 0,
  orderedStart: number | null = null,
  _parentToken: Token | null = null,
): string {
  switch (token.type) {
    // ── Block elements ──

    case 'heading': {
      const content = renderTokens(token.tokens ?? [], depth)
      switch (token.depth) {
        case 1:
          return c.hex(ACCENT).bold.underline(content) + NL
        case 2:
          return c.bold(content) + NL
        default:
          return c.bold(content) + NL
      }
    }

    case 'paragraph': {
      const content = renderTokens(token.tokens ?? [], depth)
      return content + NL
    }

    case 'blockquote': {
      const content = renderTokens(token.tokens ?? [], depth)
      // Indent each line with a dim vertical bar
      return content
        .split(NL)
        .map((line) => (line.trim() ? c.dim.italic(`  │ ${line}`) : ''))
        .filter(Boolean)
        .join(NL) + NL
    }

    case 'code': {
      const langLabel = token.lang ? c.dim(`  [${token.lang}]`) : ''
      const codeLines = (token.text ?? '')
        .split(NL)
        .map((line: string) => `  ${c.hex(WARNING)(line)}`)
        .join(NL)
      return (langLabel ? langLabel + NL : '') + codeLines + NL
    }

    case 'list': {
      return token.items
        .map((item: any, idx: number) =>
          renderToken(item, depth, token.ordered ? (token.start ?? 1) + idx : null, token),
        )
        .join('')
    }

    case 'list_item': {
      // Each list_item contains child tokens (paragraph, text, sub-lists…).
      // We render them, prepending a bullet/number to the first line.
      const inner = (token.tokens ?? [])
        .map((child: any) => {
          // If the child is a 'text' token at list-item level, render its
          // inline children directly (without adding an extra newline that
          // 'paragraph' would add).
          if (child.type === 'text') {
            const prefix =
              orderedStart !== null ? `${orderedStart}.` : '•'
            const indent = '  '.repeat(depth)
            const inlineContent = child.tokens
              ? renderTokens(child.tokens, depth)
              : (child.text ?? '')
            return `${indent}${prefix} ${inlineContent}${NL}`
          }
          if (child.type === 'list') {
            // Nested list — increase depth
            return renderToken(child, depth + 1)
          }
          // Other block elements inside a list item (e.g. paragraph)
          if (child.type === 'paragraph') {
            const prefix =
              orderedStart !== null ? `${orderedStart}.` : '•'
            const indent = '  '.repeat(depth)
            const inlineContent = renderTokens(child.tokens ?? [], depth)
            return `${indent}${prefix} ${inlineContent}${NL}`
          }
          return renderToken(child, depth)
        })
        .join('')
      return inner
    }

    case 'hr':
      return c.dim('─'.repeat(40)) + NL

    case 'space':
      return NL

    case 'html':
      // Pass HTML through as-is (rare in LLM output)
      return (token.text ?? '') + NL

    case 'table': {
      // Simple table rendering
      const header = token.header as any[]
      const rows = token.rows as any[][]

      // Compute column widths
      const colWidths = header.map((cell: any, i: number) => {
        let max = stripAnsi(renderTokens(cell.tokens ?? [], 0)).length
        for (const row of rows) {
          if (row[i]) {
            const len = stripAnsi(renderTokens(row[i].tokens ?? [], 0)).length
            max = Math.max(max, len)
          }
        }
        return Math.max(max, 3)
      })

      // Header
      const headerLine = header
        .map((cell: any, i: number) => {
          const text = renderTokens(cell.tokens ?? [], 0)
          return padVisual(text, colWidths[i])
        })
        .join(' │ ')

      // Separator
      const sepLine = colWidths.map((w) => '─'.repeat(w)).join('─┼─')

      // Rows
      const rowLines = rows
        .map((row: any[]) =>
          row
            .map((cell: any, i: number) => {
              const text = renderTokens(cell?.tokens ?? [], 0)
              return padVisual(text, colWidths[i])
            })
            .join(' │ '),
        )
        .join(NL)

      return [c.bold(headerLine), c.dim(sepLine), rowLines].join(NL) + NL
    }

    // ── Inline elements ──

    case 'strong':
      return c.bold(renderTokens(token.tokens ?? [], depth))

    case 'em':
      return c.italic(renderTokens(token.tokens ?? [], depth))

    case 'codespan':
      return c.hex(ACCENT)(token.text ?? '')

    case 'br':
      return NL

    case 'del':
      return c.strikethrough.dim(renderTokens(token.tokens ?? [], depth))

    case 'link':
      if (token.href?.startsWith('mailto:')) {
        return token.href.replace(/^mailto:/, '')
      }
      return `${c.hex(ACCENT).underline(renderTokens(token.tokens ?? [], depth))} (${c.dim(token.href ?? '')})`

    case 'image':
      return token.text || token.href || '[image]'

    case 'text': {
      // Text tokens may have inline sub-tokens (e.g. inside a paragraph)
      if (token.tokens && token.tokens.length > 0) {
        return renderTokens(token.tokens, depth)
      }
      return token.text ?? ''
    }

    case 'escape':
      return token.text ?? ''

    default:
      // Fallback — return raw text if available
      return (token as any).text ?? (token as any).raw ?? ''
  }
}

/**
 * Render an array of tokens into a single ANSI string.
 */
function renderTokens(tokens: Token[], depth: number = 0): string {
  return tokens.map((t) => renderToken(t, depth)).join('')
}

/**
 * Convert a Markdown string into ANSI-styled terminal text.
 *
 * Uses `marked.lexer()` to parse the Markdown into tokens, then renders
 * each token recursively.
 */
export function renderMarkdown(text: string): string {
  if (!text) return ''

  try {
    const tokens = marked.lexer(text)
    const result = renderTokens(tokens as Token[])
    // Trim trailing newlines but keep at most one
    return result.replace(/\n{2,}$/g, '\n').trimEnd()
  } catch {
    // If parsing fails (e.g. during streaming with very partial text),
    // return the original text so the user at least sees something.
    return text
  }
}

// ── Utility helpers ───────────────────────────────────────────────────

/**
 * Strip ANSI escape codes from a string (for width calculation).
 */
function stripAnsi(str: string): string {
   
  return str.replace(/\x1B\[[0-9;]*m/g, '')
}

/**
 * Pad a string to a visual width, accounting for ANSI codes.
 */
function padVisual(str: string, width: number): string {
  const visible = stripAnsi(str).length
  if (visible >= width) return str
  return str + ' '.repeat(width - visible)
}
