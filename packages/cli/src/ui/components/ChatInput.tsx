// @x-code-cli/cli — Bottom dynamic region (spinner + input box).
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
//   everything below MessageList's scrollback.
//
// THINGS THIS COMPONENT OWNS (instead of Ink):
//     - The loading spinner row (when `isLoading` is true)
//     - Top/bottom separator lines
//     - Input text with cursor
//     - Slash-command completion menu
//
// COORDINATION WITH MessageList's SCROLLBACK WRITES:
//   Before `onSubmit` fires, we synchronously eraseRegion() so that when
//   MessageList's useEffect writes the user-echo via Ink's write(), the
//   terminal cursor is parked at the top-left of a blank region — the
//   echo lands cleanly instead of overwriting our bottom separator.
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'

import { useStdout } from 'ink'

import { debugLog, getPermissionLevel } from '@x-code-cli/core'
import type { DisplayMessage } from '@x-code-cli/core'

import { usePromptInput } from '../hooks/use-prompt-input.js'
import { type PastedContents, expandPasteRefs, formatPasteRef, stripTrailingRef } from '../paste-refs.js'
import { writeMessageToStdout } from '../stdout-writer.js'

const PASTE_REF_MIN_LINES = 3
const PASTE_REF_MIN_CHARS = 400
const MAX_VISIBLE_LINES = 10
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

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
  totalTokens?: number
}

export interface PermissionRequest {
  toolName: string
  input: Record<string, unknown>
  onResolve: (approved: boolean) => void
}

export interface SelectRequest {
  question: string
  options: { label: string; description: string }[]
  onResolve: (answer: string) => void
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
  onInterrupt: () => void
  /** Ignore keyboard input (and hide the input cursor). */
  disabled?: boolean
  /** Fully hide the region (e.g. while a SelectOptions dialog is showing
   *  and Ink still owns the bottom region). */
  hidden?: boolean
  /** If non-null, render a spinner line above the input. */
  spinner?: SpinnerState | null
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

function permissionTitle(toolName: string): string {
  switch (toolName) {
    case 'shell':
      return 'X-Code wants to run a shell command'
    case 'writeFile':
      return 'X-Code wants to write a file'
    case 'edit':
      return 'X-Code wants to edit a file'
    default:
      return `X-Code wants to use ${toolName}`
  }
}

const PERMISSION_LEVEL_STYLE: Record<string, { label: string; style: string }> = {
  'always-allow': { label: 'read-only', style: S_SUCCESS },
  ask: { label: 'write', style: S_WARNING },
  deny: { label: 'dangerous', style: S_ERROR_BOLD },
}

function permissionContentCells(toolName: string, input: Record<string, unknown>): Cell[] | null {
  if (toolName === 'shell') {
    const level = getPermissionLevel('shell', input)
    const info = PERMISSION_LEVEL_STYLE[level] ?? PERMISSION_LEVEL_STYLE.ask
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push(...textToCells('$ ' + String(input.command ?? ''), S_ACCENT))
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push(...textToCells(`[${info.label}]`, info.style))
    return cells
  }
  if (toolName === 'writeFile') {
    const fp = String(input.filePath ?? '')
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push(...textToCells(fp, S_ACCENT))
    cells.push(...textToCells(' (new file)', S_ACCENT_DIM))
    return cells
  }
  if (toolName === 'edit') {
    const fp = String(input.filePath ?? '')
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push(...textToCells(fp, S_ACCENT))
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
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return `${tokens}`
}

// ── Component ───────────────────────────────────────────────────────────

export function ChatInput({
  messages,
  initialContentRows = 0,
  onSubmit,
  onInterrupt,
  disabled,
  hidden,
  spinner,
  errorMessage,
  permission,
  selectRequest,
  commands = [],
}: ChatInputProps) {
  const [{ text, cursor }, dispatch] = useReducer(inputReducer, { text: '', cursor: 0 })
  const cursorRef = useRef(0)
  useLayoutEffect(() => {
    cursorRef.current = cursor
  })
  const [pastedContents, setPastedContents] = useState<PastedContents>({})
  const [completionIndex, setCompletionIndex] = useState(0)
  const nextPasteIdRef = useRef(1)
  const lastEscRef = useRef(0)
  const activeRef = useRef(false)
  const prevFrameRef = useRef<Cell[][]>([])
  /** Timestamp (ms) of the last stdout.write that actually hit the
   *  terminal. Used to coalesce spinner-tick writes that would fire
   *  immediately after a scrollback-commit write — see flush section
   *  for the 16ms-gap rule. */
  const lastFlushTimeRef = useRef(0)
  /** Height of the frame currently sitting at the bottom of the terminal
   *  (the value that prevFrameRef was last set to). Tracked separately
   *  because prevFrameRef gets reset to [] on transitions (post-hidden,
   *  frame-height change) while we still need to know where the PHYSICAL
   *  frame on screen begins so the next DECSTBM scroll region doesn't
   *  overlap it. */
  const lastFrameHRef = useRef(0)
  /** Rows of freshly-erased blank space immediately above the frame —
   *  typically from a shrink that closed a dialog (the erase step wipes
   *  the old picker rows, leaving them blank). The next commit can write
   *  new scrollback content INTO these blanks without needing to
   *  pre-scroll the top of the viewport into real scrollback, which is
   *  what preserves the startup banner across multiple /model cycles. */
  const freeBlanksAboveFrameRef = useRef(0)
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
  const selectKey = selectRequest ? selectRequest.question : null
  if (selectKey !== lastSelectKey) {
    setLastSelectKey(selectKey)
    setSelectIndex(0)
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
    }, 80)
    return () => clearInterval(timer)
  }, [spinner])

  const { stdout } = useStdout()
  const termWidth = stdout?.columns ?? 80

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
    prevFrameRef.current = []
    lastFrameHRef.current = 0
    if (prevH <= 0) return ''
    const termRows = stdout?.rows ?? 25
    const frameTop = Math.max(1, termRows - prevH + 1)
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
    // BSU/ESU-wrapped payload of: eraseRegion + writeMessageToStdout +
    // new frame. An extra synchronous eraseRegion here used to exist
    // "to clear space for MessageList's separate scrollback write", but
    // MessageList has been retired — this component owns both the
    // frame and the scrollback commit, so the redundant write was just
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
          permission.onResolve(true)
          return
        }
        if (ch === 'n') {
          permission.onResolve(false)
          return
        }
        return
      }
      if (selectRequest) return // block typing while select dialog is up
      dispatch({ type: 'INSERT', pos: cursorRef.current, chunk })
      setCompletionIndex(0)
    },
    onPaste: (content) => {
      if (permission || selectRequest) return // ignore pastes while a dialog is up
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
        if (key === 'up' || key === 'down') {
          setPermissionSelected((p) => (p === 0 ? 1 : 0))
          return
        }
        if (key === 'return') {
          permission.onResolve(permissionSelected === 0)
          return
        }
        return
      }
      // Select-options dialog captures the same keys.
      if (selectRequest) {
        const len = selectRequest.options.length
        if (key === 'up') {
          setSelectIndex((i) => (i > 0 ? i - 1 : len - 1))
          return
        }
        if (key === 'down') {
          setSelectIndex((i) => (i < len - 1 ? i + 1 : 0))
          return
        }
        if (key === 'return') {
          const picked = selectRequest.options[selectIndex]
          if (picked) selectRequest.onResolve(picked.label)
          return
        }
        return
      }
      if (key === 'return') {
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
        const now = Date.now()
        if (now - lastEscRef.current < 500 && text.length > 0) {
          dispatch({ type: 'RESET' })
          setPastedContents({})
          setCompletionIndex(0)
        }
        lastEscRef.current = now
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
        if (currentMatch) {
          dispatch({ type: 'SET_TEXT', text: currentMatch.name, cursor: currentMatch.name.length })
          setCompletionIndex(0)
        }
        return
      }
      if (key === 'up') {
        if (matches.length > 0) setCompletionIndex((p) => (p - 1 + matches.length) % matches.length)
        else moveCursorVertically(-1)
        return
      }
      if (key === 'down') {
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

    activeRef.current = true

    const PROMPT_WIDTH = 2
    const vpWidth = Math.max(20, termWidth - PROMPT_WIDTH - 1)
    const sepChar = '\u2500'
    const sepText = sepChar.repeat(Math.max(0, termWidth - 1))

    // ── Input display lines (with viewport windowing) ──
    const rawLines = text.length === 0 ? [''] : text.split('\n')

    let rawCursorLine = 0,
      cursorCol = cursor
    {
      let charsSoFar = 0
      for (let i = 0; i < rawLines.length; i++) {
        if (cursor >= charsSoFar && cursor <= charsSoFar + rawLines[i].length) {
          rawCursorLine = i
          cursorCol = cursor - charsSoFar
          break
        }
        charsSoFar += rawLines[i].length + 1
      }
    }

    let displayLines: string[]
    let cursorLine: number
    if (rawLines.length <= MAX_VISIBLE_LINES) {
      displayLines = rawLines
      cursorLine = rawCursorLine
    } else {
      let start = rawCursorLine - Math.floor(MAX_VISIBLE_LINES / 2)
      start = Math.max(0, Math.min(start, rawLines.length - MAX_VISIBLE_LINES))
      displayLines = rawLines.slice(start, start + MAX_VISIBLE_LINES)
      cursorLine = rawCursorLine - start
      if (start > 0) {
        displayLines[0] = `\u2026 (+${start} above)`
        if (cursorLine === 0) cursorLine = -1
      }
      if (start + MAX_VISIBLE_LINES < rawLines.length) {
        displayLines[displayLines.length - 1] = `\u2026 (+${rawLines.length - start - MAX_VISIBLE_LINES} below)`
        if (cursorLine === displayLines.length - 1) cursorLine = -1
      }
    }

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

    // Spinner / "Thinking..." line. Pinned just above the input box
    // (below any permission dialog) so it always sits at the very bottom
    // of the dynamic area — matches Claude Code's layout.
    if (spinner) {
      const glyph = SPINNER_FRAMES[spinnerFrame]
      const arrow = spinner.mode === 'requesting' ? '↑' : '↓'
      // Derive elapsed time at render time so we don't need a setState in
      // the spinner effect. The setSpinnerFrame tick is what drives the
      // ~80ms re-render that recomputes this value.
      const elapsedMs = loadingStartRef.current === 0 ? 0 : Date.now() - loadingStartRef.current
      const parts: string[] = []
      if (elapsedMs >= 2000) parts.push(formatElapsed(elapsedMs))
      if (spinner.totalTokens != null && spinner.totalTokens > 0) {
        parts.push(`${arrow} ${formatTokens(spinner.totalTokens)} tokens`)
      }
      const meta = parts.length > 0 ? ` (${parts.join(' · ')})` : ''

      // Top margin ONLY when the permission dialog sits immediately above
      // the spinner (they'd otherwise touch without breathing room).
      // When Thinking sits directly below scrollback content, the last
      // message already ends with `\n\n` → one blank row is ALREADY
      // there, and adding another would make the gap look too large.
      if (permission) frame.push([])
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

      const contentCells = permissionContentCells(permission.toolName, permission.input)
      if (contentCells) frame.push(contentCells)

      const yesCells: Cell[] = []
      if (permissionSelected === 0) {
        yesCells.push(...textToCells('    ', S_NONE))
        yesCells.push(...textToCells('\u276f Yes', S_SUCCESS))
      } else {
        yesCells.push(...textToCells('      ', S_NONE))
        yesCells.push(...textToCells('Yes', S_ACCENT_DIM))
      }
      frame.push(yesCells)

      const noCells: Cell[] = []
      if (permissionSelected === 1) {
        noCells.push(...textToCells('    ', S_NONE))
        noCells.push(...textToCells('\u276f No', S_ERROR_BOLD))
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
      const qLines = selectRequest.question.split('\n')
      for (const q of qLines) {
        const cells: Cell[] = []
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push(...textToCells(`? ${q}`, S_ACCENT_BOLD))
        frame.push(cells)
      }
      selectRequest.options.forEach((opt, i) => {
        const active = i === selectIndex
        const cells: Cell[] = []
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push(...textToCells(active ? '\u276f ' : '  ', active ? S_ACCENT : S_NONE))
        cells.push(...textToCells(opt.label, active ? S_ACCENT : S_NONE))
        if (opt.description) {
          cells.push(...textToCells(`  \u2014 ${opt.description}`, S_DIM))
        }
        frame.push(cells)
      })
      const hint: Cell[] = []
      hint.push({ char: ' ', style: S_NONE, width: 1 })
      hint.push(...textToCells('\u2191\u2193 Navigate  Enter Confirm', S_DIM))
      frame.push(hint)
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
          cells.push({ char: cursorChar, style: S_RESET, width: charWidth(cursorChar) })
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
          cells.push({ char: cursorChar, style: S_RESET, width: charWidth(cursorChar) })
          cells.push(...textToCells(va, S_RESET))
        }
      }
      frame.push(cells)
    }

    // Bottom separator
    frame.push(textToCells(sepText, S_GRAY))

    // Completion menu
    if (matches.length > 0) {
      const maxNameLen = matches.reduce((max, cmd) => Math.max(max, cmd.name.length), 0)
      for (let i = 0; i < matches.length; i++) {
        const cmd = matches[i]
        const sel = i === safeIndex
        const cells: Cell[] = []
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        const nameStr = cmd.name.padEnd(maxNameLen + 2)
        if (sel) {
          cells.push(...textToCells(nameStr, S_ACCENT_BOLD))
          cells.push(...textToCells(cmd.description, S_RESET))
        } else {
          cells.push(...textToCells(nameStr + cmd.description, S_DIM))
        }
        frame.push(cells)
      }
    }

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
    const frameTop = Math.max(1, termRows - nextH + 1)

    // First render: seed the "blanks above frame" tracker. The banner
    // (initialContentRows) occupies the top of the viewport; everything
    // else up to where the frame sits is blank. Subsequent grows can
    // consume those blanks without pre-scrolling, so the banner stays
    // in view during normal operation.
    if (!activeRef.current && initialContentRows > 0) {
      freeBlanksAboveFrameRef.current = Math.max(0, termRows - initialContentRows - nextH)
    }

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
    const scrollRows = didCommitMessages ? countContentRows(scrollbackContent, termWidth) : 0
    let handledCommitWithFrame = false
    if (didCommitMessages && scrollRows > 0 && nextH > 0 && nextH < termRows) {
      const startRow = Math.max(1, termRows - scrollRows - nextH + 1)
      // Normal formula: make room by scrolling top rows into real scrollback.
      // But subtract any freshly-erased blank rows left above the frame by a
      // recent shrink (dialog close) — those can absorb the new content
      // without us having to sacrifice anything from the top of the viewport.
      const rawPreScroll = oldFrameH > 0 ? Math.max(0, scrollRows + nextH - oldFrameH) : 0
      const absorbed = Math.min(rawPreScroll, freeBlanksAboveFrameRef.current)
      const preScrollRows = rawPreScroll - absorbed
      // After this commit, the newly-written scrollback content sits
      // IMMEDIATELY above the frame. Any blank rows that were previously
      // counted are now ABOVE the new content, not adjacent to the frame —
      // so they can no longer absorb a future grow's expansion. Reset to
      // 0 so the next grow correctly pre-scrolls to preserve content
      // (instead of erasing rows that contain the scrollback we just
      // committed, as happened with /init's bottom rows on subsequent
      // /model typing).
      freeBlanksAboveFrameRef.current = 0
      // When the old frame was taller than the new frame, its top is
      // ABOVE our normal startRow, so the rows from old-frame-top down
      // to startRow would otherwise hold stale frame text. Erase from
      // the higher point.
      const oldFrameTop = oldFrameH > 0 ? termRows - oldFrameH + 1 : termRows + 1
      const eraseFrom = Math.min(startRow, oldFrameTop)
      preBuf += '\x1b[?25l'
      if (preScrollRows > 0) {
        // Full-screen scroll at termRows to push `preScrollRows` rows into
        // the terminal's real scrollback (the only mechanism xterm.js
        // honors — DECSTBM regions splice-discard in its InputHandler).
        preBuf += `\x1b[${termRows};1H` + '\n'.repeat(preScrollRows)
      }
      preBuf += `\x1b[${eraseFrom};1H\x1b[J`
      if (eraseFrom < startRow) {
        preBuf += `\x1b[${startRow};1H`
      }
      preBuf += scrollbackContent
      for (let i = 0; i < nextH; i++) {
        preBuf += renderRowToAnsi(frame[i]) + '\x1b[K'
        if (i < nextH - 1) preBuf += '\r\n'
      }
      prevFrameRef.current = frame
      handledCommitWithFrame = true
    } else if (didCommitMessages) {
      // scrollRows == 0 (empty commit) or degenerate dimensions: dump at
      // current cursor, let frame redraw below clean up.
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
        // Consume as much freshly-blank space above the frame as we can —
        // those rows can be overwritten without losing anything. Any excess
        // expansion IS over real content, so pre-scroll that much into
        // real scrollback to preserve it (banner, earlier messages).
        // Without this, typing `/` to open the completion menu would wipe
        // whatever scrollback sat right above the input (see the /usage
        // result disappearing when /mo was typed).
        const absorbed = Math.min(deltaH, freeBlanksAboveFrameRef.current)
        const needsScroll = deltaH - absorbed
        if (needsScroll > 0) {
          preBuf += `\x1b[${termRows};1H` + '\n'.repeat(needsScroll)
        }
        // Pre-erase the newly-occupied rows so any stale cells (from prior
        // renders or auto-scroll residue) don't bleed through before the
        // diff below repaints them.
        for (let i = 0; i < deltaH; i++) {
          const row = termRows - nextH + 1 + i
          preBuf += `\x1b[${row};1H\x1b[K`
        }
        freeBlanksAboveFrameRef.current = Math.max(
          0,
          freeBlanksAboveFrameRef.current - deltaH,
        )
      } else {
        const deltaH = oldFrameH - nextH
        for (let i = 0; i < deltaH; i++) {
          const row = termRows - oldFrameH + 1 + i
          preBuf += `\x1b[${row};1H\x1b[K`
        }
        // Remember the freshly-erased rows so the next commit can write
        // into them instead of pre-scrolling the viewport (which would
        // push the banner / earlier content off the top).
        freeBlanksAboveFrameRef.current += deltaH
      }
      // Frame moved — prev cell matrix is at the wrong rows now; force
      // full redraw at the new position.
      prevFrameRef.current = []
    }

    const prevFrame = prevFrameRef.current
    const prevH = prevFrame.length
    const maxH = Math.max(prevH, nextH)

    // Jump absolutely to the frame's top-left. Works regardless of where
    // the DECSTBM path or the height-change path left the cursor.
    buf += `\x1b[${frameTop};1H`

    for (let row = 0; row < maxH; row++) {
      const prevRow = row < prevH ? prevFrame[row] : []
      const nextRow = row < nextH ? frame[row] : []

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

        if (diffIdx < nextRow.length || nextRow.length < prevRow.length) {
          // Position cursor at diffIdx's visual column
          let col = 0
          for (let c = 0; c < diffIdx; c++) col += nextRow[c].width
          buf += `\x1b[${col + 1}G`

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
        // else: row identical — skip
      } else {
        // Extra old row — blank it out
        buf += '\r\x1b[K'
      }

      // Advance to the next row. Always use CUD+\r (down + col 1) —
      // never \n, which at row=termRows would cause the terminal to
      // scroll our frame off the viewport by one row. Rows always exist
      // because the frame is pinned to [frameTop..termRows] and those
      // rows have already been allocated (either by the frame-height
      // growth scroll above, or by being the same rows the previous
      // frame occupied).
      if (row < maxH - 1) {
        buf += '\x1b[1B\r'
      }
    }

    // Park the real cursor at the input cursor's column. ESU_SHOW below
    // then makes it visible there; the user's terminal draws it in
    // whatever shape they configured (block / bar / underline) — that
    // is the only cursor on screen.
    if (cursorAnchor) {
      const anchorRow = frameTop + cursorAnchor.row
      buf += `\x1b[${anchorRow};${cursorAnchor.col}H`
    }

    // Flush everything as a single write: preBuf (BSU + DECSTBM scrollback
    // insertion + any frame-height-change scrolling) + frame diff + ESU.
    // One write() = one atomic paint on every terminal, not just those
    // with DEC 2026 support. NOTE: we no longer tack on SAVE_CURSOR (\x1b7)
    // at the end. That DEC save register is single-slot AND shared with
    // Ink's log-update internals, so our save was being clobbered on every
    // Ink tree reconcile. Instead we jump absolutely to (frameTop, 1) at
    // the start of every render — no cross-render cursor-state dependency.
    const esu = cursorAnchor ? ESU_SHOW : ESU_HIDE
    const payload = preBuf + buf + esu
    debugLog(
      'chatinput.flush',
      `bytes=${payload.length} preBufBytes=${preBuf.length} bufBytes=${buf.length} msgsCommitted=${writtenMessageCountRef.current}`,
    )
    debugLog('chatinput.flush.payload', JSON.stringify(payload))

    // Coalesce rapid follow-up frames. Spinner ticks (80ms cadence) and
    // streaming-chunk commits (~100ms debounce) drift into near-collision
    // every few seconds: commit completes, spinner tick fires 1-20ms later
    // and emits a second DEC 2026 sync envelope. Some hosts (VSCode
    // xterm.js, Windows Terminal over ConHost) paint the two envelopes
    // across two animation frames which users perceive as "上下抖动".
    //
    // Rule: if this render is NOT carrying a commit or a frame-height
    // change (preBuf is just the bare BSU), AND the terminal received a
    // write less than 16ms ago, drop it. The next natural
    // spinner tick (~80ms later) will paint the up-to-date frame —
    // spinner animation loses at most one frame, invisible in practice.
    // Keep prevFrameRef / lastFrameHRef on their previous values so the
    // next diff runs against the state the terminal actually has.
    const now = Date.now()
    const isBareTick = !didCommitMessages && preBuf.length === BSU.length
    if (isBareTick && now - lastFlushTimeRef.current < 16) {
      debugLog('chatinput.flush.coalesced', `dt=${now - lastFlushTimeRef.current}ms`)
      return
    }

    const ok = process.stdout.write(payload)
    if (!ok) debugLog('chatinput.flush.backpressure', 'process.stdout.write returned false')
    lastFlushTimeRef.current = now

    prevFrameRef.current = frame
    lastFrameHRef.current = nextH
  })

  // Unmount cleanup
  useEffect(() => {
    return () => {
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
