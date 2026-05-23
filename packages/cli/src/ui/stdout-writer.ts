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

import { debugLog } from '@x-code-cli/core'
import type { DisplayMessage, DisplayToolCall } from '@x-code-cli/core'

import { renderEditDiff } from './render-diff.js'
import { renderInlineMarkdown, renderMarkdown } from './render-markdown.js'
import { GLYPH_BULLET, GLYPH_ELLIPSIS, GLYPH_PROMPT_ARROW, GLYPH_RESULT_BRACKET } from './terminal-glyphs.js'
import { BLUE_PURPLE, ERROR, PROMPT_BORDER, SUCCESS } from './theme.js'
import {
  RESULT_INDENT,
  formatDuration,
  formatReadGroupSummary,
  getToolInputPreview,
  getToolLabel,
  getToolResultSummary,
  isCollapsibleReadOnlyTool,
  normalizeLineEndings,
} from './utils.js'

const c = new Chalk({ level: 3 })

/** Function that writes to stdout through Ink's log-update coordination. */
export type InkWrite = (data: string) => void

/**
 * Truncate `s` so it fits visually in `maxLen` printable cells. We use a
 * UTF ellipsis (…) as the truncation marker — single cell, looks
 * tighter than three dots, matches CC's truncated previews.
 */
function truncatePreview(s: string, maxLen: number): string {
  if (maxLen < 4 || s.length <= maxLen) return s
  return s.slice(0, maxLen - 1) + GLYPH_ELLIPSIS
}

function formatToolCall(tc: DisplayToolCall): string {
  const label = getToolLabel(tc.toolName)
  const rawPreview = getToolInputPreview(tc.toolName, tc.input)
  // Cap the preview so long Bash commands / file paths don't wrap into a
  // ragged multi-line block in scrollback. Compute the budget against the
  // terminal width so wide terminals get more room. The line1 prefix is
  // ` ● <label>(` and we close with `)`, so reserve label.length + 5 cells
  // for decoration; leave a small safety margin for the trailing
  // `\x1b[K` / cursor positioning the terminal may add.
  const cols = Math.max(40, process.stdout.columns ?? 120)
  const decoration = label.length + 5
  const safetyMargin = 4
  const maxPreviewLen = Math.max(40, cols - decoration - safetyMargin)
  const inputPreview = truncatePreview(rawPreview, maxPreviewLen)
  const resultSummary = getToolResultSummary(tc.toolName, tc.output, tc.status)
  const isDenied = tc.status === 'denied'
  const isError = tc.status === 'error'
  const isFailure = isDenied || isError
  const durationStr = tc.durationMs != null ? formatDuration(tc.durationMs) : null

  const dotColor = isFailure ? ERROR : SUCCESS
  const previewSuffix = inputPreview ? c.hex(BLUE_PURPLE)(`(${inputPreview})`) : ''
  const line1 = ` ${c.hex(dotColor)(GLYPH_BULLET)} ${c.bold(label)}${previewSuffix}`

  // Edit / writeFile success path: render the structured diff under the
  // bullet INSTEAD of the plain "Wrote N lines" / "Applied changes" summary.
  // We only take this branch when the tool actually succeeded — failed
  // edits keep the regular markdown summary so the red error message lands
  // where the user expects to read it.
  if (tc.editPayload && !isFailure) {
    const cols = Math.max(40, process.stdout.columns ?? 120)
    const diffLines = renderEditDiff(tc.editPayload, cols)
    const head = `   ${c.gray(GLYPH_RESULT_BRACKET)}  ${diffLines[0] ?? ''}`
    const body = diffLines.slice(1)
    const durSuffix = durationStr ? c.gray(` (${durationStr})`) : ''
    const combined = body.length > 0 ? [head, ...body] : [head]
    combined[combined.length - 1] = combined[combined.length - 1] + durSuffix
    return `${line1}\n${combined.join('\n')}`
  }

  if (!resultSummary) return line1

  // Render the result through the markdown pipeline so tool outputs with
  // headings / lists / inline code / etc. display styled instead of as
  // raw `### ...` / `**...**` characters. Denied AND errored results
  // render as plain red text so failures stand out in scrollback —
  // matches Claude Code's behavior of coloring the stderr/exit-code
  // block in red for non-zero shell exits.
  const rendered = isFailure ? resultSummary : renderMarkdown(resultSummary).replace(/\n+$/, '')

  // Strip blank lines — markdown rendering inserts paragraph spacing
  // between blocks, which makes the tool-result summary look sparse
  // (heading, blank, URL, blank, "... +7 lines"). We want a tight
  // 2-3 line summary, not a paragraphed body.
  const lines = normalizeLineEndings(rendered)
    .split('\n')
    .filter((l) => l.trim().length > 0)
  const durSuffix = durationStr ? c.gray(` (${durationStr})`) : ''
  // Errored lines get the ERROR hex color applied AFTER line splitting —
  // applying it before splitting would split on ANSI-reset sequences
  // embedded mid-style and leave half the body uncolored. Apply per line.
  const paint = isFailure ? (s: string) => c.hex(ERROR)(s) : (s: string) => s
  const head = `   ${c.gray(GLYPH_RESULT_BRACKET)}  ${paint(lines[0] ?? '')}`
  const tail = lines.slice(1).map((l) => `${RESULT_INDENT}${paint(l)}`)
  // Duration goes on the last visible line of the body so it reads like
  // "... +13 lines (1.2s)" on truncated summaries.
  const combined = tail.length > 0 ? [head, ...tail] : [head]
  combined[combined.length - 1] = combined[combined.length - 1] + durSuffix
  return `${line1}\n${combined.join('\n')}`
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

/**
 * Has the previous scrollback write left a fully blank row below its last
 * line of content? Used to keep the spacing between adjacent entities at
 * exactly one blank row regardless of which entity wrote first.
 *
 * Why we need this flag: streaming text chunks each end with a single
 * `\n` (cursor on the next row, no trailing blank) so a tool call that
 * commits right after a stream would butt against the text. User
 * messages and finalized tool/text writes already leave a trailing
 * blank, so back-to-back blocks don't need any extra spacer. The flag
 * lets the next entity decide: if the previous write didn't already
 * draw a blank below itself, prepend one; otherwise don't.
 *
 * Initialized to `true` so the very first write of a session doesn't
 * draw a leading blank row at the top of the terminal.
 */
let prevWriteEndedWithBlankRow = true

/**
 * Was the previous write a streaming text chunk? When the next write is
 * ALSO a streaming chunk we treat it as a continuation of the same
 * assistant message and do NOT prepend the leading-blank that the
 * `prevWriteEndedWithBlankRow` machinery would otherwise add. Each
 * streaming chunk ends with a single `\n` (no trailing blank), so without
 * this guard the blank gets injected at every chunk boundary — and since
 * the stream buffer flushes on cadence rather than markdown structure,
 * those boundaries fall between adjacent list items / paragraph lines
 * and produce visible inter-line gaps where the model emitted none.
 */
let prevWriteWasStreamingChunk = false

/** Reset the spacing flag — call when the scrollback is cleared (e.g.
 *  /clear) so the next write doesn't think there's still a blank above.
 *  Also drops any buffered read-group entries: post-/clear they refer to
 *  pre-clear messages that are no longer in scrollback, so committing
 *  their summary would leave a phantom row above the now-empty history. */
export function resetScrollbackSpacing(): void {
  prevWriteEndedWithBlankRow = true
  prevWriteWasStreamingChunk = false
  pendingReadGroup = []
}

/** Did the most recent scrollback write leave a fully blank row below its
 *  last line of content? Read by ChatInput's frame builder so the live
 *  tool/spinner block can apply the SAME leading-blank rule that the
 *  committed-tool path uses — without it, the live frame draws flush
 *  against streaming text and the blank "appears" only when the tool
 *  finishes (a visible spacing jump). */
export function lastWriteEndedWithBlankRow(): boolean {
  return prevWriteEndedWithBlankRow
}

/** Pending buffer of consecutive completed read-only tool calls. Holds
 *  Read / Glob / Grep / ListDir (`isCollapsibleReadOnlyTool`) rows that
 *  arrived back-to-back so we can fold them into a single
 *  `● Read 3 files (foo.ts, bar.ts, baz.ts)` summary line.
 *
 *  Why a module-level buffer rather than a render-time transform:
 *  scrollback is append-only terminal history — once a row is written
 *  via `process.stdout.write` it can't be rewritten. Claude Code does
 *  this transform purely at render time because Ink owns its entire
 *  transcript and re-renders on every state change; we don't have that
 *  affordance, so the only way to "merge" is to delay committing the
 *  individual rows until we know whether more will follow.
 *
 *  Flush is triggered when (a) any non-collapsible message hits
 *  `writeMessageToStdout` (assistant text, write tool, user message —
 *  these break the chain) or (b) `flushPendingReadGroup` is called
 *  externally, e.g. ChatInput's commit pass at end-of-turn.
 *
 *  Consequence the user can perceive: a single isolated read tool
 *  doesn't appear in scrollback until the assistant emits its closing
 *  text (or the turn ends). The live tool indicator covers the gap
 *  while the chain runs, so the delay is invisible during normal flow.
 *  Tradeoff is acceptable for the win on multi-read chains, which are
 *  the noisy case that motivated this. */
let pendingReadGroup: DisplayToolCall[] = []

/** True when `msg` is a single-message bundle of completed, non-edit,
 *  read-only tool calls and nothing else (no assistant text, no command
 *  kind). Such messages are buffer-eligible — anything else flushes the
 *  buffer first and renders normally. */
function isCollapsibleMessage(msg: DisplayMessage): boolean {
  if (msg.role !== 'assistant') return false
  if (msg.content) return false
  if (msg.kind) return false
  if (!msg.toolCalls || msg.toolCalls.length === 0) return false
  return msg.toolCalls.every(
    (tc) => tc.status === 'completed' && !tc.editPayload && isCollapsibleReadOnlyTool(tc.toolName),
  )
}

/** Render one tool row (single-tool flush path) — same shape as
 *  `formatToolCall` produces inside `writeMessageToStdout`'s tool loop.
 *  Extracted so flush can reuse it without re-deriving the prepend-blank
 *  rule. */
function writeToolRow(write: InkWrite, tc: DisplayToolCall): void {
  const lead = prevWriteEndedWithBlankRow ? '' : '\n'
  write(toCRLF(lead + normalizeLineEndings(formatToolCall(tc)) + '\n'))
  prevWriteEndedWithBlankRow = false
  prevWriteWasStreamingChunk = false
}

/** Render the collapsed-group summary line, e.g.
 *    ` ● Read 3 files (foo.ts, bar.ts, baz.ts)`
 *  Format mirrors a regular tool row so the visual rhythm is preserved:
 *  green bullet (all members are completed), bold label, BLUE_PURPLE
 *  paren'd detail. No `⎿` result body — the whole point of collapsing
 *  is to drop the per-call result rows. */
function writeCollapsedGroup(write: InkWrite, tools: readonly DisplayToolCall[]): void {
  const { label, detail } = formatReadGroupSummary(tools)
  const detailSuffix = detail ? c.hex(BLUE_PURPLE)(`(${detail})`) : ''
  const line = ` ${c.hex(SUCCESS)(GLYPH_BULLET)} ${c.bold(label)}${detailSuffix}`
  const lead = prevWriteEndedWithBlankRow ? '' : '\n'
  write(toCRLF(lead + line + '\n'))
  prevWriteEndedWithBlankRow = false
  prevWriteWasStreamingChunk = false
}

/** Commit any buffered consecutive read-only tool calls to scrollback.
 *  Single tool → renders as a normal tool row (with its result body, so
 *  isolated reads don't lose their result blurb). Two or more → folds
 *  into one summary line. Idempotent — safe to call when buffer empty.
 *
 *  Called automatically at the top of `writeMessageToStdout` for every
 *  non-collapsible message, and externally by ChatInput's commit pass
 *  when `isLoading` is false (so a chain that ends without a closing
 *  text message — e.g. user abort — still gets its summary committed
 *  rather than left dangling in the buffer). */
export function flushPendingReadGroup(write: InkWrite): void {
  if (pendingReadGroup.length === 0) return
  const buffered = pendingReadGroup
  pendingReadGroup = []
  if (buffered.length === 1) {
    writeToolRow(write, buffered[0]!)
  } else {
    writeCollapsedGroup(write, buffered)
  }
}

/** Print a DisplayMessage to stdout. */
export function writeMessageToStdout(write: InkWrite, msg: DisplayMessage): void {
  // Read-group buffering: a message that bundles only completed,
  // non-edit, read-only tool calls is held in `pendingReadGroup` until
  // the next non-collapsible message arrives or `flushPendingReadGroup`
  // is called externally. The flush at the top of every other branch
  // commits any accumulated reads BEFORE the current message renders,
  // so chain summaries land in correct scrollback order
  // (` ● Read 3 files` above ` …final assistant text`).
  if (isCollapsibleMessage(msg)) {
    for (const tc of msg.toolCalls!) pendingReadGroup.push(tc)
    return
  }
  flushPendingReadGroup(write)

  if (msg.role === 'user') {
    const content = normalizeLineEndings(msg.content)
    debugLog('stdout.user', content)
    writeUserMessage(write, content, msg.kind === 'command-echo')
    // writeUserMessage always emits a trailing `\n\n` (or `\n` for the
    // compact slash-echo) — in both cases the next entity will sit on a
    // fresh row with the preceding blank already in place.
    prevWriteEndedWithBlankRow = msg.kind !== 'command-echo'
    prevWriteWasStreamingChunk = false
    return
  }

  // Compact slash-command result — render as a tight `  ⎿  text` line so the
  // pair `> /cmd` + result shows up as the Claude-style 2-line block instead
  // of command + blank + indented body + blank.
  //
  // Body lines go through `renderInlineMarkdown` so `**name**` / `` `code` `` /
  // `_italic_` markers our slash-command handlers emit display styled rather
  // than as raw `**` / backtick characters. We deliberately do NOT wrap the
  // body in `c.gray(...)` even though that's the conventional "secondary
  // info" tint: the gray base dims everything inside it (incl. bold and
  // truecolor inline-code), so the markdown rendering visually disappears
  // — bold gray-on-gray reads as just gray, and the blue-purple inline-code
  // color loses its contrast against a gray surround. The `⎿` glyph stays
  // gray as the structural marker; body content uses the terminal default
  // foreground so bold + inline-code stand out against it.
  if (msg.kind === 'command-result' && msg.content) {
    const content = normalizeLineEndings(msg.content)
    debugLog('stdout.command-result', content)
    const lines = content.split('\n')
    const head = `  ${c.gray(GLYPH_RESULT_BRACKET)}  ${renderInlineMarkdown(lines[0] ?? '')}`
    const tail = lines.slice(1).map((l) => `${RESULT_INDENT}${renderInlineMarkdown(l)}`)
    write(toCRLF([head, ...tail].join('\n') + '\n'))
    prevWriteEndedWithBlankRow = false
    prevWriteWasStreamingChunk = false
    return
  }

  // Assistant message — may have tool calls, a text body, or both.
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      debugLog('stdout.tool-call-line', `${tc.toolName} ${tc.status}`)
      // Prepend a `\n` if the previous write (most often the final
      // streaming-chunk of an assistant text body) didn't leave a blank
      // row below it. Without this guard, text→tool transitions paste
      // the bullet row directly under the text — exactly the "no
      // breathing room above the tool" issue the user flagged. After
      // writes that already ended with `\n\n` the flag is true and we
      // skip the leading newline so we don't double-blank.
      const lead = prevWriteEndedWithBlankRow ? '' : '\n'
      write(toCRLF(lead + normalizeLineEndings(formatToolCall(tc)) + '\n'))
      prevWriteEndedWithBlankRow = false
      prevWriteWasStreamingChunk = false
    }
  }

  if (msg.content) {
    const content = normalizeLineEndings(msg.content)
    debugLog(msg.streamingChunk ? 'stdout.assistant-chunk' : 'stdout.assistant-full', content)
    // Skip the leading-blank when this chunk is continuing a previous
    // streaming chunk from the same assistant message — the prior chunk
    // already left the cursor on the next row via its trailing `\n`,
    // and prepending another `\n` would render as a visible blank
    // between adjacent list items / paragraph lines whose only
    // separator in the model's source was a single newline. The blank
    // is still added on text→text transitions across non-streaming
    // entities (tool result → final text) so nothing butts together.
    const isStreamContinuation = !!msg.streamingChunk && prevWriteWasStreamingChunk
    if (!prevWriteEndedWithBlankRow && !isStreamContinuation) {
      write(toCRLF('\n'))
      prevWriteEndedWithBlankRow = true
    }

    // Special-case pure-whitespace streaming chunks (e.g. a bare "\n"
    // = paragraph break marker between two lines of prose). Markdown
    // rendering collapses these to an empty string, which would drop
    // the visual paragraph break — so pass the whitespace through
    // directly instead.
    if (msg.streamingChunk && content.trim() === '') {
      // A bare paragraph-break token. It already encodes a blank line
      // (whitespace-only `\n` or `\n\n`); after writing it the cursor
      // sits below a blank row, so the next entity doesn't need to
      // prepend another one.
      write(toCRLF(content))
      prevWriteEndedWithBlankRow = content.endsWith('\n\n') || content.endsWith('\n')
      prevWriteWasStreamingChunk = true
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
      // A streaming chunk that ends with `\n\n` is a paragraph-break
      // boundary (renderMarkdown puts \n\n after a heading + blank line
      // pair, etc.) — the next entity sits below a real blank row.
      // Anything else only ended with a single `\n`, so we still need
      // the next entity to draw its own blank above.
      prevWriteEndedWithBlankRow = out.endsWith('\n\n')
      prevWriteWasStreamingChunk = true
    } else {
      write(toCRLF(indented + '\n\n'))
      prevWriteEndedWithBlankRow = true
      prevWriteWasStreamingChunk = false
    }
  }
}

/**
 * Echo a user message in full. For multi-line content we indent continuation
 * lines with two spaces so they align under the text that followed the `❯`
 * prompt glyph on the first line. `content` is assumed to have already been
 * normalized to use `\n` line separators.
 *
 * `compact` is set for slash-command echoes: we drop the trailing blank
 * line so the `  ⎿  result` line that follows sits flush under the echo,
 * matching Claude Code's 2-line command block.
 */
function writeUserMessage(write: InkWrite, content: string, compact = false): void {
  const arrow = c.hex(PROMPT_BORDER)(GLYPH_PROMPT_ARROW)
  const lines = content.split('\n')
  const [first = '', ...rest] = lines
  const indentedRest = rest.map((line) => `  ${line}`)
  const body = [`${arrow} ${first}`, ...indentedRest].join('\n')
  // Leading \n gives one blank row of margin-top so the echo doesn't
  // crowd against the previous assistant reply's last line of content.
  // Explicit CRLF line breaks — see toCRLF() above for rationale.
  const trailing = compact ? '\n' : '\n\n'
  write(toCRLF('\n' + body + trailing))
}
