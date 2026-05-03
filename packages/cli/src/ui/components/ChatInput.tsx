// @x-code-cli/cli — Bottom dynamic region (spinner + input box) AND the
// scrollback commit path for new messages.
//
// RENDERING STRATEGY — CELL-LEVEL DIFF, DIRECT STDOUT:
//   Ink's Yoga layout and log-update both miscount CJK/IME widths. Even
//   the @jrichman/ink fork doesn't fully eliminate jitter on Windows
//   ConHost because terminal-level CJK rendering isn't atomic. To dodge
//   both engines we render the entire bottom region ourselves:
//
//     - Each frame = 2D grid of cells (char + style + visual width)
//     - Diff against the previous frame cell-by-cell
//     - Write ALL changes in a single process.stdout.write()
//     - Unchanged CJK cells are NEVER re-emitted → no redraw jitter
//
//   We return `null` to Ink so Ink's dynamic region is empty; we own
//   everything below the scrollback the user has already seen.
//
// THINGS THIS COMPONENT OWNS (instead of Ink):
//     - The loading spinner row (when `isLoading` is true)
//     - Top/bottom separator lines
//     - Input text with cursor
//     - Slash-command completion menu
//     - In-frame Permission and SelectOptions dialogs
//     - Committing newly-arrived `messages` to scrollback above the frame
//       (via writeMessageToStdout, collected into the same atomic payload
//       as the frame redraw — see the flush effect)
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'

import { useStdout } from 'ink'

import { debugLog, getPermissionLevel, suggestRuleLabel } from '@x-code-cli/core'
import type { DisplayMessage, TodoItem } from '@x-code-cli/core'

import { type FileEntry, applyCompletion, detectAtToken, scoreAndRank } from '../file-completion.js'
import type { ActiveToolCall } from '../hooks/use-agent.js'
import { useFileCompletion } from '../hooks/use-file-completion.js'
import { usePromptInput } from '../hooks/use-prompt-input.js'
import { type PastedContents, expandPasteRefs, formatPasteRef, stripTrailingRef } from '../paste-refs.js'
import { renderInlineMarkdown } from '../render-markdown.js'
import { lastWriteEndedWithBlankRow, writeMessageToStdout } from '../stdout-writer.js'
import {
  GLYPH_ACCEPT_EDITS,
  GLYPH_BULLET,
  GLYPH_ELLIPSIS,
  GLYPH_PLAN_MODE,
  GLYPH_RESULT_BRACKET,
  GLYPH_SELECT_POINTER,
  GLYPH_TODO_BRACKET,
  GLYPH_TODO_CHECK,
  GLYPH_TODO_IN_PROGRESS,
  GLYPH_TODO_PENDING,
  SPINNER_FRAMES,
} from '../terminal-glyphs.js'
import { getToolInputPreview, getToolLabel } from '../tool-display.js'

const PASTE_REF_MIN_LINES = 3
const PASTE_REF_MIN_CHARS = 400
const MAX_VISIBLE_LINES = 10
const MAX_AT_COMPLETIONS = 8

// ── CJK width helpers ───────────────────────────────────────────────────

function isWide(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fa1f) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3100 && cp <= 0x312f) ||
    (cp >= 0x3200 && cp <= 0x32ff) ||
    (cp >= 0x3300 && cp <= 0x33ff)
  )
}

function charWidth(ch: string): number {
  return isWide(ch.codePointAt(0)!) ? 2 : 1
}

function visualWidth(str: string): number {
  let w = 0
  for (const ch of str) w += charWidth(ch)
  return w
}

function sliceByWidth(str: string, maxCols: number): string {
  let w = 0,
    i = 0
  for (const ch of str) {
    const cw = charWidth(ch)
    if (w + cw > maxCols) break
    w += cw
    i += ch.length
  }
  return str.slice(0, i)
}

function truncateCellRow(cells: Cell[], maxWidth: number): Cell[] {
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

function skipByWidth(str: string, skipCols: number): number {
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
function truncatePathFromStart(p: string, maxCols: number): string {
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
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
}

/** Count display rows that `content` will occupy when written at the top of
 *  a blank area. Accounts for line wrap at `termWidth` using visual (CJK-aware)
 *  widths. A trailing `\n` is not counted as a row (cursor just advances to
 *  the next row but that row has no content). */
function countContentRows(content: string, termWidth: number): number {
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

// ── Types ───────────────────────────────────────────────────────────────

export interface SlashCommand {
  name: string
  description: string
}

export interface SpinnerState {
  label: string
  mode: 'requesting' | 'responding' | 'thinking' | 'tool-use'
}

export interface PermissionRequest {
  toolName: string
  input: Record<string, unknown>
  onResolve: (decision: 'yes' | 'always' | 'no') => void
}

export interface SelectRequest {
  question: string
  /** `freeform: true` marks the auto-appended "Other" row that opens an
   *  inline text input instead of resolving with the literal label.
   *  Mirrors Claude Code's `__other__` sentinel — kept as a flag here so
   *  the resolver returns the typed text directly without a sentinel
   *  round-trip.
   *
   *  `preview` carries pre-rendered ANSI lines that the dialog draws
   *  below the option list whenever this option is the focused one.
   *  Used by the `/syntax` picker to show a live color sample of each
   *  theme as the user arrows through. Each row should already be a
   *  complete ANSI-styled string — the dialog wraps it in a `RawAnsi`-
   *  like cell row without further processing. */
  options: { label: string; description: string; freeform?: boolean; preview?: string[] }[]
  onResolve: (answer: string) => void
  /** True for user-initiated pickers (slash commands like `/syntax`,
   *  `/model`) — Esc dismisses the dialog with an empty answer. AI-
   *  initiated dialogs (askUser tool, plan approval) leave this falsy:
   *  Esc is swallowed so the model isn't silently fed a blank answer. */
  dismissible?: boolean
  /** Controls how options with descriptions are rendered:
   *  - `compact` (default): label and description on the same line,
   *    right-padded into two aligned columns. Best for short labels.
   *  - `compact-vertical`: description on a separate indented line
   *    below the label. Best for long descriptions (askUser). */
  layout?: 'compact' | 'compact-vertical'
}

interface ChatInputProps {
  /** All scrollback messages. New entries are committed to the terminal
   *  scrollback (above our cell frame) via direct stdout writes. We own the
   *  entire bottom region — Ink must NOT also write scrollback, or its
   *  log-update will fight us for cursor position. */
  messages: readonly DisplayMessage[]
  /** Rows the startup banner (printHeader) occupies. Used to seed the
   *  "blank rows above frame" tracker so the first dialog grow doesn't
   *  needlessly pre-scroll rows the banner left blank. */
  initialContentRows?: number
  onSubmit: (text: string) => void
  /** Fired on Ctrl+C. Wired to the App's double-press handler — first press
   *  cancels the in-flight turn (if any) and arms the exit hint, second
   *  press within the arm window exits the process. */
  onInterrupt: () => void
  /** Fired on Esc when a turn is in flight (`isLoading`). Mirrors Claude
   *  Code's `chat:cancel`: cancels the AI request + running tool, but
   *  never exits the process. No-op when no modal is up. */
  onEscapeCancel?: () => void
  /** True while an AI request / tool is running. Drives the Esc-cancel
   *  routing and the `esc to interrupt` spinner hint. */
  isLoading?: boolean
  /** Transient one-line notice shown below the input box, in the same
   *  footer slot as the plan-mode / accept-edits indicators (e.g. "Press
   *  Ctrl+C again to exit"). Cleared by the parent after a short timeout. */
  notice?: string | null
  /** Ignore keyboard input (and hide the input cursor). */
  disabled?: boolean
  /** Fully hide the region (e.g. while a SelectOptions dialog is showing
   *  and Ink still owns the bottom region). */
  hidden?: boolean
  /** If non-null, render a spinner line above the input. */
  spinner?: SpinnerState | null
  /** In-flight tool calls. When non-empty, rendered in place of the generic
   *  "Thinking..." spinner: each call shows its own bullet + progress line
   *  (`● Tool(preview)` / `⎿ ⠋ progressText`). Progress text streams in via
   *  `onToolProgress`. Commits to scrollback via the regular tool-result
   *  DisplayMessage path once the tool finishes. */
  activeToolCalls?: readonly ActiveToolCall[]
  /** Live checklist from the model's `todoWrite` tool. Rendered as a
   *  compact panel above the spinner (☐ pending, ◼ in_progress, ✔
   *  completed). Empty array hides the panel — zero visual cost when
   *  the model isn't using TodoWrite. */
  todos?: readonly TodoItem[]
  /** Optional error string shown as a dedicated row above the spinner. */
  errorMessage?: string | null
  /** If non-null, render a Permission dialog inside our cell buffer AND
   *  route keyboard (Up/Down/Enter/y/n) to resolve it. Rendering it
   *  ourselves instead of letting Ink draw it is the ONLY way to avoid
   *  zombie frames: Ink's log-update uses the terminal's single DEC
   *  cursor-save register (`\x1b7`), which clobbers any position we try
   *  to anchor on — so after every Permission cycle we couldn't reliably
   *  erase the previous frame. With Permission inside our frame, Ink's
   *  dynamic region stays permanently empty and there's no contention. */
  permission?: PermissionRequest | null
  /** If non-null, render a select-options dialog inside our cell buffer AND
   *  route Up/Down/Enter to resolve it. Kept in-frame for the same reason
   *  as `permission`: Ink's dynamic region leaves blank rows in scrollback
   *  when a tall dialog unmounts, because terminal auto-scroll on growth
   *  isn't reversible on shrink. */
  selectRequest?: SelectRequest | null
  commands?: readonly SlashCommand[]
  /** Current approval mode, drives the indicator row beneath the input
   *  (`⏸ plan mode` / `⚡ accept edits`). Defaults to 'default' — no
   *  indicator rendered. */
  permissionMode?: 'default' | 'acceptEdits' | 'plan'
  /** Context-window occupancy for the right side of the footer row.
   *  Renders as `6.6k / 200k · 3%` — gives the user a quick "how full is
   *  the window" reading without staring at a single arrow-token number.
   *  Mirrors the Gemini-CLI / opencode pattern (token info lives in the
   *  footer, not next to the spinner). Pass null to hide entirely (e.g.
   *  before any API response has landed). */
  contextUsage?: { used: number; window: number } | null
}

// ── Reducer for atomic text + cursor updates ──────────────────────────

interface InputState {
  text: string
  cursor: number
}

type InputAction =
  | { type: 'INSERT'; pos: number; chunk: string }
  | { type: 'BACKSPACE_REF'; pos: number; deleteCount: number }
  | { type: 'DELETE'; pos: number }
  | { type: 'SET_CURSOR'; cursor: number }
  | { type: 'SET_TEXT'; text: string; cursor: number }
  | { type: 'RESET' }

function inputReducer(state: InputState, action: InputAction): InputState {
  switch (action.type) {
    case 'INSERT': {
      const { pos, chunk } = action
      return {
        text: state.text.slice(0, pos) + chunk + state.text.slice(pos),
        cursor: pos + chunk.length,
      }
    }
    case 'BACKSPACE_REF': {
      const { pos, deleteCount } = action
      if (pos === 0) return state
      return {
        text: state.text.slice(0, pos - deleteCount) + state.text.slice(pos),
        cursor: pos - deleteCount,
      }
    }
    case 'DELETE': {
      const { pos } = action
      if (pos >= state.text.length) return state
      return { text: state.text.slice(0, pos) + state.text.slice(pos + 1), cursor: state.cursor }
    }
    case 'SET_CURSOR':
      return state.cursor === action.cursor ? state : { ...state, cursor: action.cursor }
    case 'SET_TEXT':
      return { text: action.text, cursor: action.cursor }
    case 'RESET':
      return { text: '', cursor: 0 }
    default:
      return state
  }
}

// ── Cell representation ─────────────────────────────────────────────────

interface Cell {
  char: string
  style: string
  width: number
}

function cellsEqual(a: Cell, b: Cell): boolean {
  return a.char === b.char && a.style === b.style
}

/** Render a row of cells to a single ANSI-styled string (no cursor moves,
 *  no trailing erase). Used by the scrollback-commit inline-stream path
 *  so frame rows can be emitted as part of the `content + frame` stream. */
function renderRowToAnsi(cells: Cell[]): string {
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

// ── Palette ─────────────────────────────────────────────────────────────
// Hardcoded RGB ANSI escapes because cells store raw style strings (the
// cell-diff emitter can't run chalk). Values mirror `ui/theme.ts` which
// itself mirrors Claude Code's dark theme (src/utils/theme.ts darkTheme)
// — keep these two tables in sync.
const S_GRAY = '\x1b[38;2;136;136;136m' // promptBorder rgb(136,136,136) #888888
const S_ACCENT = '\x1b[38;2;215;119;87m' // claude rgb(215,119,87) #d77757
const S_ACCENT_BOLD = '\x1b[38;2;215;119;87;1m'
const S_ACCENT_DIM = '\x1b[38;2;153;153;153m' // inactive rgb(153,153,153) #999999
const S_SPINNER = '\x1b[38;2;147;165;255m' // claudeBlue rgb(147,165,255) #93a5ff
const S_SUCCESS = '\x1b[38;2;78;186;101;1m' // success rgb(78,186,101) #4eba65
// Non-bold variant of SUCCESS — used for the live tool `●` bullet so it
// matches the committed `stdout-writer.formatToolCall` output exactly
// (`c.hex(SUCCESS)('●')` is non-bold there). If live used the bold variant,
// the dot would visibly "de-bold" at the moment the tool finishes.
const S_SUCCESS_DOT = '\x1b[0m\x1b[38;2;78;186;101m'
// Dim half of the running-tool bullet pulse animation. Same green hue as
// S_SUCCESS_DOT, but with the ANSI dim attribute (2) layered on top so
// terminals render it as a subdued shade of the same color rather than
// a different color entirely. Toggling between this and S_SUCCESS_DOT
// every few spinner frames produces the bright↔dim "heartbeat" CC uses
// to signal a tool is actively running, so the user can tell at a glance
// which committed line in scrollback turned into the live row.
const S_SUCCESS_DOT_DIM = '\x1b[0m\x1b[38;2;78;186;101;2m'
// Bold with NO foreground color — matches committed `c.bold(label)`.
// Must start with `\x1b[0m` to reset any prior foreground so bold doesn't
// inherit a color from the preceding cell (same reasoning as S_DIM).
const S_BOLD = '\x1b[0m\x1b[1m'
// BLUE_PURPLE (permission rgb(177,185,249) #b1b9f9) — used for the
// `(preview)` inside the live tool bubble to match committed
// `c.hex(BLUE_PURPLE)('(...)')`. Previously used S_SPINNER blue here
// (147,165,255) which is a DIFFERENT shade, producing a visible
// color shift at the live→committed handoff.
const S_BLUE_PURPLE = '\x1b[0m\x1b[38;2;177;185;249m'
const S_BLUE_PURPLE_DIM = '\x1b[0m\x1b[38;2;177;185;249;2m'
const S_BLUE_PURPLE_BOLD = '\x1b[0m\x1b[38;2;177;185;249;1m'
const S_WARNING = '\x1b[38;2;255;193;7m' // warning rgb(255,193,7) #ffc107
const S_WARNING_BOLD = '\x1b[38;2;255;193;7;1m'
const S_ERROR_FG = '\x1b[38;2;255;107;128m' // error rgb(255,107,128) #ff6b80
const S_ERROR_BOLD = '\x1b[38;2;255;107;128;1m'
// NB: leading `\x1b[0m` matters. Plain `\x1b[2m` just adds the "dim"
// attribute ON TOP of whatever foreground color is active — so meta
// text rendered after a colored span (e.g. the spinner row, where
// S_SPINNER blue is emitted just before the meta transition) comes out
// as BLUE-dim instead of gray-dim. And on a spinner tick where only
// the seconds cell changes, the diff loop emits S_NONE (reset) first
// and then S_DIM starting from the seconds digit — so the SAME meta
// text is redrawn as WHITE-dim. Result: meta flashes white/blue every
// tick depending on which diff path fires ("一会白一会蓝"). Resetting
// SGR first then applying dim pins the color to the terminal default,
// so meta looks consistent regardless of prior SGR state.
const S_DIM = '\x1b[0m\x1b[2m'
// ANSI 90 (bright black). Equivalent to chalk's `c.gray()` output —
// `c.gray('⎿')` emits `\x1b[90m...\x1b[39m`. Use this for cells that
// MUST visually match a `c.gray()`-styled glyph in committed scrollback
// (currently: the `⎿` connector and the `(duration)` suffix in tool
// rows). S_DIM (`\x1b[2m` = dim attribute on default fg) renders as a
// noticeably different shade than `\x1b[90m` (explicit palette entry)
// on most terminals — the user perceives a color flash on the moment
// a tool finishes and its row switches from live frame to scrollback.
const S_GRAY_90 = '\x1b[0m\x1b[90m'
// S_NONE means "default styling — no fg color, no attribute" and MUST
// be a non-empty escape, otherwise the cell-diff loop's
// `if (cell.style !== lastStyle) buf += cell.style` branch emits an
// empty string and leaves the terminal SGR state inherited from
// whatever preceded it. That used to render rows like
// `[' '(NONE)][glyph(BLUE)][' '(NONE)][T(BLUE)]…` with the trailing
// NONE space inheriting the BLUE — and with non-atomic terminals the
// user perceived the "Thinking" text flashing white→blue between
// frames as redundant SGR codes arrived just after the chars. Setting
// S_NONE to the explicit DEC reset (`\x1b[0m`, same byte as S_RESET)
// makes every NONE cell explicitly clear styling before its glyph,
// which removes the inheritance and the perceived flash.
// Reset ALL attributes at row end (\x1b[0m), not just foreground (\x1b[39m).
// Bold cells (e.g. Permission's Yes/No highlight) would otherwise bleed
// their bold attribute into the next row. The cell-diff emitter re-emits
// any non-empty style on the first cell of the next row, so a full reset
// here is safe.
const S_RESET = '\x1b[0m'
const S_NONE = '\x1b[0m'
// Inverse-video block used to PAINT the input cursor's position as a
// regular cell. The real terminal cursor is hidden app-wide (see the
// useEffect at component mount), so this is the only thing the user
// sees as "the cursor". Updates atomically with the rest of the cell-
// diff frame, so it never flickers on its own. Mirrors Gemini CLI's
// `<Text terminalCursorFocus>` approach (renders an inverse-video
// block at the caret position) and Claude Code's same hidden-cursor
// strategy.
const S_CURSOR = '\x1b[7m'

// NOTE: `\x1b7` / `\x1b8` (DECSC / DECRC) are DELIBERATELY NOT used
// anywhere in this file. The terminal provides a single save register,
// and Ink's own log-update reuses it on every render cycle — co-owning
// it from two places was producing "ghost" restore positions. We
// reconstruct cursor position with relative moves (CUU / CUD / \r /
// \x1b[NG absolute-column) and by treating post-dialog transitions as
// fresh first-paints (prevFrameRef cleared), which removes the cross-
// writer contention entirely. See the wasHidden handler below for the
// transition-case reasoning.

/** DEC 2026 "Synchronized Update Mode". Between BSU and ESU, supported
 *  terminals buffer all output and render it as a single atomic frame.
 *  This eliminates the flash that otherwise occurs between eraseRegion
 *  wiping the frame and the full re-render that follows — the user sees
 *  only the final state, never the intermediate blank region.
 *  Unsupported terminals silently ignore these sequences.
 *
 *  Cursor visibility is intentionally NOT toggled around each render.
 *  Earlier revisions cycled `\x1b[?25l` in BSU and `\x1b[?25h` in ESU to
 *  mask the diff-loop's intermediate cursor positions on terminals that
 *  don't fully atomize DEC 2026. At the 80ms spinner cadence that
 *  produced a 12Hz hide/show flap which users perceived as "上下抖动"
 *  flicker around the input row — and sync-mode batching already hides
 *  the intermediate positions on every terminal we target (xterm.js /
 *  VSCode, Windows Terminal, iTerm2, Ghostty). So: the cursor stays
 *  shown throughout; sync mode handles atomicity; the end-of-buf park
 *  places it at the input column before ESU commits. When there is no
 *  active anchor (disabled / dialog) ESU_HIDE explicitly hides. */
const BSU = '\x1b[?2026h'
const ESU_SHOW = '\x1b[?2026l\x1b[?25h'
const ESU_HIDE = '\x1b[?2026l\x1b[?25l'

// NOTE: a DECSTBM-based `buildInsertHistoryAbove` existed briefly here
// (modeled on codex-rs insert_history.rs) but was reverted because it
// required the cell buffer to be anchored at the very bottom of the
// terminal — true in codex-rs (ratatui's Terminal manages a viewport
// rect), but NOT true in our setup, where the banner + partial scroll
// state can leave the cell buffer mid-screen. Setting a scroll region
// `[1, termRows - cellBufH]` then overlapped the live cell buffer rows,
// so history writes tore through the frame. Re-attempting this fix
// properly needs a "force cell buffer to the last N rows via absolute
// cursor positioning on every render" refactor — tracked separately.

function textToCells(text: string, style: string): Cell[] {
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
function ansiTextToCells(text: string): Cell[] {
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

function permissionTitle(toolName: string): string {
  switch (toolName) {
    case 'shell':
      return 'X-Code wants to run a shell command'
    case 'writeFile':
      return 'X-Code wants to write a file'
    case 'edit':
      return 'X-Code wants to edit a file'
    case 'enterPlanMode':
      return 'X-Code wants to enter plan mode'
    default:
      return `X-Code wants to use ${toolName}`
  }
}

const PERMISSION_LEVEL_STYLE: Record<string, { label: string; style: string }> = {
  'always-allow': { label: 'read-only', style: S_SUCCESS },
  ask: { label: 'write', style: S_WARNING },
  deny: { label: 'dangerous', style: S_ERROR_BOLD },
}

function permissionContentCells(toolName: string, input: Record<string, unknown>, termWidth: number): Cell[] | null {
  // Frame geometry assumes exactly ONE row per permission content line.
  // When a string is longer than termWidth the terminal will auto-wrap it
  // onto the next physical row, which breaks every downstream absolute
  // cursor position (the Yes/No rows, the input separator, the prompt
  // itself) — the dialog appears "half missing" with only the title
  // visible. Truncate here so the cell matrix and the on-screen rows
  // stay 1:1. Mirrors the tool-bubble preview truncation in the live
  // tool-list rendering below.
  const truncateToWidth = (text: string, reservedCols: number): string => {
    const maxLen = Math.max(10, termWidth - reservedCols)
    return text.length > maxLen ? text.slice(0, maxLen - 1) + GLYPH_ELLIPSIS : text
  }
  if (toolName === 'shell') {
    const level = getPermissionLevel('shell', input)
    const info = PERMISSION_LEVEL_STYLE[level] ?? PERMISSION_LEVEL_STYLE.ask
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    const rawCommand = String(input.command ?? '')
    const decoration = 2 + 2 + 1 + (info.label.length + 2) + 2
    const command = truncateToWidth('$ ' + rawCommand, decoration)
    cells.push(...textToCells(command, S_ACCENT))
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push(...textToCells(`[${info.label}]`, info.style))
    return cells
  }
  if (toolName === 'writeFile') {
    const fp = String(input.filePath ?? '')
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    const suffix = ' (new file)'
    const truncated = truncateToWidth(fp, 2 + suffix.length + 2)
    cells.push(...textToCells(truncated, S_ACCENT))
    cells.push(...textToCells(suffix, S_ACCENT_DIM))
    return cells
  }
  if (toolName === 'edit') {
    const fp = String(input.filePath ?? '')
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push(...textToCells(truncateToWidth(fp, 2 + 2), S_ACCENT))
    return cells
  }
  if (toolName === 'enterPlanMode') {
    // Plan-mode entry has no per-call input — describe the consequence
    // so the user knows what Yes/No actually means.
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push(...textToCells('Read-only exploration; no edits until you approve a plan.', S_DIM))
    return cells
  }
  return null
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${minutes}m ${secs}s`
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return `${tokens}`
}

// ── Component ───────────────────────────────────────────────────────────

export function ChatInput({
  messages,
  initialContentRows = 0,
  onSubmit,
  onInterrupt,
  onEscapeCancel,
  isLoading = false,
  notice,
  disabled,
  hidden,
  spinner,
  activeToolCalls,
  todos,
  errorMessage,
  permission,
  selectRequest,
  commands = [],
  permissionMode = 'default',
  contextUsage,
}: ChatInputProps) {
  const [{ text, cursor }, dispatch] = useReducer(inputReducer, { text: '', cursor: 0 })
  const cursorRef = useRef(0)
  // Double-tap Esc to clear the input (idle mode only; loading mode uses
  // single Esc to cancel the in-flight turn). Timestamp of the last Esc
  // that didn't already clear; second press within DOUBLE_ESC_WINDOW_MS
  // triggers RESET.
  const lastEscapeAtRef = useRef(0)
  useLayoutEffect(() => {
    cursorRef.current = cursor
  })
  const [pastedContents, setPastedContents] = useState<PastedContents>({})
  const [completionIndex, setCompletionIndex] = useState(0)
  const [atCompletionIndex, setAtCompletionIndex] = useState(0)
  // Tracks the trigger-key (atIdx + query) the user dismissed via Esc.
  // The menu hides while atTrigger.atIdx + query equals this; once the
  // user types or backspaces the trigger naturally changes and the
  // menu reopens — no need for an explicit "clear" path.
  const [atDismissed, setAtDismissed] = useState<string | null>(null)
  const { entries: fileEntries } = useFileCompletion()
  const nextPasteIdRef = useRef(1)
  const activeRef = useRef(false)
  const prevFrameRef = useRef<Cell[][]>([])
  /** Timestamp (ms) of the last stdout.write that actually hit the
   *  terminal. Used to coalesce spinner-tick writes that would fire
   *  immediately after a scrollback-commit write — see flush section. */
  const lastFlushTimeRef = useRef(0)
  /** Pending deferred (non-commit) write that can be superseded by a commit. */
  const deferredFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Pending throttled commit. Set when a commit fires within MIN_COMMIT_GAP_MS
   *  of the previous write — the commit's payload waits just long enough that
   *  it lands in a fresh terminal paint cycle instead of inside the same vsync
   *  as the previous write. Distinct from `deferredFlushRef` because the
   *  defer path must NOT cancel a throttled commit (cancelling would lose
   *  the new scrollback content the commit's preBuf carries). */
  const commitThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Monotonic counter incremented by every successful `doFlush`. The
   *  deferred-write path captures this at SCHEDULE time and re-checks
   *  at FIRE time: if the value has changed, a commit-path flush ran
   *  in the interim and our spinner-only frame is stale (the commit
   *  already repainted the cell). Closes the race the bare
   *  `clearTimeout` cancellation can't catch — when the macrotask
   *  for the deferred timer is already queued AND a commit's useEffect
   *  also queues a flush in the same tick, both writes hit stdout
   *  1-2ms apart and the user sees a visible flicker. */
  const flushGenRef = useRef(0)
  /** Last `spinnerFrame` value seen by the flush effect. We compare against
   *  the current frame to distinguish "this render was triggered by a
   *  spinner tick" (spinner glyph cycled) from "this render was triggered
   *  by typing / content change" (spinner unchanged). The two cases want
   *  different deferred-flush windows: spinner ticks should defer longer
   *  (~24ms) so the next text-stream commit can absorb them, but typing
   *  must defer briefly (~8ms) or it visibly stutters under a held key. */
  const lastFlushedSpinnerFrameRef = useRef<number | null>(null)
  /** Height of the frame currently sitting at the bottom of the terminal
   *  (the value that prevFrameRef was last set to). Tracked separately
   *  because prevFrameRef gets reset to [] on transitions (post-hidden,
   *  frame-height change) while we still need to know where the PHYSICAL
   *  frame on screen begins so the next DECSTBM scroll region doesn't
   *  overlap it. */
  const lastFrameHRef = useRef(0)
  /** Last known terminal dimensions. Compared against current values in
   *  the render effect to detect resize and compute where the OLD frame
   *  was positioned so it can be erased before painting at the new spot. */
  const lastTermRowsRef = useRef(0)
  const lastTermWidthRef = useRef(0)
  /** Rows of blank space between the last on-screen content row and the
   *  TERMINAL BOTTOM. Conceptually the same value as the original "blanks
   *  above frame" — what changed is where we choose to draw the frame
   *  inside that empty zone:
   *
   *    - When this is 0 the frame sits at the bottom of the terminal
   *      (the original always-anchored-at-bottom behavior).
   *    - When this is > 0 the frame floats UP so it sits immediately
   *      below the last content row, and the freeBlanks become the
   *      empty rows BELOW the input box. Mirrors Claude Code's flex-
   *      layout behavior (Box flexGrow=1 spacer doesn't push to bottom
   *      until messages fill the screen) and avoids the "tool block
   *      anchored at bottom of empty terminal" gap users see when
   *      starting a fresh conversation.
   *
   *  Across the rest of the render code this still tracks "free row
   *  budget that the next commit can write into without scrolling real
   *  history" — that arithmetic is identical regardless of where the
   *  frame is parked inside the empty zone. */
  const freeBlanksAboveFrameRef = useRef(0)
  /** Last actual frameTop row written to the terminal. Stored separately
   *  because frameTop is no longer derivable from (termRows, frameH)
   *  alone — it now also depends on freeBlanksAboveFrameRef. Read by
   *  unmount cleanup (buildEraseRegion) and the resize handler so they
   *  can erase the OLD on-screen frame at its actual position rather
   *  than guessing it from termRows. */
  const lastFrameTopRef = useRef(0)
  /** Reserves vertical space inside the tool-running frame when a permission
   *  dialog just closed but its approved tool hasn't committed a result yet.
   *  Without the reservation the frame snaps 7→5 rows (permission was 4 rows,
   *  tool rows are 2) and the now-empty top 2 rows of the old permission
   *  region flash as blank lines between the last committed scrollback entry
   *  and the running tool — for a beat the user sees "Running..." pinned to
   *  the bottom with a gap above, until the tool finishes and its commit
   *  backfills those rows. The reservation holds the frame at the old size
   *  so the in-progress tool row stays painted WHERE the permission title
   *  used to be; the blank rows move below the tool (between tool and
   *  input), which the next commit / grow consumes cleanly. Cleared on any
   *  commit (the tool result lands in the reserved slot) or when a new
   *  permission arrives (that permission re-fills the slot itself). */
  const permissionSlotReserveRef = useRef(0)
  const prevHadPermissionRef = useRef(false)
  /** True while a Permission/SelectOptions dialog was showing on the
   *  previous render. When it disappears we need to erase the old frame
   *  before redrawing — Ink's log.clear returns the cursor to the row
   *  where the dialog started, which is exactly our frame's bottom row,
   *  so a normal eraseRegion-by-prevFrame works cleanly. */
  const wasHiddenRef = useRef(false)
  /** How many messages we've already committed to scrollback. */
  const writtenMessageCountRef = useRef(0)
  // Permission dialog: selection index (0 = Yes, 1 = No). Rendered inside
  // our cell buffer — not via Ink — so the dialog never fights our
  // cursor management. Reset to 0 whenever the prompt changes (new tool
  // call) using React's "adjust state during render" pattern — React
  // throws away the first render and immediately re-renders, which is
  // cheaper than a cascading setState-inside-effect and doesn't trip the
  // react-hooks/set-state-in-effect lint.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [permissionSelected, setPermissionSelected] = useState(0)
  const [lastPermissionKey, setLastPermissionKey] = useState<string | null>(null)
  const permissionKey = permission ? `${permission.toolName}:${JSON.stringify(permission.input)}` : null
  if (permissionKey !== lastPermissionKey) {
    setLastPermissionKey(permissionKey)
    setPermissionSelected(0)
  }

  // Selected index for the in-frame select-options dialog. Reset whenever a
  // new dialog opens (keyed on the question string since that's what changes).
  const [selectIndex, setSelectIndex] = useState(0)
  const [lastSelectKey, setLastSelectKey] = useState<string | null>(null)
  // Inline text buffer for the "Other" freeform option. Captured as
  // {text, cursor} so the inverse-video cursor renders the same way as
  // the main input. Preserved while navigating between options in the
  // same dialog (so the user can re-enter "Other" without losing what
  // they typed) but cleared when a new dialog opens.
  const [freeform, setFreeform] = useState<{ text: string; cursor: number }>({ text: '', cursor: 0 })
  const selectKey = selectRequest ? selectRequest.question : null
  if (selectKey !== lastSelectKey) {
    setLastSelectKey(selectKey)
    setSelectIndex(0)
    setFreeform({ text: '', cursor: 0 })
  }

  // Spinner animation — self-contained so the parent doesn't have to
  // re-render 12× per second. Only runs while `spinner` is truthy.
  //
  // We only keep ONE piece of React state (`spinnerFrame`) because its
  // change is what triggers the re-render that redraws the cell frame.
  // `elapsedMs` is derived at render time from `loadingStartRef` so we
  // never do a synchronous setState inside the effect (would trigger
  // cascading renders / the react-hooks/set-state-in-effect lint).
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  const loadingStartRef = useRef<number>(0)

  useEffect(() => {
    if (!spinner) {
      loadingStartRef.current = 0
      return
    }
    if (loadingStartRef.current === 0) loadingStartRef.current = Date.now()
    const timer = setInterval(() => {
      setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length)
    }, 200) // 200ms per frame (5 Hz). Below 8 Hz the asterisk-pulse
    // breathe still reads as a smooth animation, but each cell write is
    // 38% less frequent than at 120ms — measurably less visible
    // residual flicker on weak terminals (VSCode xterm.js, ConHost)
    // where every spinner-cell update kicks the renderer's state
    // machine. A full breathe cycle is now 12 frames × 200ms = 2.4s,
    // which still feels alive without feeling jittery.
    return () => clearInterval(timer)
  }, [spinner])

  const { stdout } = useStdout()
  const termWidth = stdout?.columns ?? 80

  // ── Terminal resize handling ──
  // Force a re-render tick on resize so termWidth/termRows pick up the new
  // values. The cell matrix is invalidated but lastFrameHRef / lastTermRowsRef
  // are kept intact — the render effect needs them to compute where the OLD
  // frame sat so it can erase those rows before painting at the new position.
  const [, forceRender] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (!stdout) return
    const onResize = () => {
      prevFrameRef.current = []
      forceRender()
    }
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])

  // ── Cursor visibility lifecycle (Claude-Code pattern). ──
  // The terminal cursor is hidden for the entire lifetime of the TUI
  // and shown again on unmount. We never toggle `?25h` / `?25l` per
  // render, which on Windows Terminal / VSCode-xterm.js / ConHost
  // resets the cursor blink phase each time it's processed and the
  // user perceives that as flicker at the cursor's last position.
  // The "input cursor" is rendered as an inverse-video cell on the
  // input row by the cell-diff loop below — visually it's just a
  // styled char that updates atomically with the rest of the frame.
  // Reference: D:\res\claude-code\src\ink\components\App.tsx:184
  // (HIDE_CURSOR write at componentDidMount) and :189 (SHOW_CURSOR
  // at componentWillUnmount).
  useEffect(() => {
    try {
      process.stdout.write('\x1b[?25l')
    } catch {
      /* tty closed */
    }
    return () => {
      try {
        process.stdout.write('\x1b[?25h')
      } catch {
        /* tty closed */
      }
    }
  }, [])

  // ── Fuzzy matching ──
  const matches = useMemo(() => {
    if (!text.startsWith('/') || text.includes(' ')) return []
    const query = text.slice(1).toLowerCase()
    if (!query) return [...commands]
    return commands.filter((cmd) => {
      const name = cmd.name.slice(1).toLowerCase()
      let qi = 0
      for (let ni = 0; ni < name.length && qi < query.length; ni++) {
        if (name[ni] === query[qi]) qi++
      }
      return qi === query.length
    })
  }, [text, commands])

  const safeIndex = matches.length > 0 ? completionIndex % matches.length : 0
  const currentMatch = matches.length > 0 ? matches[safeIndex] : null

  // ── @-mention file completion ──
  // detectAtToken is cheap; recompute every render so it tracks cursor
  // moves (left/right arrows) without explicit invalidation.
  const atTrigger = useMemo(() => detectAtToken(text, cursor), [text, cursor])
  const atMatches = useMemo(() => {
    if (!atTrigger.active) return [] as FileEntry[]
    return scoreAndRank(fileEntries as FileEntry[], atTrigger.query).slice(0, MAX_AT_COMPLETIONS)
  }, [atTrigger, fileEntries])
  const safeAtIndex = atMatches.length > 0 ? atCompletionIndex % atMatches.length : 0
  const atDismissedKey = `${atTrigger.atIdx}:${atTrigger.query}`
  const atMenuVisible = atTrigger.active && atDismissed !== atDismissedKey
  // Slash menu wins when both could fire (`/` only triggers at line start so
  // they rarely collide — only via paste). Hard mutex prevents double-render.
  const activeMenu: 'slash' | 'at' | null = matches.length > 0 ? 'slash' : atMenuVisible ? 'at' : null

  // Reset the @-menu cursor whenever the trigger token shifts so the
  // highlight always starts at the top entry of the new result set.
  // Uses the "store previous prop in state + setState during render"
  // pattern from the React docs — preferred over useEffect because it
  // avoids an extra commit and avoids react-hooks/set-state-in-effect.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const atTriggerKey = `${atTrigger.atIdx}:${atTrigger.query}:${atTrigger.active}`
  const [lastAtTriggerKey, setLastAtTriggerKey] = useState(atTriggerKey)
  if (lastAtTriggerKey !== atTriggerKey) {
    setLastAtTriggerKey(atTriggerKey)
    setAtCompletionIndex(0)
  }

  /** Erase the frame region at its pinned location (last `lastFrameHRef`
   *  rows of the terminal) and clear prevFrameRef. Returns the ANSI
   *  sequence so callers can coalesce it with other writes into a single
   *  process.stdout.write. Cursor ends at the top-left of the (now blank)
   *  frame region.
   *
   *  Only used for unmount cleanup now — the live render path keeps the
   *  frame PINNED at the bottom and uses DECSTBM scroll regions to insert
   *  scrollback above it (see the flush effect below), so erasing is only
   *  needed when the TUI itself is tearing down. */
  const buildEraseRegion = (): string => {
    const prevH = lastFrameHRef.current
    const prevTop = lastFrameTopRef.current
    prevFrameRef.current = []
    lastFrameHRef.current = 0
    lastFrameTopRef.current = 0
    if (prevH <= 0) return ''
    const termRows = stdout?.rows ?? 25
    // Use the actual last-rendered top, falling back to the bottom-anchor
    // formula on the legacy path where lastFrameTopRef wasn't yet
    // populated (would only matter for very early teardowns).
    const frameTop = prevTop > 0 ? prevTop : Math.max(1, termRows - prevH + 1)
    // Jump to frame top, erase to end of display. One atomic wipe.
    return `\x1b[${frameTop};1H\x1b[J`
  }

  /** Synchronous erase used by unmount cleanup. Wrapped in BSU/ESU so the
   *  terminal renders the erase atomically. Effect path does its own
   *  composition (already BSU/ESU-wrapped by the outer render). */
  const eraseRegion = () => {
    const s = buildEraseRegion()
    if (s) process.stdout.write(BSU + s + ESU_HIDE)
  }

  const handleSubmit = (override?: string) => {
    const raw = override ?? text
    if (!raw.trim()) return
    // Block submit while the agent is still thinking. Keystrokes still flow
    // (the keyboard stays enabled so users can pre-type the next prompt) —
    // only Enter is suppressed, matching Claude Code's behavior.
    if (spinner) return
    const expanded = override ? raw : expandPasteRefs(raw, pastedContents)
    // Let the normal render useEffect handle the transition. The next
    // render sees `messages.length > writtenMessageCountRef` (user-echo
    // just got appended inside onSubmit) and emits a single atomic
    // BSU/ESU-wrapped payload of: gap-clear + scrollback content + frame
    // redraw. No synchronous pre-erase here — that used to exist to
    // make room for a now-retired separate MessageList writer, and was
    // a second non-atomic flash on every submit.
    onSubmit(expanded)
    dispatch({ type: 'RESET' })
    setPastedContents({})
    setCompletionIndex(0)
  }

  const moveCursorVertically = (delta: number) => {
    const lines = text.split('\n')
    let line = 0,
      col = cursorRef.current,
      charsSoFar = 0
    for (let i = 0; i < lines.length; i++) {
      if (charsSoFar + lines[i].length >= cursorRef.current && cursorRef.current >= charsSoFar) {
        line = i
        col = cursorRef.current - charsSoFar
        break
      }
      charsSoFar += lines[i].length + 1
    }
    const targetLine = Math.max(0, Math.min(lines.length - 1, line + delta))
    if (targetLine === line) return
    const targetCol = Math.min(col, lines[targetLine].length)
    let newPos = 0
    for (let i = 0; i < targetLine; i++) newPos += lines[i].length + 1
    newPos += targetCol
    dispatch({ type: 'SET_CURSOR', cursor: newPos })
  }

  usePromptInput({
    enabled: !disabled && !hidden,
    onInterrupt,
    onText: (chunk) => {
      // Route single-char y/n to the Permission resolver when a dialog is
      // active; block all other text input so the user can't type into
      // the input box behind the dialog.
      if (permission) {
        const ch = chunk.toLowerCase()
        if (ch === 'y') {
          permission.onResolve('yes')
          return
        }
        if (ch === 'n') {
          permission.onResolve('no')
          return
        }
        return
      }
      if (selectRequest) {
        // Typing on a freeform option ("Other") feeds the inline text
        // buffer; on regular options it's still swallowed so the user
        // can't type into the hidden input behind the dialog.
        const opt = selectRequest.options[selectIndex]
        if (opt?.freeform) {
          setFreeform(({ text, cursor }) => ({
            text: text.slice(0, cursor) + chunk + text.slice(cursor),
            cursor: cursor + chunk.length,
          }))
        }
        return
      }
      dispatch({ type: 'INSERT', pos: cursorRef.current, chunk })
      setCompletionIndex(0)
    },
    onPaste: (content) => {
      if (permission) return
      if (selectRequest) {
        // Allow paste into the freeform buffer (e.g. pasting a long
        // path or model id). Skip the large-paste reference machinery
        // — it's a usability hit for free-text answers, which are
        // expected to be short.
        const opt = selectRequest.options[selectIndex]
        if (opt?.freeform) {
          setFreeform(({ text, cursor }) => ({
            text: text.slice(0, cursor) + content + text.slice(cursor),
            cursor: cursor + content.length,
          }))
        }
        return
      }
      const lineCount = content.split(/\r\n|\r|\n/).length
      const isLarge = lineCount >= PASTE_REF_MIN_LINES || content.length >= PASTE_REF_MIN_CHARS
      const pos = cursorRef.current
      if (isLarge) {
        const id = nextPasteIdRef.current++
        setPastedContents((prev) => ({ ...prev, [id]: { id, content, lineCount } }))
        const ref = formatPasteRef(id, lineCount)
        dispatch({ type: 'INSERT', pos, chunk: ref })
      } else {
        dispatch({ type: 'INSERT', pos, chunk: content })
      }
      setCompletionIndex(0)
    },
    onKey: (key) => {
      // Permission dialog captures navigation + submit keys.
      if (permission) {
        const hasAlwaysOption = suggestRuleLabel(permission.toolName, permission.input) !== null
        const maxIdx = hasAlwaysOption ? 2 : 1
        if (key === 'up') {
          setPermissionSelected((p) => (p > 0 ? p - 1 : maxIdx))
          return
        }
        if (key === 'down') {
          setPermissionSelected((p) => (p < maxIdx ? p + 1 : 0))
          return
        }
        if (key === 'return') {
          const decisions: ('yes' | 'always' | 'no')[] = hasAlwaysOption ? ['yes', 'always', 'no'] : ['yes', 'no']
          permission.onResolve(decisions[permissionSelected]!)
          return
        }
        return
      }
      // Select-options dialog captures navigation + submit keys. When
      // the highlighted option is `freeform`, editing keys (backspace,
      // delete, left, right, home, end) also feed its inline text
      // buffer instead of being swallowed.
      if (selectRequest) {
        const len = selectRequest.options.length
        const opt = selectRequest.options[selectIndex]
        const isFreeform = !!opt?.freeform
        // Esc dismisses user-initiated pickers (slash commands like
        // /syntax, /model) — the user may have just been browsing and
        // shouldn't be forced to commit. AI-initiated dialogs leave
        // `dismissible` falsy so Esc is swallowed; otherwise the model
        // gets a silent empty answer back from its askUser call.
        if (key === 'escape' && selectRequest.dismissible) {
          debugLog('chatinput.select-dismiss', 'esc')
          selectRequest.onResolve('')
          return
        }
        if (key === 'up') {
          setSelectIndex((i) => (i > 0 ? i - 1 : len - 1))
          return
        }
        if (key === 'down') {
          setSelectIndex((i) => (i < len - 1 ? i + 1 : 0))
          return
        }
        if (isFreeform) {
          if (key === 'backspace') {
            setFreeform(({ text, cursor }) =>
              cursor === 0
                ? { text, cursor }
                : { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 },
            )
            return
          }
          if (key === 'delete') {
            setFreeform(({ text, cursor }) =>
              cursor >= text.length
                ? { text, cursor }
                : { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor },
            )
            return
          }
          if (key === 'left') {
            setFreeform(({ text, cursor }) => ({ text, cursor: Math.max(0, cursor - 1) }))
            return
          }
          if (key === 'right') {
            setFreeform(({ text, cursor }) => ({ text, cursor: Math.min(text.length, cursor + 1) }))
            return
          }
          if (key === 'home') {
            setFreeform(({ text }) => ({ text, cursor: 0 }))
            return
          }
          if (key === 'end') {
            setFreeform(({ text }) => ({ text, cursor: text.length }))
            return
          }
        }
        if (key === 'return') {
          const picked = selectRequest.options[selectIndex]
          if (!picked) return
          if (picked.freeform) {
            const trimmed = freeform.text.trim()
            // Empty buffer on Enter: ignore so the user isn't bounced
            // out of the dialog with an empty answer. The visible
            // cursor + dialog hint already signal that typing is
            // expected here.
            if (!trimmed) return
            selectRequest.onResolve(trimmed)
          } else {
            selectRequest.onResolve(picked.label)
          }
          return
        }
        return
      }
      if (key === 'return') {
        // @-completion: Enter picks the highlighted file but DOES NOT
        // submit — user is mid-prompt and likely wants to keep typing
        // after the path lands. Falls through to slash/submit when the
        // menu is empty (the "@xxx with no matches" case sends the
        // text as-is, so the user can mention a npm package or a
        // not-yet-existing file without an extra keystroke to dismiss).
        if (activeMenu === 'at' && atMatches.length > 0) {
          const picked = atMatches[safeAtIndex]
          if (picked) {
            const out = applyCompletion(text, atTrigger.atIdx, atTrigger.tokenEnd, picked)
            dispatch({ type: 'SET_TEXT', text: out.text, cursor: out.cursor })
            setAtCompletionIndex(0)
            return
          }
        }
        // Active slash-command completion: Enter picks the highlighted
        // command directly instead of submitting whatever's in the input
        // (usually just `/` or a prefix), matching Claude Code's behavior.
        // Previously the user had to hit Tab first to materialize the
        // selection, then Enter — redundant.
        if (currentMatch) {
          handleSubmit(currentMatch.name)
          return
        }
        handleSubmit()
        return
      }
      if (key === 'escape') {
        // @-menu open: Esc just dismisses the menu for the current
        // trigger. Once the user types/backspaces the trigger key
        // changes and the menu reopens automatically, so there's no
        // explicit "re-arm" path.
        if (activeMenu === 'at') {
          setAtDismissed(atDismissedKey)
          return
        }
        // Modal dialogs (permission / selectRequest) gate above and
        // already swallow Esc. Here we only see Esc that reached the
        // input. Two distinct gestures:
        //   - loading: single Esc cancels the in-flight turn.
        //   - idle:    double-tap Esc clears input + pasted refs (matches
        //     Claude Code). Single Esc is a no-op so a stray press
        //     doesn't wipe a draft.
        if (isLoading && onEscapeCancel) {
          onEscapeCancel()
          return
        }
        if (text.length === 0 && Object.keys(pastedContents).length === 0) return
        const now = Date.now()
        const DOUBLE_ESC_WINDOW_MS = 500
        if (now - lastEscapeAtRef.current <= DOUBLE_ESC_WINDOW_MS) {
          dispatch({ type: 'RESET' })
          setPastedContents({})
          setCompletionIndex(0)
          lastEscapeAtRef.current = 0
        } else {
          lastEscapeAtRef.current = now
        }
        return
      }
      if (key === 'backspace') {
        const pos = cursorRef.current
        if (pos === 0) return
        const before = text.slice(0, pos)
        const stripped = stripTrailingRef(before)
        if (stripped) {
          setPastedContents((pc) => {
            const n = { ...pc }
            delete n[stripped.id]
            return n
          })
          const deleteCount = before.length - stripped.without.length
          dispatch({ type: 'BACKSPACE_REF', pos, deleteCount })
        } else {
          dispatch({ type: 'BACKSPACE_REF', pos, deleteCount: 1 })
        }
        setCompletionIndex(0)
        return
      }
      if (key === 'delete') {
        dispatch({ type: 'DELETE', pos: cursorRef.current })
        return
      }
      if (key === 'left') {
        dispatch({ type: 'SET_CURSOR', cursor: Math.max(0, cursorRef.current - 1) })
        return
      }
      if (key === 'right') {
        dispatch({ type: 'SET_CURSOR', cursor: Math.min(text.length, cursorRef.current + 1) })
        return
      }
      if (key === 'home') {
        dispatch({ type: 'SET_CURSOR', cursor: 0 })
        return
      }
      if (key === 'end') {
        dispatch({ type: 'SET_CURSOR', cursor: text.length })
        return
      }
      if (key === 'tab') {
        if (activeMenu === 'at' && atMatches.length > 0) {
          const picked = atMatches[safeAtIndex]
          if (picked) {
            const out = applyCompletion(text, atTrigger.atIdx, atTrigger.tokenEnd, picked)
            dispatch({ type: 'SET_TEXT', text: out.text, cursor: out.cursor })
            setAtCompletionIndex(0)
          }
          return
        }
        if (currentMatch) {
          dispatch({ type: 'SET_TEXT', text: currentMatch.name, cursor: currentMatch.name.length })
          setCompletionIndex(0)
        }
        return
      }
      if (key === 'up') {
        if (activeMenu === 'at') {
          if (atMatches.length > 0) setAtCompletionIndex((p) => (p - 1 + atMatches.length) % atMatches.length)
          return
        }
        if (matches.length > 0) setCompletionIndex((p) => (p - 1 + matches.length) % matches.length)
        else moveCursorVertically(-1)
        return
      }
      if (key === 'down') {
        if (activeMenu === 'at') {
          if (atMatches.length > 0) setAtCompletionIndex((p) => (p + 1) % atMatches.length)
          return
        }
        if (matches.length > 0) setCompletionIndex((p) => (p + 1) % matches.length)
        else moveCursorVertically(1)
        return
      }
      if (key === 'pageup') {
        moveCursorVertically(-MAX_VISIBLE_LINES)
        return
      }
      if (key === 'pagedown') {
        moveCursorVertically(MAX_VISIBLE_LINES)
        return
      }
    },
  })

  // ── Frame rendering with cell-level diff ─────────────────────────────

  useEffect(() => {
    if (hidden) {
      // KEEP prevFrameRef intact. Ink has written the dialog on top of
      // our frame's bottom row (its onRender runs before useEffect) and
      // moved the cursor beyond it — we can't safely erase anything NOW
      // without corrupting the dialog. But when the dialog resolves,
      // Ink's log.clear sends the cursor back to the row where the
      // dialog started (= our frame's bottom row), and at THAT point we
      // treat the next render as a fresh first-paint.
      wasHiddenRef.current = true
      return
    }

    // Accumulate ALL writes for this render into a single string, flushed
    // via one process.stdout.write at the bottom. Rationale: DEC 2026
    // Synchronized Update Mode (BSU/ESU) only buffers inter-write state on
    // terminals that support it — VS Code terminal and others paint every
    // separate write() immediately. Coalescing into one write keeps each
    // render a single atomic paint regardless of terminal support.
    let preBuf = BSU

    if (wasHiddenRef.current) {
      // Transitioning out of a dialog. We used to RESTORE_CURSOR (\x1b8)
      // back to a position we'd previously DECSC'd — but that single
      // terminal-level save register is ALSO used internally by Ink's
      // own log-update cycle for its own cursor bookkeeping. Two
      // writers, one register: every Ink render that cycled through its
      // save/restore clobbered ours, so the restore here could land at
      // Ink's saved position rather than our frame's bottom row.
      //
      // Instead of fighting for the register, treat the post-dialog
      // frame as a fresh first-paint: drop prevFrameRef (so the diff
      // loop does full-row writes with \x1b[K, no stale assumptions)
      // and the absolute-positioning below puts the frame back at the
      // terminal's bottom rows regardless of where Ink parked the cursor.
      wasHiddenRef.current = false
      prevFrameRef.current = []
      lastFrameHRef.current = 0
      lastFrameTopRef.current = 0
      freeBlanksAboveFrameRef.current = 0
      activeRef.current = false
    }

    // ── Commit new scrollback messages ───────────────────────────────────
    //
    // COLLECT-ONLY here. The actual write happens AFTER the frame cells
    // have been built, so we can emit `content + frame` as one continuous
    // stream that triggers the terminal's natural full-screen scroll at
    // its bottom edge — the only mechanism xterm.js / VSCode honor for
    // pushing rows into real scrollback (DECSTBM-restricted region scrolls
    // are splice-discarded in xterm.js's InputHandler, confirmed in source).
    //
    // A /clear command may shrink messages; detect and reset the counter.
    if (messages.length < writtenMessageCountRef.current) {
      writtenMessageCountRef.current = messages.length
    }
    const termRows = stdout?.rows ?? 25
    const didCommitMessages = messages.length > writtenMessageCountRef.current
    let scrollbackContent = ''
    if (didCommitMessages) {
      const collectWrite: (data: string) => void = (data) => {
        scrollbackContent += data
      }
      for (let i = writtenMessageCountRef.current; i < messages.length; i++) {
        writeMessageToStdout(collectWrite, messages[i])
      }
      writtenMessageCountRef.current = messages.length
    }

    // Capture "is this the first active paint?" BEFORE we flip activeRef.
    // The freeBlanks-seeding check below needs to know this, but the old
    // `!activeRef.current` guard down at the seeding site was always false
    // by the time it ran (we set activeRef=true just below), so the banner's
    // above-frame blank-row credit never got seeded — and the first commit
    // would pre-scroll through the banner rows instead of consuming the
    // unowned blanks between banner and frame. Symptom: starting with an
    // initial prompt (`xc "hi"`) clipped the top half of the logo.
    const isFirstPaint = !activeRef.current
    activeRef.current = true

    // Keep the permission-slot reservation alive only until the first commit
    // after the permission closed (that commit carries the approved tool's
    // result and overwrites the reserved rows). A fresh permission also
    // clears the reservation — the new dialog owns the slot directly.
    //
    // Only reserve when exactly ONE tool is pending. Two tools happen to
    // produce the same frame height as the permission (2×2 + 3 input = 7 =
    // 4 permission + 3 input) so no reservation is needed; three or more
    // tools make the frame LARGER than the permission, which is a grow
    // (handled correctly by the existing freeBlanks/preScroll path);
    // zero tools means the approved tool was denied or hasn't produced an
    // onToolCall yet — reserving blank rows there would just shift the
    // gap around rather than eliminate it.
    const hadPermissionLastRender = prevHadPermissionRef.current
    const runningToolCount = activeToolCalls?.length ?? 0
    if (didCommitMessages || permission) {
      permissionSlotReserveRef.current = 0
    } else if (hadPermissionLastRender && !permission && runningToolCount === 1) {
      permissionSlotReserveRef.current = 2
    }
    prevHadPermissionRef.current = !!permission

    const PROMPT_WIDTH = 2
    const vpWidth = Math.max(20, termWidth - PROMPT_WIDTH - 1)
    const sepChar = '\u2500'
    const sepText = sepChar.repeat(Math.max(0, termWidth - 1))

    // ── Input display lines (with soft-wrap + viewport windowing) ──
    // Raw lines are split by explicit `\n` only. Each raw line is then
    // soft-wrapped at vpWidth columns into one or more visual lines, so
    // the input doesn't run off the right edge of the terminal. The
    // cursor's character offset is mapped into the matching (visualLine,
    // visualCol) pair for the render/diff paths below.
    const rawLines = text.length === 0 ? [''] : text.split('\n')

    type VisualLine = { text: string; rawLineIdx: number; startCol: number }
    const visualLines: VisualLine[] = []
    for (let r = 0; r < rawLines.length; r++) {
      const line = rawLines[r]
      if (line.length === 0) {
        visualLines.push({ text: '', rawLineIdx: r, startCol: 0 })
        continue
      }
      let pos = 0
      while (pos < line.length) {
        const chunk = sliceByWidth(line.slice(pos), vpWidth)
        const advance = chunk.length > 0 ? chunk.length : line.length - pos // wide-char-overflow safety
        visualLines.push({ text: chunk, rawLineIdx: r, startCol: pos })
        pos += advance
      }
    }

    // Locate cursor in visual coordinates. Scan visual lines in order:
    // the cursor lies inside the first visual line whose raw range
    // `[startCol, startCol + text.length]` contains `cursorCol` for the
    // matching rawLineIdx. When cursor is at the end of a wrapped line
    // that continues to the next visual line (startCol + text.length ===
    // cursorCol AND the next visual line has the same rawLineIdx), we
    // prefer the next line's leading position for UX parity with shell
    // prompts.
    let visCursorLine = 0
    let visCursorCol = 0
    {
      let rawCursorLine = 0,
        cursorColInRaw = cursor
      let charsSoFar = 0
      for (let i = 0; i < rawLines.length; i++) {
        if (cursor >= charsSoFar && cursor <= charsSoFar + rawLines[i].length) {
          rawCursorLine = i
          cursorColInRaw = cursor - charsSoFar
          break
        }
        charsSoFar += rawLines[i].length + 1
      }
      for (let v = 0; v < visualLines.length; v++) {
        const vl = visualLines[v]
        if (vl.rawLineIdx !== rawCursorLine) continue
        const endCol = vl.startCol + vl.text.length
        const isLastChunkOfRawLine = v + 1 >= visualLines.length || visualLines[v + 1].rawLineIdx !== rawCursorLine
        if (
          cursorColInRaw >= vl.startCol &&
          (cursorColInRaw < endCol || (cursorColInRaw === endCol && isLastChunkOfRawLine))
        ) {
          visCursorLine = v
          visCursorCol = cursorColInRaw - vl.startCol
          break
        }
      }
    }

    let displayLines: string[]
    let cursorLine: number
    if (visualLines.length <= MAX_VISIBLE_LINES) {
      displayLines = visualLines.map((v) => v.text)
      cursorLine = visCursorLine
    } else {
      let start = visCursorLine - Math.floor(MAX_VISIBLE_LINES / 2)
      start = Math.max(0, Math.min(start, visualLines.length - MAX_VISIBLE_LINES))
      displayLines = visualLines.slice(start, start + MAX_VISIBLE_LINES).map((v) => v.text)
      cursorLine = visCursorLine - start
      if (start > 0) {
        displayLines[0] = `${GLYPH_ELLIPSIS} (+${start} above)`
        if (cursorLine === 0) cursorLine = -1
      }
      if (start + MAX_VISIBLE_LINES < visualLines.length) {
        displayLines[displayLines.length - 1] =
          `${GLYPH_ELLIPSIS} (+${visualLines.length - start - MAX_VISIBLE_LINES} below)`
        if (cursorLine === displayLines.length - 1) cursorLine = -1
      }
    }
    // `cursorCol` below refers to the visual column within the display
    // line — preserve the existing name so the input-rendering block
    // (cursor placement, long-line truncation) doesn't need changes.
    const cursorCol = visCursorCol

    // ── Build 2D cell frame ──
    const frame: Cell[][] = []

    // Error line (if any)
    if (errorMessage) {
      const S_ERR = '\x1b[38;2;244;113;116m' // red-ish
      const cells: Cell[] = []
      cells.push({ char: ' ', style: S_NONE, width: 1 })
      cells.push(...textToCells(`Error: ${errorMessage}`, S_ERR))
      frame.push(cells)
    }

    // (Streaming assistant text does NOT live here. Each complete line
    // emitted by useStreamBuffer is committed as a `streamingChunk`
    // message and written straight to scrollback above this cell buffer
    // — see writeMessageToStdout. That keeps our frame's row count
    // stable as output grows: spinner / separators / input never shift
    // position, so there's no row-shift jitter.)

    // Spinner / tool-status line. Pinned just above the input box
    // (below any permission dialog) so it always sits at the very bottom
    // of the dynamic area — matches Claude Code's layout.
    //
    // When tools are running we replace the generic "Thinking..." line with
    // a live tool-status block, one 2-row group per in-flight tool call:
    //    ● ToolName(preview)
    //    ⎿ ⠋ progressText          (← replaced by onToolProgress stream)
    // Mirrors Claude Code's AssistantToolUseMessage + renderToolUseProgress
    // flow. Elapsed/token meta moves onto the LAST progress line so the
    // block stays compact (no separate Thinking row competing for space).
    if (spinner) {
      const glyph = SPINNER_FRAMES[spinnerFrame]
      // Derive elapsed time at render time so we don't need a setState in
      // the spinner effect. The setSpinnerFrame tick is what drives the
      // ~80ms re-render that recomputes this value.
      const elapsedMs = loadingStartRef.current === 0 ? 0 : Date.now() - loadingStartRef.current
      const parts: string[] = []
      if (elapsedMs >= 2000) parts.push(formatElapsed(elapsedMs))
      // Token count is no longer shown next to the spinner — it now lives
      // in the footer below the input box (see contextUsage rendering)
      // because cumulative session counts double-count cache-served history
      // and "context size" snapshots only feel useful with a denominator.
      // Only show the cancel hint when we're actually able to honor an Esc
      // press (no modal open — the parent suppresses the spinner in that
      // case anyway, but be defensive).
      parts.push('esc to interrupt')
      const meta = parts.length > 0 ? ` (${parts.join(' · ')})` : ''

      // Top margin ONLY when the permission dialog sits immediately above
      // the spinner (they'd otherwise touch without breathing room).
      // When Thinking sits directly below scrollback content, the last
      // message already ends with `\n\n` → one blank row is ALREADY
      // there, and adding another would make the gap look too large.
      if (permission) frame.push([])

      const tools = activeToolCalls ?? []
      if (tools.length > 0) {
        // IMPORTANT: the live tool bubble MUST use the same colour/weight
        // scheme as `stdout-writer.formatToolCall` emits for committed
        // scrollback — otherwise when the tool finishes and its line
        // switches from live-area to scrollback, the user sees a visible
        // colour flash (orange → default for label, orange → green for
        // bullet, etc.). Claude Code avoids this by rendering in-flight
        // and resolved through the SAME React component; we have two
        // rendering paths (ink-like cells here vs chalk stdout there)
        // so we align the styles by hand.
        //
        // Same reasoning applies to the leading-blank row above the tool
        // block: `stdout-writer.formatToolCall`'s commit path prepends a
        // `\n` whenever the previous write didn't already end blank, so
        // the committed tool sits one row below the preceding text. The
        // live frame must mirror that decision RIGHT NOW — otherwise the
        // user sees the blank row "appear" the instant the tool commits
        // (live frame replaced by scrollback), which reads as a one-row
        // downward jolt of every row below. Permission's own top-margin
        // case is already handled above; this branch covers tool-only
        // and tool+permission stacks.
        if (!permission && !lastWriteEndedWithBlankRow()) frame.push([])
        //
        // Layout mirrors committed:
        //    ` ● ToolName(preview)`
        //      ⎿  ⠋ progress text               ← only live, vanishes at commit
        tools.forEach((tc, idx) => {
          // Separator between adjacent live tools. The committed-tool
          // path emits `\n\n` after each tool, so consecutive committed
          // tools always have one blank row between them. Without the
          // same blank in the live frame, parallel tool calls render
          // glued together until one finishes and commits — at which
          // point the spacing "pops in" (the user's "stuck then
          // separate" jolt).
          if (idx > 0) frame.push([])

          const label = getToolLabel(tc.toolName)
          const preview = getToolInputPreview(tc.toolName, tc.input)

          const row1: Cell[] = []
          row1.push({ char: ' ', style: S_NONE, width: 1 })
          // Pulse the bullet bright↔dim while the tool runs. Period of
          // 6 frames per phase (= ~480ms at 80ms per spinner tick) reads
          // as a heartbeat without being distracting. When the tool
          // finishes and the row commits to scrollback,
          // `stdout-writer.formatToolCall` paints a steady non-pulsing
          // bullet — same hue, no dim — so the transition is just "stop
          // pulsing", not a color change.
          const dotStyle = spinnerFrame % 6 < 3 ? S_SUCCESS_DOT : S_SUCCESS_DOT_DIM
          row1.push(...textToCells(GLYPH_BULLET, dotStyle))
          row1.push({ char: ' ', style: S_NONE, width: 1 })
          row1.push(...textToCells(label, S_BOLD))
          if (preview) {
            // Mirror stdout-writer.formatToolCall's truncation budget so
            // the live row and the committed scrollback row truncate at
            // the same point — otherwise the visible text shifts at the
            // moment the tool finishes (e.g. live shows "...rg)" but
            // committed shows "...rgs.command)"). Reserve label.length+5
            // for ` ● <label>(` and `)`, plus a safety margin.
            const decoration = label.length + 5
            const safetyMargin = 4
            const maxPreviewLen = Math.max(40, termWidth - decoration - safetyMargin)
            const trimmed =
              preview.length > maxPreviewLen ? preview.slice(0, maxPreviewLen - 1) + GLYPH_ELLIPSIS : preview
            row1.push(...textToCells(`(${trimmed})`, S_BLUE_PURPLE))
          }
          frame.push(row1)

          // Sub-tool history: for task (sub-agent) tools, show the last
          // few tool calls as stacked `⎿` rows (like CC). Other tools
          // keep a single progress row.
          const history = tc.subToolHistory
          const isTask = tc.toolName.toLowerCase().replace(/[_-]/g, '') === 'task'
          if (isTask && history && history.length > 1) {
            const MAX_VISIBLE = 4
            const start = Math.max(0, history.length - MAX_VISIBLE)
            for (let hi = start; hi < history.length; hi++) {
              const isFirst = hi === start
              const isLast = hi === history.length - 1
              const row: Cell[] = []
              row.push(...textToCells('   ', S_NONE))
              if (isFirst) {
                row.push(...textToCells(GLYPH_RESULT_BRACKET, S_GRAY_90))
              } else {
                row.push({ char: ' ', style: S_NONE, width: 1 })
              }
              row.push({ char: ' ', style: S_NONE, width: 1 })
              row.push({ char: ' ', style: S_NONE, width: 1 })
              if (isLast) {
                row.push(...textToCells(glyph, S_SPINNER))
                row.push({ char: ' ', style: S_NONE, width: 1 })
              }
              row.push(...textToCells(history[hi]!, isLast ? S_DIM : S_GRAY_90))
              if (isLast && idx === tools.length - 1 && meta) {
                row.push(...textToCells(meta, S_GRAY_90))
              }
              frame.push(truncateCellRow(row, Math.max(20, termWidth - 1)))
            }
          } else {
            const row2: Cell[] = []
            row2.push(...textToCells('   ', S_NONE))
            row2.push(...textToCells(GLYPH_RESULT_BRACKET, S_GRAY_90))
            row2.push({ char: ' ', style: S_NONE, width: 1 })
            row2.push({ char: ' ', style: S_NONE, width: 1 })
            row2.push(...textToCells(glyph, S_SPINNER))
            row2.push({ char: ' ', style: S_NONE, width: 1 })
            row2.push(...textToCells(tc.progress ?? 'Running...', S_DIM))
            if (idx === tools.length - 1 && meta) {
              row2.push(...textToCells(meta, S_GRAY_90))
            }
            frame.push(row2)
          }
        })
      } else {
        // Build the whole prefix (` ${glyph} ${label}...`) under ONE style
        // (S_SPINNER) instead of alternating S_NONE / S_SPINNER per cell.
        // Why: each cell with a different style emits an SGR escape in the
        // diff loop, and on terminals that don't perfectly atomize DEC
        // 2026 sync-update those escapes arrive with visible spacing —
        // the user perceives the "Thinking" label flashing default-color
        // → blue → default → blue as the spaces in between trigger
        // resets. Keeping one continuous SGR run for the whole prefix
        // makes the row paint as one solid blue stripe.
        const cells: Cell[] = textToCells(` ${glyph} ${spinner.label}...`, S_SPINNER)
        if (meta) cells.push(...textToCells(meta, S_DIM))
        frame.push(cells)
      }
    }

    // Permission dialog — rendered ABOVE the input box (between spinner
    // and the input's top separator) so the input stays pinned at the
    // bottom of the screen regardless of dialog state.
    if (permission) {
      const titleText = permissionTitle(permission.toolName)
      const titleCells: Cell[] = []
      titleCells.push({ char: ' ', style: S_NONE, width: 1 })
      titleCells.push({ char: ' ', style: S_NONE, width: 1 })
      titleCells.push(...textToCells(titleText, S_WARNING_BOLD))
      frame.push(titleCells)

      const contentCells = permissionContentCells(permission.toolName, permission.input, termWidth)
      if (contentCells) frame.push(contentCells)

      const ruleLabel = suggestRuleLabel(permission.toolName, permission.input)
      // When no rule can be suggested (e.g. powershell -Command "...",
      // enterPlanMode), only show Yes/No (2 options). When a prefix is
      // available, show Yes / Yes don't ask again / No (3 options).
      const noIndex = ruleLabel ? 2 : 1

      const yesCells: Cell[] = []
      if (permissionSelected === 0) {
        yesCells.push(...textToCells('    ', S_NONE))
        yesCells.push(...textToCells(`${GLYPH_SELECT_POINTER} Yes`, S_SUCCESS))
      } else {
        yesCells.push(...textToCells('      ', S_NONE))
        yesCells.push(...textToCells('Yes', S_ACCENT_DIM))
      }
      frame.push(yesCells)

      if (ruleLabel) {
        const alwaysCells: Cell[] = []
        if (permissionSelected === 1) {
          alwaysCells.push(...textToCells('    ', S_NONE))
          alwaysCells.push(...textToCells(`${GLYPH_SELECT_POINTER} Yes, don't ask again for: ${ruleLabel}`, S_SUCCESS))
        } else {
          alwaysCells.push(...textToCells('      ', S_NONE))
          alwaysCells.push(...textToCells(`Yes, don't ask again for: ${ruleLabel}`, S_ACCENT_DIM))
        }
        frame.push(alwaysCells)
      }

      const noCells: Cell[] = []
      if (permissionSelected === noIndex) {
        noCells.push(...textToCells('    ', S_NONE))
        noCells.push(...textToCells(`${GLYPH_SELECT_POINTER} No`, S_ERROR_BOLD))
      } else {
        noCells.push(...textToCells('      ', S_NONE))
        noCells.push(...textToCells('No', S_ACCENT_DIM))
      }
      frame.push(noCells)
    }

    // Select-options dialog — rendered inside our cell buffer, same slot
    // as Permission. The commit path below detects "shrink from above
    // viewport to at-or-below viewport" and does a clearTerminal + full
    // redraw from messages state, so the tall dialog doesn't leave blank
    // scrollback rows behind when it closes (mirrors Claude Code's
    // log-update.ts fullResetSequence_CAUSES_FLICKER approach).
    if (selectRequest) {
      // Blank line above the question title for visual separation from
      // scrollback content above (mirrors CC's PermissionRequestTitle
      // sitting inside a padded container).
      frame.push([{ char: ' ', style: S_NONE, width: 1 }])

      const questionText = selectRequest.question
      const maxRowW = Math.max(20, termWidth - 1)
      // Wrap question text across multiple lines instead of truncating.
      // The 1-cell left padding is added to each wrapped line.
      const rawCells = ansiTextToCells(renderInlineMarkdown(questionText))
      const contentW = maxRowW - 1
      let ci = 0
      while (ci < rawCells.length) {
        const row: Cell[] = [{ char: ' ', style: S_NONE, width: 1 }]
        let w = 0
        while (ci < rawCells.length && w + rawCells[ci]!.width <= contentW) {
          w += rawCells[ci]!.width
          row.push(rawCells[ci]!)
          ci++
        }
        frame.push(row)
      }
      if (rawCells.length === 0) {
        frame.push([{ char: ' ', style: S_NONE, width: 1 }])
      }

      const opts = selectRequest.options
      const hasDescriptions = opts.some(
        (o: { description?: string; freeform?: boolean }) => o.description && !o.freeform,
      )
      const isVertical = (selectRequest.layout ?? 'compact') === 'compact-vertical'
      const rowsPerOption = hasDescriptions && isVertical ? 2 : 1
      const termRows = stdout?.rows ?? 25

      // Viewport-scroll the options list when there are too many to fit
      // on screen. The visible window follows the active selection index
      // so the highlighted row is always in view.
      const questionRows = Math.max(1, Math.ceil(rawCells.reduce((s, c) => s + c.width, 0) / contentW))
      const hintRows = 1
      const selectBlanks = 2
      const separatorsAndInput = 3
      const footerRow = 1
      const spinnerRows = spinner ? 1 : 0
      const todoRows = todos && todos.length > 0 ? todos.length : 0
      const tools = activeToolCalls ?? []
      const activeToolRows =
        tools.length > 0
          ? tools.reduce((sum, tc, idx) => {
              const histLen =
                tc.toolName.toLowerCase().replace(/[_-]/g, '') === 'task' &&
                tc.subToolHistory &&
                tc.subToolHistory.length > 1
                  ? Math.min(tc.subToolHistory.length, 4)
                  : 1
              return sum + 1 + histLen + (idx > 0 ? 1 : 0)
            }, 1)
          : 0
      const fixedChrome =
        selectBlanks + hintRows + separatorsAndInput + footerRow + spinnerRows + todoRows + activeToolRows
      const chromeRows = questionRows + fixedChrome
      const maxVisibleOptions = Math.max(3, Math.floor((termRows - chromeRows) / rowsPerOption))
      const totalOpts = opts.length
      const needsScroll = totalOpts > maxVisibleOptions

      let vpStart = 0
      let vpEnd = totalOpts
      if (needsScroll) {
        const half = Math.floor(maxVisibleOptions / 2)
        vpStart = Math.max(0, selectIndex - half)
        vpEnd = vpStart + maxVisibleOptions
        if (vpEnd > totalOpts) {
          vpEnd = totalOpts
          vpStart = Math.max(0, vpEnd - maxVisibleOptions)
        }
      }

      if (needsScroll && vpStart > 0) {
        const cells: Cell[] = []
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push(...textToCells(`  \u2191 ${vpStart} more above`, S_DIM))
        frame.push(cells)
      }

      // Blank line between question header and options for visual grouping
      frame.push([{ char: ' ', style: S_NONE, width: 1 }])

      const maxRowWidth = Math.max(20, termWidth - 1)
      const maxIdxWidth = totalOpts.toString().length
      const layout = selectRequest.layout ?? 'compact'

      if (layout === 'compact-vertical') {
        // compact-vertical: description on a separate indented line below
        // the label. Matches CC's QuestionView layout:
        //   ❯ 1. Label        ← focused: pointer "suggestion", label "suggestion"
        //      description     ← paddingLeft = maxIndexWidth + 4
        //     2. Label         ← unfocused: no pointer, label default (no bold)
        //      description     ← dim
        // CC's paddingLeft = maxIndexWidth + 4:
        //   1(pointer) + 1(gap) + maxIdxWidth + 1(dot) + 1(space) = maxIdxWidth + 4
        const descIndent = maxIdxWidth + 4
        for (let i = vpStart; i < vpEnd; i++) {
          const opt = opts[i]!
          const active = i === selectIndex
          const idx = `${i + 1}.`.padEnd(maxIdxWidth + 2)
          const labelStyle = active ? S_BLUE_PURPLE : S_NONE
          const cells: Cell[] = []
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          if (active) {
            cells.push(...textToCells(`${GLYPH_SELECT_POINTER} `, S_BLUE_PURPLE))
          } else {
            cells.push(...textToCells('  ', S_NONE))
          }
          cells.push(...textToCells(idx, S_DIM))
          cells.push(...textToCells(opt.label, labelStyle))
          if (opt.freeform && active) {
            cells.push(...textToCells(': ', S_NONE))
            const t = freeform.text
            const c = freeform.cursor
            const before = t.slice(0, c)
            const cursorChar = c < t.length ? t[c] : ' '
            const after = c < t.length ? t.slice(c + 1) : ''
            cells.push(...textToCells(before, S_NONE))
            cells.push({ char: cursorChar, style: S_CURSOR, width: charWidth(cursorChar) })
            cells.push(...textToCells(after, S_NONE))
          }
          frame.push(truncateCellRow(cells, maxRowWidth))
          if (opt.description && !opt.freeform) {
            const descCells: Cell[] = []
            descCells.push({ char: ' ', style: S_NONE, width: 1 })
            descCells.push(...textToCells(' '.repeat(descIndent), S_NONE))
            descCells.push(...textToCells(opt.description, S_ACCENT_DIM))
            frame.push(truncateCellRow(descCells, maxRowWidth))
          }
        }
      } else {
        // compact (default): label and description on the same line,
        // right-padded into two aligned columns.
        // Compute max label column width for alignment.
        let maxLabelW = 0
        for (let i = vpStart; i < vpEnd; i++) {
          const o = opts[i]!
          const lw = visualWidth(o.label)
          if (lw > maxLabelW) maxLabelW = lw
        }
        const gapBetween = 2
        const labelCol = maxLabelW + gapBetween

        for (let i = vpStart; i < vpEnd; i++) {
          const opt = opts[i]!
          const active = i === selectIndex
          const idx = `${i + 1}.`.padEnd(maxIdxWidth + 2)
          const cells: Cell[] = []
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          if (active) {
            cells.push(...textToCells(`${GLYPH_SELECT_POINTER} `, S_BLUE_PURPLE))
          } else {
            cells.push(...textToCells('  ', S_NONE))
          }
          cells.push(...textToCells(idx, S_DIM))

          const labelStyle = active ? S_BLUE_PURPLE : S_NONE
          cells.push(...textToCells(opt.label, labelStyle))

          if (opt.freeform && active) {
            cells.push(...textToCells(': ', S_NONE))
            const t = freeform.text
            const c = freeform.cursor
            const before = t.slice(0, c)
            const cursorChar = c < t.length ? t[c] : ' '
            const after = c < t.length ? t.slice(c + 1) : ''
            cells.push(...textToCells(before, S_NONE))
            cells.push({ char: cursorChar, style: S_CURSOR, width: charWidth(cursorChar) })
            cells.push(...textToCells(after, S_NONE))
          } else if (opt.description) {
            const curLabelW = visualWidth(opt.label)
            const pad = Math.max(1, labelCol - curLabelW)
            cells.push(...textToCells(' '.repeat(pad), S_NONE))
            cells.push(...textToCells(opt.description, S_ACCENT_DIM))
          }

          frame.push(truncateCellRow(cells, maxRowWidth))
        }
      }

      if (needsScroll && vpEnd < totalOpts) {
        const cells: Cell[] = []
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push(...textToCells(`  \u2193 ${totalOpts - vpEnd} more below`, S_DIM))
        frame.push(cells)
      }

      // Blank line between options and hint (CC: marginTop={1} on hint Box)
      frame.push([{ char: ' ', style: S_NONE, width: 1 }])

      const hint: Cell[] = []
      hint.push({ char: ' ', style: S_NONE, width: 1 })
      const activeOpt = opts[selectIndex]
      const escHint = selectRequest.dismissible ? ' \u00b7 Esc to cancel' : ''
      const hintText = activeOpt?.freeform
        ? `Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 Type your answer${escHint}`
        : `Enter to select \u00b7 \u2191/\u2193 to navigate${escHint}`
      hint.push(...textToCells(hintText, S_DIM))
      frame.push(hint)

      // Live preview pane. The focused option may carry a `preview`
      // array of pre-rendered ANSI rows (e.g. the `/syntax` picker
      // attaches a colored diff snippet per theme). Render below the
      // hint with one blank-row separator so the visual block reads as
      // "options \u2193 preview". When the focused option has no preview
      // (e.g. the auto-appended `Other` row) the pane simply doesn't
      // appear \u2014 no flicker as the user arrows past it.
      if (activeOpt?.preview && activeOpt.preview.length > 0) {
        frame.push([{ char: ' ', style: S_NONE, width: 1 }])
        for (const row of activeOpt.preview) {
          const cells: Cell[] = []
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          cells.push(...ansiTextToCells(row))
          frame.push(cells)
        }
      }
    }

    // Todo panel. Driven by the model's `todoWrite` tool; gives the
    // user a live view of multi-step task progress. Inspired by
    // Claude Code's `<MessageResponse><TaskListV2/></MessageResponse>`
    // in `Spinner.tsx:280`, but adapted to our cell-buffer where
    // multiple anchor sources can sit above the panel.
    //
    // Anchor handling: the corner glyph `\u23bf` only renders on
    // row 1 when *no* anchor exists above the panel (no spinner, no
    // active tool calls). In that orphan case we also prepend a dim
    // "Update Todos" header so the corner has something to attach to.
    // When a spinner or live-tool row is already showing above, those
    // rows already carry their own `\u23bf` connector; adding a
    // second one here produces a visible double-corner (two `\u23bf`
    // glyphs stacked) so we drop ours and let the items sit as plain
    // indented rows under the existing anchor.
    //
    //   no anchor above            anchor above (spinner/tool)
    //     Update Todos               \u23bf Running command...
    //   \u23bf <icon> Task name           <icon> Task name
    //     <icon> Task name              <icon> Task name
    //
    // Other choices:
    //   - No "N tasks (X done, ...)" summary header \u2014 CC drops it; the
    //     icon progression (\u2713 vs \u25fc vs \u25fb) IS the status.
    //   - Completed: dim check + strikethrough dim content. Pending:
    //     hollow square in default color (NOT dim \u2014 pending is
    //     "waiting", not "forgotten"). In-progress: filled square +
    //     bold content, both in default fg. CC uses its accent orange
    //     (#d77757) here, but that hue clashes with the rest of our
    //     palette, so we lean on shape (filled vs hollow) + weight
    //     (bold vs regular) instead of color to signal active state.
    //   - No `activeForm` activity line. CC doesn't render one, and
    //     when the model echoed the same phrase for both fields the
    //     extra row was visual noise.
    if (todos && todos.length > 0) {
      const hasAnchorAbove = !!spinner || (activeToolCalls?.length ?? 0) > 0
      if (!hasAnchorAbove) {
        const headerCells: Cell[] = []
        headerCells.push({ char: ' ', style: S_NONE, width: 1 })
        headerCells.push(...textToCells('Update Todos', S_DIM))
        frame.push(headerCells)
      }
      for (let i = 0; i < todos.length; i++) {
        const t = todos[i]
        const cells: Cell[] = []
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        if (i === 0 && !hasAnchorAbove) {
          cells.push(...textToCells(GLYPH_TODO_BRACKET, S_GRAY_90))
        } else {
          cells.push({ char: ' ', style: S_NONE, width: 1 })
        }
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        if (t.status === 'completed') {
          cells.push(...textToCells(GLYPH_TODO_CHECK, S_DIM))
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          // ANSI 2 = dim, 9 = strikethrough.
          cells.push(...textToCells(t.content, '\x1b[0m\x1b[2;9m'))
        } else if (t.status === 'in_progress') {
          cells.push(...textToCells(GLYPH_TODO_IN_PROGRESS, S_BOLD))
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          cells.push(...textToCells(t.content, S_BOLD))
        } else {
          cells.push(...textToCells(GLYPH_TODO_PENDING, S_RESET))
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          cells.push(...textToCells(t.content, S_RESET))
        }
        frame.push(cells)
      }
    }

    // Reserved padding left over from a permission dialog that just closed.
    // Sits between the in-progress tool rows (above) and the input
    // separators (below) so the frame keeps the dialog's total height
    // until the approved tool's result commits and slides into the
    // reserved space.
    for (let i = 0; i < permissionSlotReserveRef.current; i++) {
      frame.push([])
    }

    // Top separator
    frame.push(textToCells(sepText, S_GRAY))

    // Input lines. `cursorAnchor` captures the frame-row index (0-based)
    // and 1-based visual column where the terminal's real cursor should
    // be parked at end of render. ESU is then chosen based on whether an
    // anchor is set: ESU_SHOW (trailing `\x1b[?25h`) reveals the caret at
    // that column so it is the one and only visible cursor; ESU_HIDE
    // (trailing `\x1b[?25l`) keeps it hidden when the input is disabled
    // or there is no active cursor line.
    let cursorAnchor: { row: number; col: number } | null = null
    for (let i = 0; i < displayLines.length; i++) {
      const line = displayLines[i]
      const prompt = i === 0 ? '> ' : '  '
      const showCursor = !disabled && i === cursorLine && cursorLine >= 0
      const cells: Cell[] = []

      cells.push({ char: prompt[0], style: S_GRAY, width: 1 })
      cells.push({ char: prompt[1], style: S_NONE, width: 1 })

      if (!showCursor) {
        const lw = visualWidth(line)
        const truncated = lw > vpWidth ? sliceByWidth(line, vpWidth) : line
        cells.push(...textToCells(truncated, S_RESET))
      } else {
        const before = line.slice(0, cursorCol)
        const cursorChar = cursorCol < line.length ? line[cursorCol] : ' '
        const after = cursorCol < line.length ? line.slice(cursorCol + 1) : ''
        const lw = visualWidth(line)

        if (lw <= vpWidth) {
          cells.push(...textToCells(before, S_RESET))
          // Visual col = prompt width (2) + width of chars before cursor,
          // +1 to convert to 1-based. Captured BEFORE pushing cursor cell
          // so it reflects the cursor cell's starting column.
          cursorAnchor = { row: frame.length, col: 2 + visualWidth(before) + 1 }
          cells.push({ char: cursorChar, style: S_CURSOR, width: charWidth(cursorChar) })
          cells.push(...textToCells(after, S_RESET))
        } else {
          const beforeWidth = visualWidth(before)
          const halfVP = Math.floor(vpWidth / 2)
          let skipCols = Math.max(0, beforeWidth - halfVP)
          const totalWidth = lw + (cursorCol >= line.length ? 1 : 0)
          if (skipCols + vpWidth > totalWidth) skipCols = Math.max(0, totalWidth - vpWidth)
          const startIdx = skipByWidth(line, skipCols)
          const vb = line.slice(startIdx, cursorCol)
          const afterStart = cursorCol < line.length ? cursorCol + 1 : line.length
          const remaining = vpWidth - visualWidth(vb) - charWidth(cursorChar)
          const va = sliceByWidth(line.slice(afterStart), Math.max(0, remaining))
          cells.push(...textToCells(vb, S_RESET))
          cursorAnchor = { row: frame.length, col: 2 + visualWidth(vb) + 1 }
          cells.push({ char: cursorChar, style: S_CURSOR, width: charWidth(cursorChar) })
          cells.push(...textToCells(va, S_RESET))
        }
      }
      frame.push(cells)
    }

    // Bottom separator
    frame.push(textToCells(sepText, S_GRAY))

    // Footer row — same layout pattern Claude Code / Codex / Gemini CLI
    // use: left text and right text on a SINGLE row, with the right
    // text right-aligned at the row's bottom-right corner. Built as one
    // cell sequence (left + padding spaces + right) inside the cell
    // buffer's frame, so the cell-diff loop owns the entire row's
    // contents — no out-of-band overlay writes.
    //
    // Width is capped at `termWidth - 1` cells (same width the bottom
    // separator above uses) so this row's geometry never lands on the
    // terminal's auto-wrap column boundary.
    //
    // Left side  — notice / mode indicator (mutually exclusive). Priority:
    //              notice > plan > acceptEdits. Mode switching via slash
    //              commands only (/plan); the Shift+Tab keybinding was
    //              removed because Windows needs Node ≥22.17 VT input mode
    //              and Alt+M is too easily clobbered by IDE menus.
    // Right side — context-window occupancy (`6.6k / 200k · 3%`), shown
    //              whenever a usage snapshot is available.
    //
    // The row is omitted entirely when neither side has content, so a
    // fresh session in default mode keeps a zero-row footer footprint.
    let leftCells: Cell[] | null = null
    if (notice) {
      const cells: Cell[] = []
      cells.push({ char: ' ', style: S_NONE, width: 1 })
      cells.push(...textToCells(notice, S_DIM))
      leftCells = cells
    } else if (permissionMode === 'plan') {
      const cells: Cell[] = []
      cells.push({ char: ' ', style: S_NONE, width: 1 })
      cells.push(...textToCells(`${GLYPH_PLAN_MODE} plan mode  ·  /plan to toggle`, S_DIM))
      leftCells = cells
    } else if (permissionMode === 'acceptEdits') {
      const cells: Cell[] = []
      cells.push({ char: ' ', style: S_NONE, width: 1 })
      cells.push(...textToCells(`${GLYPH_ACCEPT_EDITS} accept edits`, S_DIM))
      leftCells = cells
    }

    let rightText: string | null = null
    if (contextUsage && contextUsage.used > 0 && contextUsage.window > 0) {
      const pct = Math.round((contextUsage.used / contextUsage.window) * 100)
      rightText = `${formatTokens(contextUsage.used)} / ${formatTokens(contextUsage.window)} · ${pct}%`
    }

    if (leftCells || rightText) {
      // Footer row built as a NARROW cell sequence — left + ` · ` + right —
      // never padded out to termWidth-1.
      //
      // Why narrow: an earlier revision right-justified `rightText` by
      // padding with spaces to termWidth-1 cells. That made the LAST row
      // of the frame land its final cell on the terminal's auto-wrap
      // column. Under BSU/ESU sync mode on xterm.js (VS Code's terminal),
      // a frame whose bottom row is that wide leaks residual cells into
      // native scrollback every time a tool-result commit fires its LF
      // auto-scroll — manifesting as ghost "Thinking…" rows piling up
      // above the live frame. Keeping the row narrow stops the cursor
      // ever reaching the wrap column and the regression doesn't fire.
      //
      // Competitor CLIs (Codex, Gemini) right-justify because their
      // committed scrollback isn't pushed via LF auto-scroll — Codex
      // uses ratatui's full-screen buffer, Gemini uses Ink `<Static>`.
      // We can't right-justify cheaply without re-architecting the
      // commit path.
      const cells: Cell[] = []
      const leftWidth = leftCells ? leftCells.reduce((sum, c) => sum + c.width, 0) : 0
      if (leftCells) cells.push(...leftCells)
      if (rightText) {
        if (leftWidth > 0) {
          cells.push(...textToCells('  ·  ', S_DIM))
        } else {
          cells.push({ char: ' ', style: S_NONE, width: 1 })
        }
        cells.push(...textToCells(rightText, S_DIM))
      }
      frame.push(cells)
    }

    // Completion menu — at most one of slash / at renders per frame
    // (activeMenu enforces the mutex). Two writers in the same frame
    // would both compete for the rows above the input box, and a
    // resize would clobber whichever drew last.
    if (activeMenu === 'slash') {
      const maxNameLen = matches.reduce((max, cmd) => Math.max(max, cmd.name.length), 0)
      for (let i = 0; i < matches.length; i++) {
        const cmd = matches[i]
        const sel = i === safeIndex
        const cells: Cell[] = []
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        const nameStr = cmd.name.padEnd(maxNameLen + 2)
        if (sel) {
          cells.push(...textToCells(nameStr, S_BLUE_PURPLE_BOLD))
          cells.push(...textToCells(cmd.description, S_RESET))
        } else {
          cells.push(...textToCells(nameStr + cmd.description, S_DIM))
        }
        frame.push(cells)
      }
    } else if (activeMenu === 'at') {
      if (atMatches.length === 0) {
        // No-matches placeholder — keeps the user oriented when
        // typing `@vitejs/plugin-react` or any token that doesn't
        // map to a local file. The text still goes out to the model
        // verbatim on Enter; the placeholder is purely a UI hint.
        const cells: Cell[] = []
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push(...textToCells('No matches', S_DIM))
        frame.push(cells)
      } else {
        const maxColWidth = Math.max(10, termWidth - 4)
        for (let i = 0; i < atMatches.length; i++) {
          const entry = atMatches[i]
          const sel = i === safeAtIndex
          const cells: Cell[] = []
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          const display = '@' + entry.relPath + (entry.isDirectory ? '/' : '')
          const truncated = truncatePathFromStart(display, maxColWidth)
          cells.push(...textToCells(truncated, sel ? S_BLUE_PURPLE_BOLD : S_DIM))
          frame.push(cells)
        }
      }
    }

    // ── Plan b: weak-terminal streaming bail-out (REMOVED). ──────────────
    //
    // History: we used to clear the entire frame (`frame.length = 0`)
    // during streaming on terminals that didn't honor DEC 2026 sync —
    // the rationale was that pre-scroll (`\n.repeat(N)`) followed by a
    // non-atomic frame redraw produced visible "input box jitter" at
    // the bottom row. Hiding the frame cured the jitter at the cost of
    // hiding the input box, spinner, separators, elapsed-time, active
    // tool list, and todos for the entire reply.
    //
    // Why we dropped it: two things changed since.
    //
    //  1. The streaming-chunk bookkeeping was broken at the time —
    //     `freeBlanksAboveFrameRef` wasn't decremented when chunks
    //     filled the blank rows below the (hidden) frame, so the
    //     end-of-turn commit computed wrong preScroll and the
    //     `\x1b[J` swept away half the reply. Hiding the frame masked
    //     the symptom on capable terminals (xterm.js's scrollback
    //     quirks held the missing rows) but the underlying account was
    //     wrong. With the Plan b path now decrementing scrollRows
    //     correctly (~25 lines below this point), pre-scroll only
    //     fires when freeBlanks is actually exhausted, not on every
    //     chunk. That alone reduces the jitter source dramatically.
    //
    //  2. The capable-terminal whitelist above used to miss every
    //     mainstream Linux desktop terminal (no VTE_VERSION check),
    //     so Ubuntu/Fedora users on GNOME Terminal hit the bail-out
    //     unconditionally and lost their input box during every AI
    //     reply — same problem class as ConHost on Windows. Even
    //     after we expanded the whitelist, ConHost-class terminals
    //     remain "weak" by definition; the right answer for them is
    //     visible-with-some-jitter, not invisible.
    //
    // Capable terminals (Windows Terminal, iTerm2, Ghostty, kitty,
    // Alacritty, WezTerm, VTE 0.68+, foot, contour, Warp, Zed) get the
    // smooth atomic-DEC-2026 path. Weak terminals (legacy ConHost via
    // cmd.exe / Windows PowerShell host) get the same frame, just with
    // potentially-visible cursor walks during cell-diff redraws — a
    // tradeoff users explicitly preferred over a missing input box.

    // ── Diff against previous frame and emit one buffered write ──────────
    //
    // Frame is PINNED to the last `nextH` rows of the terminal. Every
    // render jumps the cursor absolutely to the frame's top-left — no
    // relative up/down walks from a "parked" position, no dependence on
    // where the last render left the cursor. This is what lets the
    // DECSTBM scrollback path (above) work correctly: that path parks the
    // cursor at row (termRows - H) after reset-scroll-region, which would
    // break any relative cursor math anchored to "the last row of the
    // previous frame".
    const nextH = frame.length
    const oldFrameH = lastFrameHRef.current
    // Floating-frame model: when there are blank rows below the frame
    // (freeBlanks > 0), the frame floats up so it sits right after the
    // last content row. When freeBlanks reaches 0 the frame is at the
    // bottom (the original behavior). frameTop is recomputed every time
    // pendingFreeBlanks changes (after a commit absorbs blanks, after
    // a frame-size change, etc.) so the cell-diff loop further down
    // always writes at the position the frame will end up at.
    const computeFrameTop = (blanks: number) => Math.max(1, termRows - nextH + 1 - blanks)
    let frameTop = computeFrameTop(freeBlanksAboveFrameRef.current)
    // Geometry trace — diagnostics for the "input box drifting / dialog
    // duplicate" symptom. Logs the inputs the bottom-anchor formula
    // depends on so we can see which render is the one that starts
    // shifting blanks. Cheap (no JSON.stringify of large structures), so
    // safe to leave on under DEBUG_STDOUT=1.
    debugLog(
      'chatinput.geom.in',
      `termRows=${termRows} oldFrameH=${oldFrameH} nextH=${nextH} ` +
        `blanks=${freeBlanksAboveFrameRef.current} frameTop=${frameTop} ` +
        `lastTop=${lastFrameTopRef.current} ` +
        `permission=${permission ? '1' : '0'} ` +
        `select=${selectRequest ? '1' : '0'} ` +
        `activeTools=${activeToolCalls?.length ?? 0} ` +
        `todos=${todos?.length ?? 0} ` +
        `spinner=${spinner ? '1' : '0'} ` +
        `didCommit=${messages.length > writtenMessageCountRef.current ? '1' : '0'}`,
    )

    // First render: seed the "blanks above frame" tracker. The banner
    // (initialContentRows) occupies the top of the viewport; everything
    // else up to where the frame sits is blank. Subsequent grows can
    // consume those blanks without pre-scrolling, so the banner stays
    // in view during normal operation.
    if (isFirstPaint && initialContentRows > 0) {
      freeBlanksAboveFrameRef.current = Math.max(0, termRows - initialContentRows - nextH)
      // Re-seed frameTop now that freeBlanks is set so the very first
      // paint floats the frame up to sit immediately below the banner
      // instead of stranding it at the bottom of an otherwise-empty
      // terminal.
      frameTop = computeFrameTop(freeBlanksAboveFrameRef.current)
    }

    // ── Terminal resize: erase old frame at its previous position ────────
    //
    // When the terminal dimensions change, the old frame must be erased
    // before painting the new one.
    //
    // Height-only: the old frame position is predictable from oldTermRows.
    //
    // Width change: the terminal reflows ALL visible content. Old separator
    // lines (e.g. 120 '─' chars at old width) may wrap to multiple rows
    // when the terminal narrows, pushing them above where the new frame
    // will be painted. We must erase those reflowed remnants WITHOUT wiping
    // the scrollback content above (the user's conversation). Approach:
    // estimate how many extra rows the old frame now occupies after reflow,
    // then erase from (frameTop - extraRows) down to end of display.
    const oldTermRows = lastTermRowsRef.current
    const oldTermWidth = lastTermWidthRef.current
    const didResize =
      oldFrameH > 0 &&
      activeRef.current &&
      ((oldTermRows > 0 && oldTermRows !== termRows) || (oldTermWidth > 0 && oldTermWidth !== termWidth))
    if (didResize) {
      const widthChanged = oldTermWidth > 0 && oldTermWidth !== termWidth
      if (widthChanged) {
        // Estimate how many rows the old frame expanded to after reflow.
        // The old separator lines were (oldTermWidth - 1) chars each; after
        // reflow at the new termWidth, each wraps to ceil(oldChars / newW)
        // rows. The frame has 2 separators + (oldFrameH - 2) normal rows
        // (input, spinner, etc — those are short and don't wrap).
        const oldSepLen = Math.max(0, oldTermWidth - 1)
        const newW = Math.max(1, termWidth)
        const sepRowsAfterReflow = Math.ceil(oldSepLen / newW)
        // 2 separator rows expanded, the rest stayed at 1 row each
        const reflowedFrameH = oldFrameH - 2 + 2 * sepRowsAfterReflow
        const extraRows = Math.max(0, reflowedFrameH - oldFrameH)
        const eraseFrom = Math.max(1, frameTop - extraRows)
        preBuf += `\x1b[${eraseFrom};1H\x1b[J`
      } else {
        // Height-only change: use the actual last-rendered top (the
        // frame may have been floating before the resize, so the
        // bottom-anchor formula is no longer reliable).
        const oldFrameTop =
          lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, oldTermRows - oldFrameH + 1)
        const eraseFrom = Math.min(oldFrameTop, frameTop)
        preBuf += `\x1b[${eraseFrom};1H\x1b[J`
      }
      // Resize invalidates the floating-frame state; the next render
      // re-seeds freeBlanks via the first-paint path or commit branch.
      freeBlanksAboveFrameRef.current = 0
      frameTop = computeFrameTop(0)
    }
    lastTermRowsRef.current = termRows
    lastTermWidthRef.current = termWidth

    // ── Scrollback-commit write (inline-stream) ──────────────────────────
    //
    // Writes new `content + frame` as ONE continuous stream starting at
    // row `startRow = termRows - scrollRows - nextH + 1`, ending exactly
    // at `termRows`. Rows that would be overwritten by the write AND
    // previously held real scrollback content are first pushed to the
    // terminal's real scrollback via pre-scroll `\n`s at screen bottom
    // (the only mechanism xterm.js / Windows Terminal honor for preserving
    // content — DECSTBM-restricted region scrolls are splice-discarded in
    // xterm.js's InputHandler, confirmed in source).
    //
    // Pre-scroll amount = (rows in [startRow, termRows] that were
    // above the old frame) = max(0, scrollRows + nextH - oldFrameH).
    // This is 0 on first-paint / post-hidden (oldFrameH = 0, no active
    // scrollback to preserve — pre-existing rows above stay put), it is
    // scrollRows in the steady-state active case, and scrollRows +
    // (nextH - oldFrameH) when the frame grows (e.g. spinner appearing
    // at user submission).
    //
    // After the pre-scroll, existing content rests at rows shifted up,
    // and the write zone [startRow, termRows] contains the bottom rows
    // of the old frame and the blanks just created by the pre-scroll —
    // safe to overwrite entirely. The write places new content at
    // rows [frameTop - scrollRows, frameTop - 1] and the new frame at
    // [frameTop, termRows].
    //
    // prevFrameRef is set to the just-written frame so the diff loop
    // below emits only cursor advances (no cell writes) — no separate
    // frame-redraw phase, no flicker.
    //
    // Cursor is hidden for the duration of the write.
    // Deferred-flush staging for freeBlanksAboveFrameRef. Two renders with
    // the same (oldFrameH → nextH) transition used to each apply `+=
    // deltaH` against the live ref before either one's stdout write ran —
    // so on a shrink that got re-rendered once before its deferred flush
    // fired, the blank-row credit doubled. Accumulating the target in a
    // local and committing it in doFlush makes the mutation idempotent:
    // every render of the same state computes the same target, only the
    // one whose payload actually writes applies it. Symptom it cured:
    // 3+ persistent blank lines appearing after every Bash approval.
    let pendingFreeBlanks = freeBlanksAboveFrameRef.current
    const scrollRows = didCommitMessages ? countContentRows(scrollbackContent, termWidth) : 0
    let handledCommitWithFrame = false
    let forceFullRedraw = false
    if (didCommitMessages && scrollRows > 0 && nextH > 0 && nextH < termRows) {
      // Available rows we already "own" above the current frame: the old
      // frame itself (about to be overwritten) plus any blank rows left
      // by a recent shrink (dialog close). If the new content+frame fits
      // within that space, no full-screen scroll is needed. If it doesn't,
      // pre-scroll the shortfall into real terminal scrollback history.
      // Floating-frame model: freeBlanks always represents the budget of
      // re-usable rows below the frame (or above when frame is at the
      // bottom — same value, just placed differently). On first-paint
      // (oldFrameH = 0) it was just seeded from termRows-banner-nextH so
      // the very first commit can write content right after the banner
      // and leave the residual blanks below the frame.
      const freeBlanks = freeBlanksAboveFrameRef.current
      const availSpace = oldFrameH + freeBlanks
      // Cap pre-scroll to the actual count of viewport rows holding old
      // content above the frame (`termRows - availSpace`). The naive
      // `scrollRows + nextH - availSpace` overshoots whenever new content
      // exceeds what fits between the top of the viewport and the frame —
      // each \n past that point auto-scrolls a *blank* row into real
      // scrollback, leaving a visible gap of empty lines between the
      // user's previous history and the just-committed message. The
      // remaining shortfall is absorbed naturally by auto-scroll while
      // `scrollbackContent` is being written below (each wrapped line
      // beyond termRows triggers one row of LF-driven scroll, same
      // mechanism — just interleaved with content instead of upfront
      // blanks). Symptom this cures: long tool-result commits (e.g. a
      // ~115-row ExitPlanMode plan) leaving ~30 blank rows in scrollback
      // history above the rendered plan body.
      const maxUsefulPreScroll = Math.max(0, termRows - availSpace)
      const preScrollRows = Math.max(0, Math.min(scrollRows + nextH - availSpace, maxUsefulPreScroll))
      debugLog(
        'chatinput.geom.commit',
        `scrollRows=${scrollRows} nextH=${nextH} oldFrameH=${oldFrameH} ` +
          `availSpace=${availSpace} preScroll=${preScrollRows} ` +
          `freeBlanks=${freeBlanks}`,
      )
      // Write scrollbackContent DIRECTLY after the last row of real
      // scrollback — this consumes the free-blank region row-by-row
      // instead of leaving it stranded as a visible gap between the
      // earlier history and the newly committed content.
      const startRow = Math.max(1, termRows - availSpace - preScrollRows + 1)
      // Rows still blank after this commit. These become the next
      // render's freeBlanks — either kept BELOW the frame (frame keeps
      // floating up) or implicitly consumed when the frame reaches the
      // bottom (freeBlanks = 0).
      const rawLeftover = Math.max(0, availSpace + preScrollRows - scrollRows - nextH)
      // When the frame shrank significantly (e.g. select/askUser dialog
      // closed), the old availSpace reflects the large dialog. Without
      // capping, leftoverBlanks can be 12+ rows, leaving the frame
      // floating at the top of the viewport with a huge blank gap below.
      // For large shrinks (> 3 rows), snap blanks to 0 so the frame
      // immediately anchors to the bottom. Small shrinks (≤ 3) use the
      // natural floor to let the floating-frame model consume blanks
      // gradually.
      const frameShrunk = oldFrameH - nextH
      const maxBlanks = frameShrunk > 3 ? 0 : termRows - nextH
      const leftoverBlanks = Math.min(rawLeftover, maxBlanks)
      pendingFreeBlanks = leftoverBlanks
      // Recompute frameTop now that pendingFreeBlanks reflects the
      // post-commit free-row budget. In the floating-frame model the
      // frame's top moves DOWN by scrollRows on every commit (until it
      // reaches the bottom and stays there) — the cell-diff loop and
      // the FULL-REDRAW path below both anchor at this updated value.
      frameTop = computeFrameTop(pendingFreeBlanks)
      // No `\x1b[?25l` here. Earlier revisions hid the cursor across the
      // scroll-clear-redraw window so its intermediate positions inside
      // the renderRowToAnsi loop wouldn't blink across rows on terminals
      // that don't fully atomize DEC 2026 — but at the 10-15Hz commit
      // cadence of streaming responses this produced exactly the same
      // hide/show flap that the spinner-tick path already removed for
      // the same reason (see comment at the top of this file). DEC 2026
      // sync on every target terminal (xterm.js / VSCode, Windows
      // Terminal, iTerm2, Ghostty) already buffers the intermediate
      // positions, and ESU_SHOW at the bottom of this render places the
      // cursor at the input column. Cursor stays visible throughout.
      // Two paths from here:
      //
      //   FULL-REDRAW PATH — used when (a) the new content forces a
      //     full-screen scroll (preScrollRows > 0) so the frame slid off
      //     the bottom and must be repainted at the new bottom, OR
      //     (b) the frame's height is changing this render (oldFrameH
      //     !== nextH), e.g. the spinner is appearing/disappearing or
      //     a permission dialog is opening/closing. Frame-height changes
      //     can't go through the optimization below because the cell-
      //     diff loop's `maxH = max(prevH, nextH)` then iterates past
      //     the new bottom row, triggering a `\x1b[1B\r` from the last
      //     terminal row and auto-scrolling the bottom separator out of
      //     view. Symptom this cured: the bottom `─────` row vanishing
      //     the moment an AI reply finished (frame went 4-row → 3-row
      //     at end-of-stream).
      //
      //   MINIMAL-WRITE PATH — used when the frame is stable in size
      //     AND no scroll is needed. Streaming responses spend almost
      //     all their commits here. Don't `[J]`-clear or repaint the
      //     frame at all; only clear the gap rows between scrollback
      //     and frame, and let the cell-diff loop below pick up genuine
      //     frame changes (typically just the 1-cell spinner glyph
      //     swap). This is what eliminates the visible wipe-and-repaint
      //     of the spinner / separator / input rows on every commit.
      const frameSizeChanged = oldFrameH !== nextH
      // Floating-frame model: any commit that moves the frame's top row
      // (i.e. freeBlanks was non-zero before this commit) MUST go
      // through FULL-REDRAW. The cell-diff loop further down assumes
      // the on-screen frame still matches prevFrameRef.current — true
      // when frame stayed put, false when it just moved. Without this
      // guard, after a commit the cell-diff would write the new frame
      // at the new (lower) frameTop while the old frame's cells are
      // still painted at the old (higher) position — leaving stale
      // rows above the new frame.
      const frameMoved = freeBlanksAboveFrameRef.current > 0
      if (preScrollRows > 0 || frameSizeChanged || frameMoved) {
        // FULL-REDRAW PATH.
        const oldFrameTopForClear =
          lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, termRows - oldFrameH + 1)
        const oldFrameBottomForClear = Math.min(oldFrameTopForClear + oldFrameH - 1, termRows)
        if (preScrollRows > 0) {
          // Erase old frame BEFORE the pre-scroll LFs. After the LFs push
          // N viewport rows into the terminal's real scrollback history,
          // those rows become permanent — no ANSI escape can clear them.
          // If the old frame (with its Thinking/spinner line) sits at rows
          // that will be pushed above startRow by the scroll, the post-
          // scroll erase loop can't reach them and they persist as ghost
          // "Thinking..." lines in the user's scrollback. Erasing the
          // old frame here ensures only blank rows enter scrollback history.
          for (let r = oldFrameTopForClear; r <= oldFrameBottomForClear; r++) {
            preBuf += `\x1b[${r};1H\x1b[K`
          }
          // Push `preScrollRows` rows into the terminal's real scrollback
          // by emitting N LFs at the bottom row. This is the ONLY portable
          // mechanism that preserves displaced rows in scrollback history:
          // SU (`\x1b[NS`) and DECSTBM-restricted scrolls both shift cells
          // in the viewport but discard the rows that fall off the top
          // on Windows Terminal, ConHost, iTerm2, native macOS Terminal,
          // Ghostty, and Alacritty. (xterm.js was the one outlier where
          // SU sometimes lands in scrollback — an earlier revision of
          // this file used SU on that basis and silently swallowed the
          // overflow on every other target terminal: any AI reply taller
          // than the available rows above the frame lost its top lines.)
          // Auto-scroll triggered by LF at termRows is universally honored.
          preBuf += `\x1b[${termRows};1H` + '\n'.repeat(preScrollRows)
        }
        // After pre-scroll (or when no scroll needed), erase the viewport
        // rows that will hold new content. When preScroll happened, old
        // frame rows have already been blanked above; the post-scroll
        // viewport rows [startRow, termRows] are blank lines created by
        // the scroll. We still clear [startRow, clearEnd] to handle the
        // non-scroll cases (frameSizeChanged / frameMoved) where old frame
        // cells sit at their original positions.
        const clearEnd = preScrollRows > 0 ? termRows : oldFrameBottomForClear
        for (let r = startRow; r <= clearEnd; r++) {
          preBuf += `\x1b[${r};1H\x1b[K`
        }
        preBuf += `\x1b[${startRow};1H`
        preBuf += scrollbackContent
        // When the frame shrank significantly (e.g. askUser dialog closed),
        // scrollback content only fills a fraction of the space the old frame
        // occupied. Instead of anchoring the frame at the terminal bottom and
        // leaving a visible blank gap between scrollback and frame, place the
        // frame directly below the scrollback content. The remaining blank
        // rows below the frame are recorded in pendingFreeBlanks so
        // subsequent commits can consume them naturally (frame floats down
        // toward the bottom as new content arrives).
        if (preScrollRows === 0 && frameShrunk > 3 && leftoverBlanks === 0) {
          const scrollEndRow = startRow + scrollRows
          if (scrollEndRow < frameTop) {
            frameTop = scrollEndRow
            const belowFrame = Math.max(0, termRows - frameTop - nextH + 1)
            pendingFreeBlanks = belowFrame
          }
        }
        preBuf += `\x1b[${frameTop};1H`
        for (let i = 0; i < nextH; i++) {
          preBuf += renderRowToAnsi(frame[i]) + '\x1b[K'
          if (i < nextH - 1) preBuf += '\r\n'
        }
        prevFrameRef.current = frame
      } else {
        // MINIMAL-WRITE PATH (the dominant case during streaming).
        // Clear ONLY the rows in [startRow, frameTop), write scrollback
        // into them, and leave the frame area untouched. The cell-diff
        // loop below compares the unchanged on-screen frame against the
        // new frame and emits only the cells that actually differ
        // (spinner glyph, elapsed-time digits).
        for (let r = startRow; r < frameTop; r++) {
          preBuf += `\x1b[${r};1H\x1b[K`
        }
        preBuf += `\x1b[${startRow};1H` + scrollbackContent
        // Always park cursor at frameTop after scrollback write.
        // The cell-diff loop uses absolute positioning per row, but
        // an explicit jump prevents any cursor-position mismatch
        // from causing visual artifacts.
        preBuf += `\x1b[${frameTop};1H`
        // DON'T set prevFrameRef.current = frame here — the on-screen
        // frame is still the previous render's frame (we didn't repaint
        // it), and the cell-diff loop below needs to compare against
        // that to find the cells that genuinely changed.
      }
      handledCommitWithFrame = true
    } else if (didCommitMessages) {
      // Plan b weak-terminal path: nextH=0 (frame was cleared by the
      // streaming bail-out above) but oldFrameH may still be > 0 — the
      // OLD frame is still painted on screen. If we let scrollbackContent
      // write first, its trailing `\r\n\r\n` triggers auto-scrolls at
      // termRows that push the OLD top-separator and OLD input row into
      // the terminal's scrollback history (visible as "horizontal line +
      // `> 查询…`" appearing above the AI response). The erase done by
      // the shrink path BELOW fires too late — it lands on the just-
      // shifted rows and erases the new echo instead.
      //
      // Fix: erase the OLD frame rows FIRST, here, before scrollbackContent
      // writes. With the frame area cleared, the echo's auto-scrolls push
      // BLANK rows into scrollback rather than old frame remnants, and
      // the echo lands cleanly. Mark handledCommitWithFrame so the shrink
      // path below doesn't double-erase.
      if (oldFrameH > 0 && nextH < oldFrameH && !permission) {
        // Use the actual previous frame top (floating-frame model means
        // the OLD frame may have sat above the bottom-anchor position).
        const oldTop = lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, termRows - oldFrameH + 1)
        for (let i = 0; i < oldFrameH; i++) {
          preBuf += `\x1b[${oldTop + i};1H\x1b[K`
        }
        // Cursor sits at top of where the old frame was, so the echo
        // writes there instead of one row below the old input.
        preBuf += `\x1b[${oldTop};1H`
        pendingFreeBlanks = freeBlanksAboveFrameRef.current + oldFrameH
        frameTop = computeFrameTop(pendingFreeBlanks)
        debugLog(
          'chatinput.geom.commit-shrink-erase',
          `oldTop=${oldTop} oldFrameH=${oldFrameH} nextH=${nextH} ` +
            `blanks ${freeBlanksAboveFrameRef.current}->${pendingFreeBlanks} ` +
            `frameTop=${frameTop}`,
        )
        forceFullRedraw = true
        handledCommitWithFrame = true
      }
      // Account for streamed-content rows so freeBlanks tracks reality.
      // Plan b runs every render where messages committed but the frame
      // is hidden (nextH=0, the streaming bail-out) — i.e. on every chunk
      // of an AI reply. `scrollbackContent` is about to be written into
      // rows the renderer previously thought were blank (the `freeBlanks`
      // budget seeded from termRows-banner-frameH on first paint). Without
      // this decrement, freeBlanks stays at its initial value for the
      // entire response, so the FINAL render at end-of-stream (nextH:0→3,
      // takes the main FULL-REDRAW path) computes availSpace=oldFrameH+
      // freeBlanks=40, preScroll=0, and \x1b[J wipes the streamed body.
      // xterm.js / VSCode's terminal accidentally papered over this via
      // its own scrollback quirks (see SU comment around line 1932); on
      // ConHost / Windows PowerShell host / GNOME Terminal / xterm /
      // every other target, the body really did get wiped, leaving only
      // the last 1-2 lines above the input box once the spinner stopped.
      // Mirror of the leftoverBlanks bookkeeping the main commit path
      // does at line ~1869 — same idea, just applied on the Plan b side.
      if (scrollRows > 0) {
        const before = pendingFreeBlanks
        pendingFreeBlanks = Math.max(0, pendingFreeBlanks - scrollRows)
        frameTop = computeFrameTop(pendingFreeBlanks)
        debugLog(
          'chatinput.geom.commit-streaming',
          `scrollRows=${scrollRows} blanks ${before}->${pendingFreeBlanks} frameTop=${frameTop}`,
        )
      }
      preBuf += scrollbackContent
    }

    let buf = ''

    // Frame-height change: the frame is pinned to the bottom, so when
    // H grows, its top moves UP — risking overwrite of scrollback rows
    // that currently live there.
    //
    // Small grows (≤3 rows — spinner appearing, permission dialog) use
    // a full-screen scroll so the displaced content ends up preserved
    // in the terminal's real scrollback.
    //
    // Large grows (≥4 rows — SelectOptions picker, completion menu with
    // many items) are almost always sitting over blank rows in a typical
    // session (banner + some blanks + frame at bottom). Pre-scrolling
    // those blanks INTO real scrollback permanently consumes viewport
    // rows that the subsequent shrink can't recover — that's the
    // "after /model there's a big blank" complaint. We skip the
    // pre-scroll in this case and instead erase the grow area before
    // the cell diff repaints over it. When the frame shrinks back, the
    // existing erase branch below clears the expanded area and the
    // layout returns to exactly what it was before the grow.
    //
    // For shrinks, the bottom of the old frame stays exposed as "stale
    // frame cells" above the new top — clear those rows.
    if (!handledCommitWithFrame && activeRef.current && oldFrameH > 0 && oldFrameH !== nextH) {
      if (nextH > oldFrameH) {
        const deltaH = nextH - oldFrameH
        // Consume as much freshly-blank space below the frame as we can —
        // those rows can be overwritten without losing anything. Any excess
        // expansion exceeds the bottom blanks, so pre-scroll that much into
        // real scrollback to preserve content above (banner, earlier
        // messages). Without this, typing `/` to open the completion menu
        // would wipe whatever scrollback sat right above the input.
        const absorbed = Math.min(deltaH, freeBlanksAboveFrameRef.current)
        const needsScroll = deltaH - absorbed
        if (needsScroll > 0) {
          // Erase the old frame before scrolling so that blank rows — not
          // stale prompt/separator cells — get pushed into terminal scrollback.
          // Without this, the `> ▊` prompt line becomes a permanent ghost in
          // scrollback after the select dialog closes.
          const oldTop = lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, termRows - oldFrameH + 1)
          for (let i = 0; i < oldFrameH; i++) {
            preBuf += `\x1b[${oldTop + i};1H\x1b[K`
          }
          preBuf += `\x1b[${termRows};1H` + '\n'.repeat(needsScroll)
        }
        pendingFreeBlanks = Math.max(0, freeBlanksAboveFrameRef.current - deltaH)
        // Recompute frameTop for the new (smaller) freeBlanks. With pure
        // absorb (no scroll), frameTop stays at the old top and the frame
        // grows downward. With scroll, frameTop drops to the bottom-anchor
        // position (newFreeBlanks=0).
        frameTop = computeFrameTop(pendingFreeBlanks)
        debugLog(
          'chatinput.geom.grow',
          `delta=${deltaH} absorbed=${absorbed} scrolled=${needsScroll} ` +
            `blanks ${freeBlanksAboveFrameRef.current}->${pendingFreeBlanks} ` +
            `frameTop=${frameTop}`,
        )
        // Pre-erase the newly-occupied bottom-of-frame rows so any stale
        // cells (from prior renders or auto-scroll residue) don't bleed
        // through before the diff below repaints them.
        for (let i = 0; i < deltaH; i++) {
          preBuf += `\x1b[${frameTop + oldFrameH + i};1H\x1b[K`
        }
      } else {
        const deltaH = oldFrameH - nextH
        // Shrink: the frame got shorter (e.g. a select dialog closed).
        // Erase the ENTIRE old frame area so no ghost content remains
        // (old spinner rows, dialog options, etc.) and reposition the
        // frame near the bottom.
        //
        // Large shrinks (e.g. askUser dialog closing: 37→7) would
        // otherwise leave 26+ blank rows. The frame floats at row 1
        // and takes many commits to drift back down, leaving the user
        // staring at a mostly-blank screen. Cap blanks to 0 so the
        // frame snaps to the bottom immediately after a big shrink.
        // Small shrinks (≤3 rows, e.g. permission dialog closing) can
        // keep their blanks for the floating-frame model to consume
        // naturally — the gap is barely visible.
        const rawBlanks = freeBlanksAboveFrameRef.current + deltaH
        const MAX_SHRINK_BLANKS = deltaH > 3 ? 0 : termRows - nextH
        pendingFreeBlanks = Math.min(rawBlanks, MAX_SHRINK_BLANKS)
        const oldTop = lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, termRows - oldFrameH + 1)
        frameTop = computeFrameTop(pendingFreeBlanks)
        debugLog(
          'chatinput.geom.shrink',
          `delta=${deltaH} blanks ${freeBlanksAboveFrameRef.current}->${pendingFreeBlanks} ` +
            `(raw=${rawBlanks}) ` +
            `oldTop=${oldTop} newTop=${frameTop}`,
        )
        // Erase the entire old frame area — not just the bottom delta
        // rows. When the frame moves from a high position (oldTop=3)
        // to near the bottom (frameTop=28), rows at the old position
        // must be cleared to prevent ghost spinners / stale content.
        for (let i = 0; i < oldFrameH; i++) {
          preBuf += `\x1b[${oldTop + i};1H\x1b[K`
        }
      }
      // Frame moved — prev cell matrix is at the wrong rows now; force
      // full redraw at the new position.
      // NOTE: do NOT mutate prevFrameRef.current here. This code runs
      // during payload construction, but for non-commit (deferred)
      // renders the doFlush that writes this payload to stdout may be
      // CANCELLED by a commit arriving 1-2 ms later. If we cleared
      // prevFrameRef now and the deferred is cancelled, the ref stays
      // [] while the on-screen frame is still the OLD frame — causing
      // the next render's cell-diff to treat every row as "fresh",
      // writing the full Thinking line at the NEW frameTop while the
      // OLD Thinking remains on screen at the OLD position → two
      // visible "Thinking…" lines.
      // Instead, use a local flag; doFlush (line below) sets
      // prevFrameRef = frame unconditionally after a successful write.
      forceFullRedraw = true
    }

    const prevFrame = forceFullRedraw ? [] : prevFrameRef.current
    const prevH = prevFrame.length
    const maxH = Math.max(prevH, nextH)

    // PER-ROW ABSOLUTE POSITIONING (Claude-Code style).
    //
    // Earlier code did `jump-to-frame-top, then walk-down each row with
    // \x1b[1B\r`. On a steady spinner tick only ONE cell in ONE row
    // actually differs, but the relative-walk approach emitted
    // `\x1b[1B\r` after every row regardless — moving the cursor through
    // every unchanged row of the frame on the way down, plus an initial
    // jump to frame-top, plus a final park to the cursor anchor. That's
    // 5+ cursor positions per tick and on terminals whose DEC 2026 sync
    // doesn't fully atomize cursor positions (Windows Terminal, VSCode
    // xterm.js, ConHost) every intermediate stop is processed by the
    // terminal's renderer — visible as a flicker even with the cursor
    // hidden, because each cursor-position command kicks the cell-render
    // pipeline.
    //
    // Per-row absolute (`\x1b[absRow;colH` only on rows we actually
    // write) means a stable spinner tick visits 2 cursor positions:
    // the spinner cell, and the final cursor-anchor park. Unchanged
    // rows are SKIPPED — no jump to them, no `\x1b[K`, no advance.
    for (let row = 0; row < maxH; row++) {
      const prevRow = row < prevH ? prevFrame[row] : []
      const nextRow = row < nextH ? frame[row] : []
      const absRow = frameTop + row

      if (row < nextH) {
        // First cell that differs from prevRow
        let diffIdx = 0
        const minCells = Math.min(prevRow.length, nextRow.length)
        while (diffIdx < minCells && cellsEqual(prevRow[diffIdx], nextRow[diffIdx])) {
          diffIdx++
        }
        // Last cell that differs (scanning from the end). On a fresh
        // redraw (prevRow empty) we keep emitting through end-of-row;
        // otherwise we cap at the last actual change so that, e.g., a
        // spinner tick rewrites just the glyph cell instead of the
        // entire " glyph  Thinking… (5s · ↑ 2k tokens)" suffix every
        // 80ms. Less to write = fewer visible cells re-painting per
        // tick = no perceptible flash on terminals where DEC 2026
        // sync-update isn't perfectly atomic.
        let endIdx = nextRow.length
        if (prevRow.length > 0 && nextRow.length === prevRow.length) {
          let last = nextRow.length - 1
          while (last >= diffIdx && cellsEqual(prevRow[last], nextRow[last])) {
            last--
          }
          endIdx = last + 1 // exclusive bound
        }

        // Force-clear branch: prevRow is empty AND nextRow is empty.
        // Normally an "empty stays empty" row is a no-op, but when the
        // upstream grow/shrink path resets prevFrameRef to [] to force a
        // full repaint, an empty row at this position can shadow stale
        // characters left on screen by the previous (taller) frame —
        // most visibly the input box's `─` top separator peeking through
        // a newly inserted blank between two parallel tool blocks. The
        // explicit \x1b[K wipes whatever the terminal still has at this
        // row before the redraw moves on.
        if (prevRow.length === 0 && nextRow.length === 0) {
          buf += `\x1b[${absRow};1H\x1b[K`
        } else if (diffIdx < nextRow.length || nextRow.length < prevRow.length) {
          // Absolute-position to (absRow, diffIdx's visual column).
          let col = 0
          for (let c = 0; c < diffIdx; c++) col += nextRow[c].width
          buf += `\x1b[${absRow};${col + 1}H`

          // Emit changed cells. Initialize lastStyle to S_NONE (= explicit
          // reset code) so the first cell's char doesn't inherit any SGR
          // state left over from the previous render — without this, the
          // diff loop's `if (cell.style !== lastStyle) buf += cell.style`
          // branch could emit '' (no-op) for an S_NONE cell whose char
          // then renders in whatever color was active before.
          let lastStyle = S_NONE
          buf += S_NONE
          for (let c = diffIdx; c < endIdx; c++) {
            const cell = nextRow[c]
            if (cell.style !== lastStyle) {
              buf += cell.style
              lastStyle = cell.style
            }
            buf += cell.char
          }
          buf += S_RESET
          if (prevRow.length === 0) {
            // Fresh redraw (post-eraseRegion or first paint). The row may
            // carry stale chars from scrollback writes that preceded this
            // frame (e.g. a CJK line whose width miscalculation bumped
            // residuals onto the spinner/input row). Erase to EOL so we
            // start from a clean line. We deliberately DON'T do this on
            // diff updates: the 80 ms spinner tick would then emit an
            // \x1b[K every frame, which visibly flickers on terminals
            // without full DEC 2026 sync-update support.
            buf += '\x1b[K'
          } else {
            // Diff update — pad with spaces when the old row was wider.
            // Invisible on terminals (no SGR change), so no flicker.
            let oldTailW = 0
            for (let c = diffIdx; c < prevRow.length; c++) oldTailW += prevRow[c].width
            let newTailW = 0
            for (let c = diffIdx; c < nextRow.length; c++) newTailW += nextRow[c].width
            if (oldTailW > newTailW) {
              buf += ' '.repeat(oldTailW - newTailW)
            }
          }
        }
        // else: row identical — skip without moving the cursor.
      } else {
        // Extra old row — absolute-position and blank it out.
        buf += `\x1b[${absRow};1H\x1b[K`
      }
    }

    // No cursor parking. The terminal cursor is hidden for the whole
    // life of the TUI (see the mount useEffect that emits `\x1b[?25l`),
    // so its position is invisible and doesn't matter for display. The
    // visual "input cursor" the user sees is the inverse-video cell on
    // the input row (S_CURSOR), drawn atomically by the cell-diff loop
    // above. Skipping the park removes one cursor-position command per
    // flush — on weak terminals each such command kicks the renderer's
    // state machine even when the cursor itself is hidden, so dropping
    // it visibly reduces residual flicker. cursorAnchor is still
    // computed because lower paths (and future revival of the visible
    // cursor) read it; it's just no longer emitted as a CSI H here.

    // Flush everything as a single write: preBuf (BSU + DECSTBM scrollback
    // insertion + any frame-height-change scrolling) + frame diff + ESU.
    // One write() = one atomic paint on every terminal, not just those
    // with DEC 2026 support. NOTE: we no longer tack on SAVE_CURSOR (\x1b7)
    // at the end. That DEC save register is single-slot AND shared with
    // Ink's log-update internals, so our save was being clobbered on every
    // Ink tree reconcile. Instead we jump absolutely to (frameTop, 1) at
    // the start of every render — no cross-render cursor-state dependency.
    // ESU never carries a visibility command. The cursor is hidden for
    // the entire lifetime of this component (see the mount useEffect
    // above) and the input "cursor" is just an inverse-video cell on
    // the input row, drawn atomically with the rest of the frame. Per-
    // flush `?25h` / `?25l` toggling resets the cursor blink phase on
    // Windows Terminal and VSCode's xterm.js — that is the flicker
    // users were reporting at the rightmost typed column.
    const esu = '\x1b[?2026l'

    // Early-return for no-op flushes. When the spinner ticks but no
    // cell content has changed (preBuf empty after BSU, buf empty),
    // the wrapper alone (`?2026h` + `?2026l`, 16 bytes) is enough to
    // make the terminal re-process the sync window — and on weak
    // terminals this still resets the cursor blink phase, producing
    // the cursor flicker the user was seeing at 12 Hz. Skipping the
    // write entirely is the same trick Claude Code uses
    // (D:\res\claude-code\src\ink\ink.tsx:623, 668-671 — the
    // `hasDiff || targetMoved` early-return).
    if (preBuf === BSU && buf === '') {
      lastFlushTimeRef.current = Date.now()
      // Still need to apply the pending blank-rows update; the
      // shrink path may have computed a new value.
      if (pendingFreeBlanks !== freeBlanksAboveFrameRef.current) {
        debugLog('chatinput.geom.persist-noop', `blanks ${freeBlanksAboveFrameRef.current}->${pendingFreeBlanks}`)
      }
      freeBlanksAboveFrameRef.current = pendingFreeBlanks
      return
    }

    const payload = preBuf + buf + esu
    debugLog(
      'chatinput.flush',
      `bytes=${payload.length} preBufBytes=${preBuf.length} bufBytes=${buf.length} msgsCommitted=${writtenMessageCountRef.current} pendingBlanks=${pendingFreeBlanks} frameTop=${frameTop} nextH=${nextH}`,
    )
    debugLog('chatinput.flush.payload', JSON.stringify(payload))

    // ── Anti-flicker write scheduling ──────────────────────────────────
    //
    // Fast tools (listDir, glob, readFile) complete in <5ms. React renders
    // frames back-to-back:
    //   Frame A (non-commit): shows "⠼ Running…" for the tool
    //   Frame B (commit, ~2ms later): replaces it with the result summary
    // Both are large redraws (~600-700 bytes). Painting both within one
    // vsync window (16ms) causes visible flicker/jitter.
    //
    // Strategy:
    //   • Commit frames (carrying new scrollback) write IMMEDIATELY — they
    //     cancel any pending deferred write since commits involve complex
    //     scroll/frame state that must be written atomically.
    //   • Non-commit frames are DEFERRED. Two windows:
    //       — Spinner ticks (spinnerFrame changed since last flush): 24ms.
    //         A wider window so a useStreamBuffer 150ms-drain commit
    //         landing 1-20ms after the spinner tick supersedes the
    //         spinner-only write instead of producing a back-to-back
    //         spinner-cell + commit pair (the visible "tick + content
    //         scroll-in" flicker observed during long streaming
    //         responses).
    //       — Everything else (typing, content changes that didn't tick
    //         the spinner): 8ms. Held-down letter keys produce one
    //         non-commit render per keystroke; a wider window here
    //         visibly stutters under continuous typing because each
    //         keystroke's deferred-fire happens on the wider cadence
    //         instead of feeling immediate.
    //     If a commit arrives during the deferred window, the deferred
    //     frame is discarded and only the commit is painted.
    //   • Additionally, non-commit frames within 16ms of the last write
    //     are dropped entirely (spinner coalescing).

    const doFlush = () => {
      const ok = process.stdout.write(payload)
      if (!ok) debugLog('chatinput.flush.backpressure', 'process.stdout.write returned false')
      lastFlushTimeRef.current = Date.now()
      lastFlushedSpinnerFrameRef.current = spinner != null ? spinnerFrame : null
      prevFrameRef.current = frame
      lastFrameHRef.current = nextH
      lastFrameTopRef.current = frameTop
      if (pendingFreeBlanks !== freeBlanksAboveFrameRef.current) {
        debugLog(
          'chatinput.geom.persist',
          `blanks ${freeBlanksAboveFrameRef.current}->${pendingFreeBlanks} ` + `frameTop=${frameTop} nextH=${nextH}`,
        )
      }
      freeBlanksAboveFrameRef.current = pendingFreeBlanks
      // Bump the generation. Any pending deferred-flush macrotask whose
      // captured flushId now differs from this value will short-circuit
      // when it runs — see the schedule path below.
      flushGenRef.current++
    }

    if (didCommitMessages) {
      if (deferredFlushRef.current !== null) {
        clearTimeout(deferredFlushRef.current)
        deferredFlushRef.current = null
        debugLog('chatinput.flush.deferred-cancelled', 'commit superseded deferred frame')
      }
      // Newer commit's payload (incl. fresher scrollback + spinner glyph)
      // supersedes any previously throttled commit.
      if (commitThrottleRef.current !== null) {
        clearTimeout(commitThrottleRef.current)
        commitThrottleRef.current = null
        debugLog('chatinput.flush.commit-throttle-superseded', 'newer commit replaces throttled')
      }
      const dt = Date.now() - lastFlushTimeRef.current
      // Minimum gap between consecutive stdout writes. Two writes inside
      // the same terminal paint window (~16ms vsync) appear as flicker
      // even when each is wrapped in BSU/ESU — DEC 2026 sync is per-write
      // atomic but doesn't span writes. Most common cause: a 160ms spinner
      // deferred-fire (T) followed by a useStreamBuffer drain commit
      // (T+10–50ms). Throttling the commit to land ≥50ms after the last
      // write puts it in a fresh paint cycle. 50ms = ~3 vsyncs, enough
      // headroom on terminals that buffer multiple frames.
      const MIN_COMMIT_GAP_MS = 50
      if (lastFlushTimeRef.current > 0 && dt < MIN_COMMIT_GAP_MS) {
        const delay = MIN_COMMIT_GAP_MS - dt
        const capturedGen = flushGenRef.current
        commitThrottleRef.current = setTimeout(() => {
          commitThrottleRef.current = null
          if (flushGenRef.current !== capturedGen) {
            debugLog(
              'chatinput.flush.commit-throttled-stale',
              `gen ${capturedGen}->${flushGenRef.current}, skipping stale flush`,
            )
            return
          }
          doFlush()
          debugLog('chatinput.flush.commit-throttled-fired', `delay=${delay}ms`)
        }, delay)
        debugLog('chatinput.flush.commit-throttled', `delay=${delay}ms dt=${dt}ms`)
      } else {
        doFlush()
      }
    } else {
      // A throttled commit is in flight. If this non-commit frame has a
      // DIFFERENT height (dialog opening/closing, error row, etc.) it
      // supersedes the throttled commit — cancel the stale throttle and
      // let this frame through immediately. Height-preserving frames
      // (spinner ticks) can safely wait.
      if (commitThrottleRef.current !== null) {
        const heightChanged = nextH !== lastFrameHRef.current
        if (!heightChanged) {
          debugLog('chatinput.flush.deferred-skipped', 'commit throttle pending')
          return
        }
        clearTimeout(commitThrottleRef.current)
        commitThrottleRef.current = null
        debugLog(
          'chatinput.flush.commit-throttle-superseded-by-height',
          `nextH=${nextH} lastH=${lastFrameHRef.current}`,
        )
      }
      const now = Date.now()
      // Only coalesce identical-height frames (spinner ticks, single-cell
      // input edits). A frame-height change signals a structural update —
      // dialog opening/closing, error row appearing, etc. — and must paint
      // even when it lands within 16ms of the previous write. Coalescing
      // a height-changing frame used to strand the UI on the old frame
      // when the event that triggered it (e.g. stream end → permission
      // prompt render) also happened to be the last thing that would ever
      // re-render: the spinner interval clears on `spinner === null`, no
      // further React ticks arrive, and the dropped payload carrying the
      // prompt is never retried. Symptom: tool-call row stuck showing
      // "⠴ Running... (↓ N tokens)" forever with frozen input.
      const isSpinnerTick = nextH === lastFrameHRef.current
      // True when this render's only meaningful change is the spinner
      // glyph cycling — content/text/dialogs are unchanged. We can be
      // far more aggressive about dropping these because the next commit
      // will repaint the entire frame anyway, picking up the latest
      // spinner glyph as part of the full redraw.
      const spinnerTicked = spinner != null && spinnerFrame !== lastFlushedSpinnerFrameRef.current
      // Coalesce. Only drop back-to-back same-height frames within a
      // single terminal refresh window (16ms) — anything wider gets
      // through. The job of preventing spinner-vs-commit flicker is
      // handed to the deferred-fire mechanism below: a wide spinner
      // deferMs lets in-flight commits clearTimeout the deferred,
      // turning would-be near-collisions into single commit-only
      // writes. We deliberately do NOT coalesce against commit time
      // here — that approach (drop spinner-only frames during
      // streaming) tied the spinner glyph to commit cadence, which is
      // visibly jittery at the variable 50-300ms gaps that
      // useStreamBuffer's COMMIT_BATCH_MS produces.
      const coalesceWindow = 16
      const dt = now - lastFlushTimeRef.current
      if (isSpinnerTick && dt < coalesceWindow) {
        debugLog('chatinput.flush.coalesced', `dt=${dt}ms spinner=${spinnerTicked ? 1 : 0}`)
        return
      }
      if (deferredFlushRef.current !== null) {
        clearTimeout(deferredFlushRef.current)
      }
      // Spinner ticks defer 160ms. Rationale:
      //   - useStreamBuffer drains 150ms after a chunk queues, then a
      //     React render scheduling adds ~10ms before our commit lands.
      //     A 160ms defer lets that drain-driven commit reliably hit
      //     the clearTimeout above BEFORE our spinner-only write fires,
      //     collapsing the spinner+commit pair into a single commit-only
      //     write (the commit's full-frame redraw repaints the spinner
      //     glyph anyway).
      //   - Previous value was 100ms. Symptom: spinner outer-enter at
      //     queue+42ms → defer fires at queue+142ms; drain commit at
      //     queue+160ms — spinner wrote 18ms before commit, two stdout
      //     writes per vsync = visible flicker.
      //   - Must remain strictly less than the 200ms spinner-tick
      //     interval — at ≥200ms a back-to-back tick would re-arm the
      //     timer perpetually and the spinner would freeze.
      // Typing edits keep the original 8ms so held-key echo stays snappy.
      const deferMs = spinnerTicked ? 160 : 8
      // Capture flush generation at SCHEDULE time. If a commit-path
      // doFlush() runs before our timer fires, flushGenRef advances and
      // our deferred frame becomes stale (its cells were built from a
      // pre-commit React state). setImmediate yields one Node tick so
      // any React commit queued in the same macrotask flushes first;
      // the staleness check then short-circuits us.
      const flushId = flushGenRef.current
      deferredFlushRef.current = setTimeout(() => {
        deferredFlushRef.current = null
        setImmediate(() => {
          if (flushId !== flushGenRef.current) {
            debugLog('chatinput.flush.deferred-stale', `flushId=${flushId} gen=${flushGenRef.current}`)
            return
          }
          doFlush()
          debugLog('chatinput.flush.deferred-fired', `delayed=${deferMs}ms`)
        })
      }, deferMs)
      debugLog('chatinput.flush.deferred', `non-commit frame deferred ${deferMs}ms`)
    }
  })

  // Unmount cleanup
  useEffect(() => {
    return () => {
      if (deferredFlushRef.current !== null) {
        clearTimeout(deferredFlushRef.current)
        deferredFlushRef.current = null
      }
      if (commitThrottleRef.current !== null) {
        clearTimeout(commitThrottleRef.current)
        commitThrottleRef.current = null
      }
      if (activeRef.current) {
        eraseRegion()
        activeRef.current = false
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ChatInput renders nothing through Ink — the full bottom region is
  // owned by direct stdout writes inside the useEffect above.
  return null
}
