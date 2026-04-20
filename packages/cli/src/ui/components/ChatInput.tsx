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

import { getPermissionLevel } from '@x-code-cli/core'
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

interface ChatInputProps {
  /** All scrollback messages. New entries are committed to the terminal
   *  scrollback (above our cell frame) via direct stdout writes. We own the
   *  entire bottom region — Ink must NOT also write scrollback, or its
   *  log-update will fight us for cursor position. */
  messages: readonly DisplayMessage[]
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
const S_DIM = '\x1b[2m'
// Reset ALL attributes at row end (\x1b[0m), not just foreground (\x1b[39m).
// Bold cells (e.g. Permission's Yes/No highlight) would otherwise bleed
// their bold attribute into the next row. The cell-diff emitter re-emits
// any non-empty style on the first cell of the next row, so a full reset
// here is safe.
const S_RESET = '\x1b[0m'
const S_INV = '\x1b[7m'
const S_INV_OFF = '\x1b[27m'
const S_NONE = ''

/** DEC save/restore cursor position. We save at the end of every frame
 *  render so that when Ink briefly paints a Permission/SelectOptions
 *  dialog over our region, we can return the terminal cursor to a known
 *  anchor (end of our frame's last row) before running eraseRegion.
 *  Relying on Ink's own cleanup cursor position is unreliable — the
 *  @jrichman/ink fork uses cell-level diffing and the cursor it leaves
 *  after clearing a dialog doesn't always coincide with the start of
 *  that dialog area, so `\x1b[prevH-1 A` can land on the wrong row. */
const SAVE_CURSOR = '\x1b7'
const RESTORE_CURSOR = '\x1b8'

/** DEC 2026 "Synchronized Update Mode". Between BSU and ESU, supported
 *  terminals buffer all output and render it as a single atomic frame.
 *  This eliminates the flash that otherwise occurs between eraseRegion
 *  wiping the frame and the full re-render that follows — the user sees
 *  only the final state, never the intermediate blank region.
 *  Unsupported terminals silently ignore these sequences. */
const BSU = '\x1b[?2026h'
const ESU = '\x1b[?2026l'

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
  onSubmit,
  onInterrupt,
  disabled,
  hidden,
  spinner,
  errorMessage,
  permission,
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

  /** Build the ANSI sequence to erase our region and rewind the cursor
   *  to its top-left. Returned as a string so callers can coalesce it
   *  with other writes into a single process.stdout.write — critical for
   *  flicker-free streaming on terminals without DEC 2026 sync support,
   *  which paint each write() separately. */
  const buildEraseRegion = (): string => {
    const prevH = prevFrameRef.current.length
    prevFrameRef.current = []
    if (prevH > 1) {
      let buf = `\x1b[${prevH - 1}A` // up to first row of region
      for (let i = 0; i < prevH; i++) buf += '\r\x1b[K' + (i < prevH - 1 ? '\x1b[1B' : '')
      buf += `\x1b[${prevH - 1}A` // back up to top
      return buf
    }
    if (prevH === 1) return '\r\x1b[K'
    return ''
  }

  /** Synchronous erase used by non-effect call sites (handleSubmit pre-echo,
   *  unmount cleanup, hidden-dialog transitions). Effect path uses
   *  buildEraseRegion directly and appends to its local buffer instead. */
  const eraseRegion = () => {
    const s = buildEraseRegion()
    if (s) process.stdout.write(s)
  }

  const handleSubmit = () => {
    if (!text.trim()) return
    // Block submit while the agent is still thinking. Keystrokes still flow
    // (the keyboard stays enabled so users can pre-type the next prompt) —
    // only Enter is suppressed, matching Claude Code's behavior.
    if (spinner) return
    const expanded = expandPasteRefs(text, pastedContents)
    // Wipe our stdout footprint BEFORE triggering state changes. That way
    // when MessageList's useEffect fires and writes the user-echo via
    // Ink's coordinated `write`, the terminal cursor is already at the
    // top of an empty region — the echo doesn't overwrite our bottom
    // separator, and our next frame draws fresh below the echo.
    eraseRegion()
    activeRef.current = false
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
      dispatch({ type: 'INSERT', pos: cursorRef.current, chunk })
      setCompletionIndex(0)
    },
    onPaste: (content) => {
      if (permission) return // ignore pastes while Permission is up
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
      if (key === 'return') {
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
      // dialog started (= our frame's bottom row), and at THAT point
      // prevFrameRef + our normal eraseRegion correctly wipes the old
      // frame. So just flag that we were hidden and bail.
      wasHiddenRef.current = true
      return
    }

    // Accumulate ALL writes for this render into a single string, flushed
    // via one process.stdout.write at the bottom. Rationale: DEC 2026
    // Synchronized Update Mode (BSU/ESU) only buffers inter-write state on
    // terminals that support it — VS Code terminal and others paint every
    // separate write() immediately. Coalescing into one write keeps each
    // render a single atomic paint regardless of terminal support, which
    // is what actually eliminates the "Thinking + input box flicker every
    // streaming chunk" symptom.
    let preBuf = BSU

    if (wasHiddenRef.current) {
      // Transitioning out of a dialog. Ink's cell-diff renderer doesn't
      // guarantee where it leaves the terminal cursor after clearing a
      // dialog, so we use the DEC-saved cursor position (captured at
      // the end of our last frame render) as a reliable anchor: jump
      // back to the end of our previous frame, THEN eraseRegion rewinds
      // `prevH-1` rows and erases the exact rows we own.
      wasHiddenRef.current = false
      if (activeRef.current) {
        preBuf += RESTORE_CURSOR + buildEraseRegion()
      }
    }

    // ── Commit new scrollback messages ───────────────────────────────────
    // We own the terminal below the header — messages are NOT written via
    // Ink (MessageList is retired). If new messages arrived since the last
    // render, erase our current cell frame, emit the messages as plain
    // scrollback by appending to preBuf, and then redraw the frame fresh
    // below them. prevFrameRef is cleared so the next cell-diff starts
    // from zero at the new cursor position.
    //
    // A /clear command may shrink messages; detect and reset the counter.
    if (messages.length < writtenMessageCountRef.current) {
      writtenMessageCountRef.current = messages.length
    }
    if (messages.length > writtenMessageCountRef.current) {
      if (activeRef.current) {
        preBuf += buildEraseRegion()
      }
      const collectWrite: (data: string) => void = (data) => {
        preBuf += data
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
      const cells: Cell[] = []
      cells.push({ char: ' ', style: S_NONE, width: 1 })
      cells.push(...textToCells(glyph, S_SPINNER))
      cells.push({ char: ' ', style: S_NONE, width: 1 })
      cells.push(...textToCells(`${spinner.label}...`, S_SPINNER))
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

    // Top separator
    frame.push(textToCells(sepText, S_GRAY))

    // Input lines
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
          cells.push({ char: cursorChar, style: S_INV, width: charWidth(cursorChar) })
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
          cells.push({ char: cursorChar, style: S_INV, width: charWidth(cursorChar) })
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
    const prevFrame = prevFrameRef.current
    const prevH = prevFrame.length
    const nextH = frame.length
    const maxH = Math.max(prevH, nextH)

    let buf = ''

    // After the previous render the cursor sits on the LAST row (prevH-1).
    // Move up to row 0 so we can diff top-down.
    if (prevH > 1) {
      buf += `\x1b[${prevH - 1}A`
    }

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

        if (diffIdx < nextRow.length || nextRow.length < prevRow.length) {
          // Position cursor at diffIdx's visual column
          let col = 0
          for (let c = 0; c < diffIdx; c++) col += nextRow[c].width
          buf += `\x1b[${col + 1}G`

          // Emit changed cells
          let lastStyle = ''
          for (let c = diffIdx; c < nextRow.length; c++) {
            const cell = nextRow[c]
            if (cell.style !== lastStyle) {
              buf += cell.style
              lastStyle = cell.style
            }
            buf += cell.char
            if (cell.style === S_INV) {
              buf += S_INV_OFF
              lastStyle = S_NONE
            }
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

      // Advance to the next row (existing line below → CUD; new line → LF)
      if (row < maxH - 1) {
        if (row < prevH - 1) {
          buf += '\x1b[1B'
        } else {
          buf += '\n'
        }
      }
    }

    // Park the cursor on the last row of the NEW frame.
    if (maxH > nextH) {
      buf += `\x1b[${maxH - nextH}A`
    }

    // Flush everything as a single write: preBuf (BSU + any erase /
    // scrollback commits) + frame diff + SAVE_CURSOR + ESU. One write()
    // = one atomic paint on every terminal, not just those with DEC 2026
    // support — this is what eliminates the streaming flicker.
    process.stdout.write(preBuf + buf + SAVE_CURSOR + ESU)

    prevFrameRef.current = frame
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
