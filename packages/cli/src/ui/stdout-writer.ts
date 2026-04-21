// @x-code-cli/cli — Direct-to-stdout message writer.
//
// Why this exists: Ink's layout engine miscalculates visual widths for wide
// (CJK) characters, so when the Ink renderer repaints a region it can rewind
// by the wrong number of rows and overlap previous content. This shows up as
// "spliced bullets" and scrambled tool-result text on long Chinese responses.
//
// Claude Code avoids the same class of bug by vendoring a custom Ink fork
// with a grapheme-aware stringWidth + soft-wrap metadata. We take a simpler
// route: render message history OUTSIDE of Ink entirely by writing raw ANSI
// to stdout via the `write` function returned from Ink's `useStdout()` hook.
// That function is documented as "similar to <Static>, except … it only
// works with strings" — it goes through Ink's internal writeToStdout which
// properly coordinates with log-update (clear dynamic region → write →
// re-render). We avoid `console.log` + `patchConsole` because the patch
// library's internal string handling has been observed to drop content on
// very large multi-line writes.
//
// Ink still owns the bottom-of-screen dynamic region (spinner, in-progress
// tool call, permission dialog, chat input). That region is short and
// mostly ASCII, so Ink's own measurement is good enough.
import { Chalk } from 'chalk'

import * as fs from 'node:fs'
import * as path from 'node:path'

import { GLOBAL_XCODE_DIR, debugLog } from '@x-code-cli/core'
import type { DisplayMessage, DisplayToolCall } from '@x-code-cli/core'

import { renderMarkdown } from './render-markdown.js'
import { BLUE_PURPLE, ERROR, PROMPT_BORDER, SUCCESS } from './theme.js'
import { getToolInputPreview, getToolLabel, getToolResultSummary } from './tool-display.js'

const c = new Chalk({ level: 3 })

/** Function that writes to stdout through Ink's log-update coordination. */
export type InkWrite = (data: string) => void

const RESULT_INDENT = '     '

/**
 * Normalize line endings to `\n`. Critical before any terminal write:
 * Windows pastes / clipboard content commonly arrive with `\r\n` or bare
 * `\r`, and a bare `\r` in the terminal means "move cursor to column 0
 * of the current row" — subsequent characters OVERWRITE whatever was
 * previously printed on that row. Multi-line content with `\r` separators
 * printed naively produces spliced/overwritten output (exactly the
 * "optimizationsClaude Managed Agents is currently in beta" pattern).
 */
function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}

// ── Debug logging ────────────────────────────────────────────────────────
// Turn on with `X_CODE_DEBUG=1`. Appends every message handed to
// writeMessageToStdout to `~/.x-code/x-code-debug.log` so we can compare
// what React sees vs what lands on screen. Using the global `.x-code`
// directory matches the knowledge / auto-memory layout and keeps the
// file easy to find (~/.x-code on macOS/Linux, C:\Users\<user>\.x-code on
// Windows) instead of hiding it under the OS temp directory.
const DEBUG = process.env.X_CODE_DEBUG === '1'
const DEBUG_DIR = GLOBAL_XCODE_DIR
const DEBUG_LOG = path.join(DEBUG_DIR, 'x-code-debug.log')

function debugDump(tag: string, content: string): void {
  if (!DEBUG) return
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true })
    const sep = '\n=== ' + tag + ' (' + content.length + ' chars, ' + content.split('\n').length + ' lines) ===\n'
    fs.appendFileSync(DEBUG_LOG, sep + content + '\n', 'utf8')
  } catch {
    // best effort
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  return `${minutes}m ${secs}s`
}

function formatToolCall(tc: DisplayToolCall): string {
  const label = getToolLabel(tc.toolName)
  const inputPreview = getToolInputPreview(tc.toolName, tc.input)
  const resultSummary = getToolResultSummary(tc.toolName, tc.output, tc.status)
  const isDenied = tc.status === 'denied'
  const durationStr = tc.durationMs != null ? formatDuration(tc.durationMs) : null

  const dotColor = isDenied ? ERROR : SUCCESS
  const previewSuffix = inputPreview ? c.hex(BLUE_PURPLE)(`(${inputPreview})`) : ''
  const line1 = ` ${c.hex(dotColor)('●')} ${c.bold(label)}${previewSuffix}`

  if (!resultSummary) return line1

  const lines = resultSummary.split('\n')
  const formatted = lines.map((l, i) => (i === 0 ? l : RESULT_INDENT + l)).join('\n')
  const bodyColor = isDenied ? c.hex(ERROR) : c.gray
  const durSuffix = durationStr ? c.gray(` (${durationStr})`) : ''
  const line2 = `   ${c.gray('⎿')}  ${bodyColor(formatted)}${durSuffix}`
  return `${line1}\n${line2}`
}

/** Replace every LF with CRLF. Defensive against terminals where stdout's
 *  ONLCR output translation is disabled (Ink puts stdin into raw mode but
 *  stdout's termios settings can be implementation-dependent, and VS Code
 *  terminal in particular has been observed to not translate bare LF into
 *  CRLF). Without an explicit `\r`, the cursor stays at whatever column
 *  the line ended on, and the following cell-buffer repaint positions at
 *  col 1 via `\x1b[1G` — overwriting only the first few columns and
 *  leaving the tail of the just-written text visible "to the right of"
 *  the next row's content (looks like partial text next to Thinking). */
function toCRLF(s: string): string {
  return s.replace(/\r?\n/g, '\r\n')
}

/** Print a DisplayMessage to stdout. */
export function writeMessageToStdout(write: InkWrite, msg: DisplayMessage): void {
  if (msg.role === 'user') {
    const content = normalizeLineEndings(msg.content)
    debugDump('USER MESSAGE', content)
    debugLog('stdout.user', content)
    writeUserMessage(write, content)
    return
  }

  // Assistant message — may have tool calls, a text body, or both.
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      debugLog('stdout.tool-call-line', `${tc.toolName} ${tc.status}`)
      write(toCRLF(normalizeLineEndings(formatToolCall(tc)) + '\n'))
    }
  }

  if (msg.content) {
    const content = normalizeLineEndings(msg.content)
    debugDump('ASSISTANT MESSAGE', content)
    debugLog(msg.streamingChunk ? 'stdout.assistant-chunk' : 'stdout.assistant-full', content)

    // Special-case pure-whitespace streaming chunks (e.g. a bare "\n"
    // = paragraph break marker between two lines of prose). Markdown
    // rendering collapses these to an empty string, which would drop
    // the visual paragraph break — so pass the whitespace through
    // directly instead.
    if (msg.streamingChunk && content.trim() === '') {
      write(toCRLF(content))
      return
    }

    // Two-space indent matches the assistant body spacing used throughout.
    const body = renderMarkdown(content)
    const indented = normalizeLineEndings(body)
      .split('\n')
      .map((line) => (line ? `  ${line}` : line))
      .join('\n')
    if (msg.streamingChunk) {
      // Streaming chunks carry their own trailing newline(s) — renderMarkdown
      // emits "line\n" for list items, "line\n" for headings, and "line\n\n"
      // when a block is followed by a paragraph-break space token. The
      // indented `  ${line}` mapping preserves those trailing \ns as-is.
      //
      // We MUST ensure the chunk ends in at least one \n so the cursor
      // advances to the next row: the subsequent frame redraw starts from
      // wherever writeMessage left the cursor, and if we emit text without
      // a newline, the next row-0 of the frame overwrites the chunk text.
      // Belt-and-suspenders: append one \n if renderMarkdown returned a
      // trailing-newline-less body (theoretically possible for unknown
      // token shapes or the catch-fallback plain-text path).
      const out = indented.endsWith('\n') ? indented : indented + '\n'
      write(toCRLF(out))
    } else {
      write(toCRLF(indented + '\n\n'))
    }
  }
}

/**
 * Echo a user message in full. For multi-line content we indent continuation
 * lines with two spaces so they align under the text that followed the `❯`
 * prompt glyph on the first line. `content` is assumed to have already been
 * normalized to use `\n` line separators.
 */
function writeUserMessage(write: InkWrite, content: string): void {
  const arrow = c.hex(PROMPT_BORDER)('❯')
  const lines = content.split('\n')
  const [first = '', ...rest] = lines
  const indentedRest = rest.map((line) => `  ${line}`)
  const body = [`${arrow} ${first}`, ...indentedRest].join('\n')
  // Leading \n gives one blank row of margin-top so the echo doesn't
  // crowd against the previous assistant reply's last line of content.
  // Explicit CRLF line breaks — see toCRLF() above for rationale.
  write(toCRLF('\n' + body + '\n\n'))
}
