// @x-code-cli/cli — Render a writeFile / edit diff payload to ANSI text.
//
// Output is a multi-line string ready for the scrollback writer. Layout
// mirrors Claude Code's StructuredDiff: per-line gutter with right-
// aligned line number + sigil, then syntax-highlighted code padded to
// fill the column so the red/green background reaches the right edge.
//
// Each rendered line is prefixed with RESULT_INDENT so the diff sits
// directly under the tool-call bullet in scrollback (`   ⎿  Added X
// lines, removed Y` header, then 6-space-indented diff body).
//
// Two render paths share the same gutter / column / highlight pipeline:
//   - update path (`renderHunks`): hunks with green/red bg + sigil
//   - create path (`renderCreatePreview`): first N lines of new content,
//     no diff bg (the whole file is "new" — bg coloring every row would
//     be visual noise), but same syntax highlighting and gutter style.
import { Chalk } from 'chalk'

import type { EditDiffHunk, EditDiffPayload } from '@x-code-cli/core'

import { type SyntaxThemeName, applyColor, detectLanguage, highlightLine } from './syntax-highlight.js'
import { sliceByWidth, visualWidth } from './text-width.js'
import { type ThemeName, getThemeColors } from './theme.js'
import { RESULT_INDENT } from './utils.js'

const c = new Chalk({ level: 3 })

/** Apply a theme's diff bg color to text. Three value shapes:
 *   - `'#rrggbb'` — true-color hex, via chalk.bgHex
 *   - `'ansi:default'` — leave bg untouched (terminal default). The
 *     ANSI-only themes use this and rely on a colored DECORATION fg
 *     to mark `-` lines; bg coloring would over-paint the user's
 *     terminal background.
 *   - `'ansi:green'` / `'ansi:red'` — named ANSI bg (currently unused
 *     but kept for completeness). */
function applyBg(text: string, color: string): string {
  if (color === 'ansi:default') return text
  if (color.startsWith('ansi:')) {
    const name = color.slice(5)
    if (name === 'green') return c.bgGreen(text)
    if (name === 'red') return c.bgRed(text)
    if (name === 'blue') return c.bgBlue(text)
    if (name === 'yellow') return c.bgYellow(text)
    return text
  }
  return c.bgHex(color)(text)
}

/** Apply a theme's gutter (line number + sigil) fg color. Mirrors
 *  applyBg — same value shapes, fg-side. CC paints the gutter in a
 *  saturated decoration color so the line-number column pops off the
 *  near-black bg; without it, "1 +" disappears into the diff bg. */
function applyGutterFg(text: string, color: string): string {
  if (color === 'ansi:green') return c.green(text)
  if (color === 'ansi:red') return c.red(text)
  if (color === 'ansi:blue') return c.blue(text)
  if (color === 'ansi:yellow') return c.yellow(text)
  if (color.startsWith('#')) return c.hex(color)(text)
  return text
}

/** Cap an individual diff body's height. Multi-hunk patches with hundreds
 *  of lines aren't useful in scrollback (the user would scroll past most
 *  of it anyway); after the cap we collapse to a `… +N more lines` row.
 *  Matches Claude Code's behavior of clipping long structured diffs. */
const MAX_DIFF_LINES = 60

/** Cap on the create-mode content preview. Claude Code's
 *  FileWriteToolCreatedMessage uses MAX_LINES_TO_RENDER = 10; we follow
 *  the same number so a freshly-created package.json / config file shows
 *  enough to be useful but doesn't dominate the scrollback. */
const MAX_CREATE_PREVIEW_LINES = 10

/** Format the count summary line ("Added 3 lines, removed 1 line"). */
function formatCounts(p: EditDiffPayload): string {
  if (p.isCreate) {
    const n = p.additions
    return `Created ${c.bold(String(n))} ${n === 1 ? 'line' : 'lines'}`
  }
  const parts: string[] = []
  if (p.additions > 0) {
    parts.push(`Added ${c.bold(String(p.additions))} ${p.additions === 1 ? 'line' : 'lines'}`)
  }
  if (p.removals > 0) {
    const verb = parts.length > 0 ? 'removed' : 'Removed'
    parts.push(`${verb} ${c.bold(String(p.removals))} ${p.removals === 1 ? 'line' : 'lines'}`)
  }
  if (parts.length === 0) return 'No changes'
  return parts.join(', ')
}

/** Pick the largest visible line number across all hunks so every gutter
 *  is the same width — keeps the sigil column aligned across hunks. */
function maxLineNumber(hunks: EditDiffHunk[]): number {
  let max = 1
  for (const h of hunks) {
    const o = h.oldStart + h.oldLines - 1
    const n = h.newStart + h.newLines - 1
    if (o > max) max = o
    if (n > max) max = n
  }
  return max
}

/** Walk a hunk's `lines` array, assigning each line its file-relative
 *  number. Follows the standard unified-diff convention: `-` rows are
 *  numbered against the OLD file, `+` and context rows against the NEW
 *  file. Each counter advances independently so consecutive remove rows
 *  get distinct old-file numbers. */
function numberLines(h: EditDiffHunk): { sigil: ' ' | '+' | '-'; code: string; lineNum: number }[] {
  const out: { sigil: ' ' | '+' | '-'; code: string; lineNum: number }[] = []
  let oldN = h.oldStart
  let newN = h.newStart
  for (const raw of h.lines) {
    const sigil = raw[0] === '+' ? '+' : raw[0] === '-' ? '-' : ' '
    const code = raw.slice(1)
    if (sigil === '-') {
      out.push({ sigil, code, lineNum: oldN })
      oldN++
    } else if (sigil === '+') {
      out.push({ sigil, code, lineNum: newN })
      newN++
    } else {
      out.push({ sigil, code, lineNum: newN })
      oldN++
      newN++
    }
  }
  return out
}

/** Truncate a single code line so the rendered row fits the column. The
 *  width budget is the terminal width minus the indent and the gutter. We
 *  use a UTF ellipsis to mark the cut, matching the tool-input preview.
 *
 *  Both the fits-check and the slice operate on VISUAL columns, not JS
 *  string units. CJK / fullwidth chars take 2 cells but `length === 1`,
 *  so a length-based check would let a 50-char Chinese line slip past a
 *  100-cell budget while actually overshooting by 50 cells — the terminal
 *  would then wrap mid-row and produce a spurious blank below every diff
 *  line. */
function fitCode(code: string, width: number): string {
  if (visualWidth(code) <= width) return code
  if (width < 1) return ''
  return sliceByWidth(code, Math.max(0, width - 1)) + '…'
}

/**
 * Render the diff body. Returns a string with N lines (no leading or
 * trailing newline). Each line is already indented by RESULT_INDENT.
 *
 * `terminalWidth` is the full terminal width — the function reserves
 * RESULT_INDENT.length cells for the indent and computes the gutter +
 * code column from what remains. Falls back to 120 if the terminal width
 * is unknown / nonsensical.
 */
function renderHunks(
  payload: EditDiffPayload,
  terminalWidth: number,
  syntaxTheme?: SyntaxThemeName,
  /** UI theme to read diff bg colors from. `undefined` → use the
   *  module-level active theme (real renders). The `/theme` picker
   *  passes each candidate theme's name when building previews so the
   *  user sees each theme's actual diff colors side by side. */
  uiTheme?: ThemeName,
): string[] {
  const themeColors = getThemeColors(uiTheme)
  // ANSI mode is detected by the `'ansi:default'` bg sentinel — those
  // themes can't paint hex bg (16-color compat), so they communicate
  // remove rows via DIM instead. Mirrors CC color-diff/index.ts:924.
  const isAnsiMode = themeColors.diffAdded === 'ansi:default'
  // CC paints unhighlighted text inside diff rows in `Theme.foreground`
  // (#f8f8f2 dark / #333333 light). Without it our unmatched chars
  // fall back to terminal default `#cccccc` and read as visibly dimmer
  // than CC. ANSI themes pass null (honor terminal palette).
  const defaultFg = themeColors.defaultFg
  const cols = Math.max(40, terminalWidth)
  const lineNumWidth = Math.max(1, String(maxLineNumber(payload.hunks)).length)
  // Gutter format: " <num> <sigil> " — 1 leading space + num + 1 space +
  // sigil + 1 trailing space.
  const gutterWidth = lineNumWidth + 4
  // Reserve 1 trailing cell of safety: `-`/`+` rows pad their code column
  // with bg-colored spaces so the diff band reaches the right edge. If the
  // row's printable width hits exactly `cols`, the terminal enters
  // delayed-wrap state at the last column; Windows conhost / Windows
  // Terminal in some configurations counts that as a wrap and inserts a
  // phantom blank row below every padded `-`/`+` line. Leaving one cell
  // unpainted keeps the cursor strictly inside the row.
  const codeWidth = Math.max(1, cols - RESULT_INDENT.length - gutterWidth - 1)
  const lang = detectLanguage(payload.filePath)

  const out: string[] = []
  let emitted = 0
  let truncated = 0

  for (let hi = 0; hi < payload.hunks.length; hi++) {
    if (hi > 0) {
      // Hunk separator — Claude Code uses a dimmed `...` row.
      out.push(`${RESULT_INDENT}${c.gray('...')}`)
    }
    const hunk = payload.hunks[hi]!
    const numbered = numberLines(hunk)
    for (const { sigil, code, lineNum } of numbered) {
      if (emitted >= MAX_DIFF_LINES) {
        truncated++
        continue
      }
      emitted++

      const numStr = String(lineNum).padStart(lineNumWidth)
      const fitted = fitCode(code, codeWidth)
      // Pad against the RAW (pre-highlight) text so the colored bg fills
      // exactly to the right edge. Highlighting only adds escape codes —
      // it doesn't change the visible character count. Use visual width
      // (CJK chars are 2 cells wide despite `length === 1`); a length-
      // based padding would over-pad by `visualWidth - length` and make
      // the row wrap into a blank visual line below every CJK diff row.
      const padding = ' '.repeat(Math.max(0, codeWidth - visualWidth(fitted)))
      const gutter = ` ${numStr} ${sigil} `
      // Syntax highlighting is applied to CONTEXT rows only. On +/- rows
      // we render plain text on top of the diff bg — multi-color
      // highlighting on top of a saturated red/green band fights the bg
      // visually and reads as noise. Claude Code's fallback diff renders
      // diff bodies as plain text on bg for the same reason; the bg
      // alone communicates add/remove and the surrounding context lines
      // give the eye full-color anchors.
      let styled: string
      if (sigil === '+') {
        // `+` row: bg + decorated gutter + syntax-highlighted code.
        // CC always highlights `+` lines (they ARE the new code).
        // We pre-paint the gutter in the theme's add-decoration color
        // BEFORE wrapping the row in bg, so the colored fg sticks.
        // defaultFg is threaded through so unmatched chars (`;`, `(`,
        // `)`, `{`, `}`) and undecorated identifiers (e.g. `log` in
        // `console.log`) get CC's bright cream/dark-gray instead of
        // the terminal default white.
        const code = highlightLine(fitted, lang, syntaxTheme, defaultFg)
        const coloredGutter = applyGutterFg(gutter, themeColors.diffAddedDecoration)
        styled = applyBg(coloredGutter + code + padding, themeColors.diffAdded)
      } else if (sigil === '-') {
        // `-` row: bg + decorated gutter + PLAIN code (no syntax
        // highlighting, ever — including in picker previews). CC's
        // color-diff/index.ts:916-918 always passes the `-` line
        // through `defaultStyle(theme)` instead of highlightLine, so
        // the deleted text is white-on-red across both real diffs and
        // theme previews. Multi-color fg on top of the saturated red
        // bg also fights itself visually; plain text reads as "this
        // is going away" more cleanly. We DO apply defaultFg though —
        // it's how CC's `defaultStyle` makes the deleted text visibly
        // brighter than terminal default.
        const plainCode = defaultFg ? applyColor(fitted, defaultFg) : fitted
        const coloredGutter = applyGutterFg(gutter, themeColors.diffRemovedDecoration)
        let row = applyBg(coloredGutter + plainCode + padding, themeColors.diffRemoved)
        // ANSI mode has no bg to mark the remove row, so dim the whole
        // line instead — matches CC's `dimContent` (color-diff/
        // index.ts:924). Without this, ANSI-mode `-` rows are visually
        // indistinguishable from `+` rows.
        if (isAnsiMode) row = c.dim(row)
        styled = row
      } else {
        // Context row: full syntax highlighting, no bg, gutter in
        // default fg (matches CC's addLineNumber path for marker===' ').
        // defaultFg here keeps brightness consistent across context and
        // +/- rows — CC paints all three from the same Theme.foreground.
        const highlighted = highlightLine(fitted, lang, syntaxTheme, defaultFg)
        styled = gutter + highlighted + padding
      }
      out.push(`${RESULT_INDENT}${styled}`)
    }
  }

  if (truncated > 0) {
    out.push(`${RESULT_INDENT}${c.gray(`… +${truncated} more line${truncated === 1 ? '' : 's'}`)}`)
  }

  return out
}

/**
 * Render the first ~10 lines of newly-created file content as a preview
 * block. Same gutter style + syntax highlight as the update path — what
 * distinguishes create from update visually is the absence of the diff
 * bg: bg-coloring every row green for a brand-new file would be visual
 * noise without communicating any information (there's nothing to
 * compare against). Truncated tail collapses to `… +N lines`.
 */
function renderCreatePreview(
  filePath: string,
  content: string,
  terminalWidth: number,
  theme?: SyntaxThemeName,
): string[] {
  const cols = Math.max(40, terminalWidth)
  const allLines = content.split('\n')
  // Drop a single trailing empty line — most file content ends with `\n`,
  // splitting yields an empty string we don't want to render.
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop()
  if (allLines.length === 0) return []

  const visible = allLines.slice(0, MAX_CREATE_PREVIEW_LINES)
  const truncated = allLines.length - visible.length
  const lineNumWidth = Math.max(1, String(allLines.length).length)
  const gutterWidth = lineNumWidth + 2 // " <num> "
  const codeWidth = Math.max(1, cols - RESULT_INDENT.length - gutterWidth)
  const lang = detectLanguage(filePath)

  const out: string[] = []
  for (let i = 0; i < visible.length; i++) {
    const numStr = String(i + 1).padStart(lineNumWidth)
    const fitted = fitCode(visible[i] ?? '', codeWidth)
    const highlighted = highlightLine(fitted, lang, theme)
    out.push(`${RESULT_INDENT}${c.gray(` ${numStr} `)}${highlighted}`)
  }
  if (truncated > 0) {
    out.push(`${RESULT_INDENT}${c.gray(`… +${truncated} ${truncated === 1 ? 'line' : 'lines'}`)}`)
  }
  return out
}

/**
 * Render the full diff block (counts header + hunk body or content
 * preview) as the body of a tool-call result row. The first line is meant
 * to follow the `   ⎿  ` prefix that stdout-writer emits, so we DON'T
 * prepend the prefix here — the caller stitches everything together.
 *
 * Returns:
 *   - line[0]: counts summary (e.g. "Added 3 lines, removed 1 line" /
 *              "Created 20 lines")
 *   - line[1..]: diff hunks (update path) or content preview (create path)
 *
 * Update payloads with no hunks (timed-out diff) collapse to the header
 * only — there's no patch to render.
 */
/** Render a fixed JS snippet diff under the given UI theme — used by
 *  the `/theme` and first-run pickers to show a live color preview for
 *  the focused option. The hunk is hand-built (4 lines, 1 swap) rather
 *  than going through computeEditDiff so the picker doesn't drag in the
 *  diff library on the cold path.
 *
 *  The picker passes the candidate theme's name; we look up the
 *  theme's diff colors AND its associated syntax palette so the
 *  preview shows BOTH parts of the theme (bg + code colors) varying
 *  together — that's the whole point of the picker.
 *
 *  Drops the leading RESULT_INDENT from each row so the preview sits
 *  flush to the dialog's left margin (it's not nested under a tool
 *  bullet — it's a standalone block). */
export function buildThemePreview(themeName: ThemeName, terminalWidth: number): string[] {
  const theme = getThemeColors(themeName)
  const payload: EditDiffPayload = {
    filePath: 'preview.ts',
    hunks: [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [' function greet() {', '-  console.log("Hello, World!");', '+  console.log("Hello, X-Code!");', ' }'],
      },
    ],
    additions: 1,
    removals: 1,
    isCreate: false,
  }
  return renderHunks(payload, terminalWidth, theme.syntaxPalette, themeName).map((row) =>
    row.startsWith(RESULT_INDENT) ? row.slice(RESULT_INDENT.length) : row,
  )
}

export function renderEditDiff(payload: EditDiffPayload, terminalWidth: number, theme?: SyntaxThemeName): string[] {
  const header = formatCounts(payload)
  if (payload.isCreate) {
    if (!payload.content) return [header]
    return [header, ...renderCreatePreview(payload.filePath, payload.content, terminalWidth, theme)]
  }
  if (payload.hunks.length === 0) return [header]
  return [header, ...renderHunks(payload, terminalWidth, theme)]
}
