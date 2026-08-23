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

import { debugLog, suggestRuleLabel } from '@x-code-cli/core'

import { isSlashCommandAllowedWhileBusy } from '../busy-command.js'
import { renderInlineMarkdown } from '../render/render-markdown.js'
import { highlightShellCommand } from '../render/shiki-highlight.js'
import {
  flushPendingReadGroup,
  lastWriteEndedWithBlankRow,
  resetScrollbackSpacing,
  writeMessageToStdout,
} from '../render/stdout-writer.js'
import {
  GLYPH_ELLIPSIS,
  GLYPH_PROMPT_ARROW,
  GLYPH_RESULT_BRACKET,
  GLYPH_SELECT_POINTER,
  GLYPH_TODO_BRACKET,
  GLYPH_TODO_CHECK,
  GLYPH_TODO_IN_PROGRESS,
  GLYPH_TODO_PENDING,
  GLYPH_TOOL_BULLET,
  SPINNER_FRAMES,
} from '../render/terminal-glyphs.js'
import {
  charWidth,
  graphemeAt,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
  sliceByWidth,
  visualWidth,
} from '../render/text-width.js'
import {
  formatTokenCount,
  getToolInputPreview,
  getToolLabel,
  isCollapsibleReadOnlyTool,
  isShellToolName,
} from '../utils.js'
import { authorityViewerLines, authorityVisibleText } from './authority-display.js'
import { type Cell, ansiTextToCells, cellsEqual, renderRowToAnsi, textToCells } from './cells.js'
import { type FileEntry, applyCompletion, detectAtToken, scoreAndRank, useFileCompletion } from './file-completion.js'
import { buildVisualLines, computePostContentScrollRows, locateVisualCursor, moveCursorVisual } from './geometry.js'
import { useInputHistory } from './input-history.js'
import {
  BSU,
  ESU_HIDE,
  S_BOLD,
  S_BORDER,
  S_CURSOR,
  S_DIM,
  S_ERROR,
  S_ERROR_BOLD,
  S_GRAY_90,
  S_MODEL,
  S_NONE,
  S_PRIMARY,
  S_PRIMARY_BOLD,
  S_RESET,
  S_SPINNER,
  S_SUCCESS,
  S_SUCCESS_DOT,
  S_SUCCESS_DOT_DIM,
  S_TEXT_STRONG,
  S_TEXT_STRONG_BOLD,
  S_USAGE,
  S_WARNING,
  S_WARNING_BOLD,
} from './palette.js'
import { type PastedContents, expandPasteRefs, formatPasteRef, stripTrailingRef } from './paste-refs.js'
import { formatElapsed, permissionContentCells, permissionTitle } from './permission.js'
import { inputReducer } from './reducer.js'
import {
  countContentRows,
  countSpillRiskRows,
  skipByWidth,
  truncateCellRow,
  truncatePathFromStart,
  wrapCellsToRows,
} from './text-helpers.js'
import type { ChatInputProps, MenuItem } from './types.js'
import { usePromptInput } from './use-prompt-input.js'

const PASTE_REF_MIN_LINES = 3
const PASTE_REF_MIN_CHARS = 400
const MAX_VISIBLE_LINES = 10
// Shared by the render effect (frame layout) and Up/Down cursor movement
// so both compute the soft-wrap viewport width identically.
const PROMPT_WIDTH = 2
// The rounded prompt box wraps each input row in `│ ` … ` │`, consuming 4
// cells around the prompt+content run inside the `termWidth - 1` box.
const BOX_INNER_PAD = 4
const inputViewportWidth = (termWidth: number): number => Math.max(20, termWidth - PROMPT_WIDTH - BOX_INNER_PAD - 1)
const MAX_AT_RESULTS = 50
const MAX_VISIBLE_MENU_ITEMS = 8

export function ChatInput({
  messages,
  initialContentRows = 0,
  onSubmit,
  onInterrupt,
  onEscapeCancel,
  isLoading = false,
  notice,
  peerInfluenced = false,
  trustMode = false,
  pendingPeerCount = 0,
  disabled,
  hidden,
  spinner,
  activeTurnOwner = null,
  hasStableForkBoundary = false,
  activeToolCalls,
  shellWaitStreak,
  backgroundTerminalCount = 0,
  backgroundTerminalWarningCount = 0,
  todos,
  queuedMessages,
  onPopQueued,
  draftRestore,
  errorMessage,
  permission,
  authorityRequest,
  selectRequest,
  commands = [],
  permissionMode = 'default',
  contextUsage,
  modelLabel,
}: ChatInputProps) {
  const [{ text, cursor }, dispatch] = useReducer(inputReducer, { text: '', cursor: 0 })
  const textRef = useRef('')
  const cursorRef = useRef(0)
  // Double-tap Esc to clear the input (idle mode only; loading mode uses
  // single Esc to cancel the in-flight turn). Timestamp of the last Esc
  // that didn't already clear; second press within DOUBLE_ESC_WINDOW_MS
  // triggers RESET.
  const lastEscapeAtRef = useRef(0)
  useLayoutEffect(() => {
    textRef.current = text
    cursorRef.current = cursor
  }, [cursor, text])

  // Insert text at the cursor, mirroring the transition into
  // textRef/cursorRef synchronously. Those refs are otherwise refreshed
  // only by the layout effect AFTER React commits, so a burst of inserts
  // within one commit window (a paste split into rapid onPaste/onText
  // calls on non-bracketed Windows terminals) would all read the stale
  // cursor and splice later chunks in at position 0 — scrambling order.
  const insertAtCursor = (chunk: string): void => {
    const pos = cursorRef.current
    dispatch({ type: 'INSERT', pos, chunk })
    textRef.current = textRef.current.slice(0, pos) + chunk + textRef.current.slice(pos)
    cursorRef.current = pos + chunk.length
  }
  const [pastedContents, setPastedContents] = useState<PastedContents>({})
  // One-shot draft restore (Esc abort with un-injected queued messages).
  // Keyed on `nonce` so consecutive restores with identical text still
  // apply; identity changes from unrelated re-renders don't re-trigger.
  // NOTE: deliberately does NOT touch the history-nav refs — capturing
  // them in an effect trips react-hooks/immutability on their (pre-
  // existing) mutations elsewhere, and a mid-nav restore is a harmless
  // edge case.
  const lastDraftNonceRef = useRef(0)
  useEffect(() => {
    if (!draftRestore || draftRestore.nonce === lastDraftNonceRef.current) return
    lastDraftNonceRef.current = draftRestore.nonce
    dispatch({ type: 'SET_TEXT', text: draftRestore.text, cursor: draftRestore.text.length })
    // eslint-disable-next-line react-hooks/set-state-in-effect -- same one-shot restore; clears paste refs alongside the text.
    setPastedContents({})
  }, [draftRestore])
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
  /** setImmediate queued by a fired deferred timer. The timer ref is already
   *  null at that point, so this handle is required to cancel the final
   *  callback during superseding renders and unmount. */
  const deferredImmediateRef = useRef<ReturnType<typeof setImmediate> | null>(null)
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
  /** Printable length of each row of the frame that was on screen when a
   *  resize arrived, captured in onResize BEFORE prevFrameRef is cleared.
   *  The render effect's width-change branch uses these to compute the
   *  EXACT number of terminal rows the old frame occupies after xterm.js
   *  reflow (each hard line of length L becomes ceil(L/newW) rows), so the
   *  erase covers every reflowed remnant — the old heuristic only counted
   *  the 2 separator rows and missed wrapped input/spinner rows. */
  const prevFrameRowLensRef = useRef<number[]>([])
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
  /** Number of blank rows currently sitting DIRECTLY ABOVE the frame, left
   *  there by a large-shrink (deltaH > 3) that snapped the frame to the
   *  bottom and erased the old frame area without committing it to
   *  scrollback. Without this counter, a subsequent grow would emit LFs
   *  at termRows to "make room" — pushing those blank rows into terminal
   *  scrollback as permanent empty lines (visible as the big blank gap
   *  under a Task() result when sub-agents open multiple permission
   *  dialogs in a row).
   *
   *  Consumed by the grow path before deciding how many LFs to emit:
   *  the frame extends UP into these blanks via cell-grid repositioning
   *  (no scroll), so only the rows BEYOND the blank zone need to be
   *  scrolled into history. Reset on commit (committed scrollback now
   *  occupies the rows directly above the frame), resize, and /clear. */
  const blankRowsAboveFrameRef = useRef(0)
  /** Last actual frameTop row written to the terminal. Stored separately
   *  because frameTop is no longer derivable from (termRows, frameH)
   *  alone — it now also depends on freeBlanksAboveFrameRef. Read by
   *  unmount cleanup (buildEraseRegion) and the resize handler so they
   *  can erase the OLD on-screen frame at its actual position rather
   *  than guessing it from termRows. */
  const lastFrameTopRef = useRef(0)
  /** Reserves vertical space inside the tool-running frame when a permission
   *  dialog just closed but its approved tool hasn't committed a result yet.
   *  Without the reservation the frame snaps 14→5 rows (permission was 11
   *  rows + 3 input, tool rows are 2) and the now-empty top rows of the old
   *  permission region flash as blank lines between the last committed scrollback entry
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
  /** Set by the shrink-detection path (a /clear emptied messages) so the
   *  next first-paint seeds freeBlanks for an empty viewport instead of
   *  reserving banner-sized space at the top — there is no banner left
   *  on screen after the clear-screen ANSI write. Cleared once consumed. */
  const justClearedRef = useRef(false)
  /** How many messages we've already committed to scrollback. */
  const writtenMessageCountRef = useRef(0)
  /** Scrollback bytes collected this render that haven't reached stdout yet.
   *  Survives across renders so a cancelled commit-throttle doesn't drop
   *  message bytes — `writtenMessageCountRef` is bumped synchronously when
   *  we walk new messages, so a follow-up render won't re-collect them via
   *  `writeMessageToStdout`. Without this ref, the only path that carried
   *  the bytes was the local `scrollbackContent` of the render that
   *  scheduled the throttle; if that throttle got superseded by a height
   *  change 1ms later (`commit-throttle-superseded-by-height`), the bytes
   *  vanished. Cleared inside `doFlush` once the write actually lands.
   *  Symptom this cures: streamed multi-line replies whose final commit
   *  shrinks the frame (end-of-turn spinner removal) silently lose the
   *  last message — visible as a reply that stops mid-paragraph in the
   *  scrollback even though the full text is in `state.messages`. */
  const pendingScrollbackRef = useRef('')
  // Permission dialog: selection index (0 = Yes, 1 = No). Rendered inside
  // our cell buffer — not via Ink — so the dialog never fights our
  // cursor management. Reset to 0 whenever the prompt changes (new tool
  // call) using React's "adjust state during render" pattern — React
  // throws away the first render and immediately re-renders, which is
  // cheaper than a cascading setState-inside-effect and doesn't trip the
  // react-hooks/set-state-in-effect lint.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [permissionSelected, setPermissionSelected] = useState(0)
  /** Non-null while the "No, and tell X-Code what to do instead" row is
   *  in inline-edit mode (kimi-cli's reject-with-feedback): typed text
   *  lands here instead of resolving the dialog. */
  const [permissionFeedback, setPermissionFeedback] = useState<{ text: string; cursor: number } | null>(null)
  const [authoritySelected, setAuthoritySelected] = useState(1)
  const [authorityViewedComplete, setAuthorityViewedComplete] = useState(false)
  const [authorityPage, setAuthorityPage] = useState(0)
  const [lastPermissionKey, setLastPermissionKey] = useState<string | null>(null)
  const permissionKey = permission ? `${permission.toolName}:${JSON.stringify(permission.input)}` : null
  if (permissionKey !== lastPermissionKey) {
    setLastPermissionKey(permissionKey)
    setPermissionSelected(0)
    setPermissionFeedback(null)
  }
  const [lastAuthorityKey, setLastAuthorityKey] = useState<string | null>(null)
  const authorityKey = authorityRequest?.preview.canonicalCallSha256 ?? null
  if (authorityKey !== lastAuthorityKey) {
    setLastAuthorityKey(authorityKey)
    setAuthoritySelected(1)
    setAuthorityViewedComplete(false)
    setAuthorityPage(0)
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
  const authorityViewerRows = useMemo(() => {
    if (!authorityRequest) return []
    return authorityViewerLines(authorityRequest.preview).flatMap((line) => {
      const style = line.kind === 'metadata' ? S_PRIMARY : S_DIM
      const cells = textToCells(line.text, style)
      const rows = wrapCellsToRows(cells, Math.max(20, termWidth - 4), Math.max(1, cells.length))
      return rows.length > 0 ? rows : [[]]
    })
  }, [authorityRequest, termWidth])
  const authorityPageCount = Math.max(1, Math.ceil(authorityViewerRows.length / 8))

  // ── Terminal resize handling ──
  // Force a re-render tick on resize so termWidth/termRows pick up the new
  // values. The cell matrix is invalidated but lastFrameHRef / lastTermRowsRef
  // are kept intact — the render effect needs them to compute where the OLD
  // frame sat so it can erase those rows before painting at the new position.
  const [, forceRender] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (!stdout) return
    const onResize = () => {
      // Capture per-row printable lengths of the on-screen frame before
      // dropping it (see prevFrameRowLensRef). A row's buffer length is the
      // position after its last non-blank cell; wide (CJK) cells count 2.
      // If prevFrameRef is already empty (two resizes before a render),
      // keep the previously captured lens — they still describe the frame
      // remnants on screen better than nothing.
      if (prevFrameRef.current.length > 0) {
        prevFrameRowLensRef.current = prevFrameRef.current.map((row) => {
          let len = 0
          for (let i = 0; i < row.length; i++) {
            const cell = row[i]
            if (cell && cell.char.trim() !== '') len = i + Math.max(1, cell.width)
          }
          return len
        })
      }
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
  //
  // Two-stage menu: stage 1 completes the slash command name itself
  // (`/mc` → `/mcp`); stage 2 fires after the user types a space and
  // completes a subcommand for commands that declare one (`/mcp ` →
  // `list / tools / auth / ...`). A third stage (server names, model
  // ids) would need an async per-command `complete()` callback —
  // intentionally not implemented; the second stage handles 80% of the
  // pain (the 8-subcommand `/mcp` block) at a tenth the code.
  //
  // Items carry `applyText` so the accept paths (Tab / Enter) can set
  // the input to the full path (`/mcp auth`) regardless of which stage
  // the user picked from. Display columns still use the bare `name`
  // (stage 2 shows `auth`, not `/mcp auth`) so the menu stays scannable.
  const matches = useMemo<MenuItem[]>(() => {
    if (!text.startsWith('/')) return []

    const fuzzyMatches = (name: string, query: string): boolean => {
      let qi = 0
      for (let ni = 0; ni < name.length && qi < query.length; ni++) {
        if (name[ni] === query[qi]) qi++
      }
      return qi === query.length
    }

    const firstSpace = text.indexOf(' ')
    if (firstSpace === -1) {
      // Stage 1: typing the command name. Match against /-stripped names.
      const query = text.slice(1).toLowerCase()
      const filtered = !query ? commands : commands.filter((c) => fuzzyMatches(c.name.slice(1).toLowerCase(), query))
      return filtered.map<MenuItem>((c) => ({
        name: c.name,
        description: c.description,
        applyText: c.name,
        argumentHint: c.argumentHint,
      }))
    }

    // Stage 2: typing the subcommand. `head` is the command (e.g. "/mcp"),
    // `tail` is whatever follows the first space. A second space means the
    // user has moved past the subcommand slot; we don't auto-complete
    // beyond that (no third-stage callback yet).
    const head = text.slice(0, firstSpace)
    const tail = text.slice(firstSpace + 1)
    if (tail.includes(' ')) return []

    const cmd = commands.find((c) => c.name === head)
    if (!cmd?.subcommands) return []

    const query = tail.toLowerCase()
    const filtered = !query ? cmd.subcommands : cmd.subcommands.filter((s) => fuzzyMatches(s.name.toLowerCase(), query))
    return filtered.map<MenuItem>((s) => ({
      name: s.name,
      description: s.description,
      applyText: `${head} ${s.name}`,
    }))
  }, [text, commands])

  const safeIndex = matches.length > 0 ? completionIndex % matches.length : 0
  const currentMatch = matches.length > 0 ? matches[safeIndex] : null

  // ── @-mention file completion ──
  // detectAtToken is cheap; recompute every render so it tracks cursor
  // moves (left/right arrows) without explicit invalidation.
  const atTrigger = useMemo(() => detectAtToken(text, cursor), [text, cursor])
  const atMatches = useMemo(() => {
    if (!atTrigger.active) return [] as FileEntry[]
    return scoreAndRank(fileEntries as FileEntry[], atTrigger.query).slice(0, MAX_AT_RESULTS)
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
    // While the agent is still thinking, slash commands stay blocked —
    // running /compact or /resume mid-turn would corrupt shared state.
    // `/goal` controls the running goal; `/fork` is allowed only for owners
    // whose submit path captured a stable pre-request prefix.
    // Plain text still flows through to the normal steering queue.
    if (spinner) {
      const command = raw.trimStart().toLowerCase().split(/\s+/, 1)[0]
      if (
        command.startsWith('/') &&
        (!activeTurnOwner || !isSlashCommandAllowedWhileBusy(raw, activeTurnOwner, hasStableForkBoundary))
      )
        return
    }
    const expanded = override ? raw : expandPasteRefs(raw, pastedContents)
    // Record the pre-expansion form in input history (Up/Down recall) so
    // that restoring an entry doesn't unfold the entire paste block back
    // into the input box — `[#N +M lines]` refs stay compact, just like
    // they were on submit. `override` is the slash-completion path
    // (`handleSubmit('/help')` etc.) where there are no paste refs.
    pushHistory(override ? raw : text, override ? {} : pastedContents)
    resetHistoryNav()
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

  /** Move the cursor up/down by `delta` VISUAL lines (soft-wrap aware, so a
   *  long single logical line wrapped across terminal rows is navigable
   *  row-by-row). Returns `true` if the cursor actually moved, `false` if it
   *  was already at the top/bottom visual edge — the falsy return is what
   *  lets the Up/Down handlers fall through to the history-navigation path
   *  (same trick Claude Code's `upOrHistoryUp` uses). */
  const moveCursorVertically = (delta: number): boolean => {
    // Computed at keypress time from the live terminal width — a resize
    // re-wraps the input, and navigation must use the NEW geometry.
    const vpWidth = inputViewportWidth(termWidth)
    const newPos = moveCursorVisual(text, cursorRef.current, delta, vpWidth)
    if (newPos === null) return false
    dispatch({ type: 'SET_CURSOR', cursor: newPos })
    return true
  }

  const { isNavigatingHistory, navigateHistoryDown, navigateHistoryUp, pushHistory, resetHistoryNav } = useInputHistory(
    {
      text,
      cursorRef,
      pastedContents,
      dispatch,
      setPastedContents,
      setCompletionIndex,
      setAtCompletionIndex,
    },
  )

  const clearInput = () => {
    dispatch({ type: 'RESET' })
    textRef.current = ''
    cursorRef.current = 0
    setPastedContents({})
    setCompletionIndex(0)
    setAtCompletionIndex(0)
    resetHistoryNav()
    lastEscapeAtRef.current = 0
  }

  usePromptInput({
    enabled: !disabled && !hidden,
    onInterrupt,
    onText: (chunk) => {
      const dialogSlashDraft = textRef.current.trimStart().startsWith('/') || chunk.trimStart().startsWith('/')
      if (authorityRequest) return
      // Route single-char y/n to the Permission resolver when a dialog is
      // active. Slash commands remain editable so `/goal pause` /
      // `/goal cancel` can interrupt a goal even while a tool approval is
      // waiting.
      if (permission) {
        // Feedback edit mode swallows ALL typed text into the inline
        // buffer (kimi-cli's Reject-with-feedback row).
        if (permissionFeedback) {
          setPermissionFeedback((prev) =>
            prev
              ? {
                  text: prev.text.slice(0, prev.cursor) + chunk + prev.text.slice(prev.cursor),
                  cursor: prev.cursor + chunk.length,
                }
              : prev,
          )
          return
        }
        const ch = chunk.toLowerCase()
        if (!dialogSlashDraft) {
          // Codex/kimi-style single-key shortcuts: y/n always work, 'a'
          // approves the always-rule when one is offered, 'f' opens the
          // deny-with-feedback editor, and digits pick the numbered
          // option directly.
          const hasAlways = suggestRuleLabel(permission.toolName, permission.input, !!permission.mcp) !== null
          const actions: ('yes' | 'always' | 'no' | 'feedback')[] = hasAlways
            ? ['yes', 'always', 'no', 'feedback']
            : ['yes', 'no', 'feedback']
          if (ch === 'y') {
            permission.onResolve('yes')
            return
          }
          if (ch === 'n') {
            permission.onResolve('no')
            return
          }
          if (ch === 'a' && hasAlways) {
            permission.onResolve('always')
            return
          }
          if (ch === 'f') {
            setPermissionSelected(actions.length - 1)
            setPermissionFeedback({ text: '', cursor: 0 })
            return
          }
          if (/^[1-9]$/.test(ch)) {
            const action = actions[Number(ch) - 1]
            if (action === 'feedback') {
              setPermissionSelected(actions.length - 1)
              setPermissionFeedback({ text: '', cursor: 0 })
              return
            }
            if (action) {
              permission.onResolve(action)
              return
            }
          }
        }
        if (dialogSlashDraft) {
          insertAtCursor(chunk)
          setCompletionIndex(0)
        }
        return
      }
      if (selectRequest) {
        if (dialogSlashDraft) {
          insertAtCursor(chunk)
          setCompletionIndex(0)
          return
        }
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
      insertAtCursor(chunk)
      setCompletionIndex(0)
    },
    onPaste: (content) => {
      const dialogSlashPaste = content.trimStart().startsWith('/')
      if (authorityRequest) return
      if (permission) {
        if (permissionFeedback) {
          setPermissionFeedback((prev) =>
            prev
              ? {
                  text: prev.text.slice(0, prev.cursor) + content + prev.text.slice(prev.cursor),
                  cursor: prev.cursor + content.length,
                }
              : prev,
          )
          return
        }
        if (dialogSlashPaste) {
          insertAtCursor(content)
          setCompletionIndex(0)
        }
        return
      }
      if (selectRequest) {
        if (dialogSlashPaste) {
          insertAtCursor(content)
          setCompletionIndex(0)
          return
        }
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
      if (isLarge) {
        const id = nextPasteIdRef.current++
        setPastedContents((prev) => ({ ...prev, [id]: { id, content, lineCount } }))
        insertAtCursor(formatPasteRef(id, lineCount))
      } else {
        insertAtCursor(content)
      }
      setCompletionIndex(0)
    },
    onKey: (key) => {
      const dialogSlashMode = textRef.current.trimStart().startsWith('/')
      if (authorityRequest) {
        if (key === 'escape') {
          authorityRequest.onResolve(false, authorityViewedComplete)
          return
        }
        if (!authorityViewedComplete && (key === 'down' || key === 'right' || key === 'pagedown' || key === 'return')) {
          setAuthorityPage((page) => {
            const next = Math.min(authorityPageCount - 1, page + 1)
            if (next === authorityPageCount - 1) setAuthorityViewedComplete(true)
            return next
          })
          return
        }
        if (!authorityViewedComplete && (key === 'up' || key === 'left' || key === 'pageup')) {
          setAuthorityPage((page) => Math.max(0, page - 1))
          return
        }
        if (key === 'up' || key === 'down') {
          setAuthoritySelected((selected) => (selected === 0 ? 1 : 0))
          return
        }
        if (key === 'return') {
          authorityRequest.onResolve(authoritySelected === 0, true)
          return
        }
        return
      }
      // Permission dialog captures navigation + submit keys.
      if (permission && !dialogSlashMode) {
        const hasAlwaysOption = suggestRuleLabel(permission.toolName, permission.input, !!permission.mcp) !== null
        const maxIdx = hasAlwaysOption ? 3 : 2
        // Inline feedback editing (same key set as the selectRequest
        // freeform row). Esc exits back to option navigation without
        // resolving; Enter submits the denial only when non-empty so a
        // stray keypress can't send a blank explanation.
        if (permissionFeedback) {
          if (key === 'escape') {
            setPermissionFeedback(null)
            return
          }
          if (key === 'return') {
            const trimmed = permissionFeedback.text.trim()
            if (!trimmed) return
            permission.onResolve({ kind: 'deny', feedback: trimmed })
            return
          }
          if (key === 'up' || key === 'down') {
            setPermissionFeedback(null)
            setPermissionSelected((p) => (key === 'up' ? (p > 0 ? p - 1 : maxIdx) : p < maxIdx ? p + 1 : 0))
            return
          }
          if (key === 'backspace') {
            setPermissionFeedback((prev) =>
              !prev || prev.cursor === 0
                ? prev
                : { text: prev.text.slice(0, prev.cursor - 1) + prev.text.slice(prev.cursor), cursor: prev.cursor - 1 },
            )
            return
          }
          if (key === 'delete') {
            setPermissionFeedback((prev) =>
              !prev || prev.cursor >= prev.text.length
                ? prev
                : { text: prev.text.slice(0, prev.cursor) + prev.text.slice(prev.cursor + 1), cursor: prev.cursor },
            )
            return
          }
          if (key === 'left') {
            setPermissionFeedback((prev) => (prev ? { text: prev.text, cursor: Math.max(0, prev.cursor - 1) } : prev))
            return
          }
          if (key === 'right') {
            setPermissionFeedback((prev) =>
              prev ? { text: prev.text, cursor: Math.min(prev.text.length, prev.cursor + 1) } : prev,
            )
            return
          }
          if (key === 'home') {
            setPermissionFeedback((prev) => (prev ? { text: prev.text, cursor: 0 } : prev))
            return
          }
          if (key === 'end') {
            setPermissionFeedback((prev) => (prev ? { text: prev.text, cursor: prev.text.length } : prev))
            return
          }
          if (key === 'clear') {
            setPermissionFeedback({ text: '', cursor: 0 })
            return
          }
          return
        }
        if (key === 'up') {
          setPermissionSelected((p) => (p > 0 ? p - 1 : maxIdx))
          return
        }
        if (key === 'down') {
          setPermissionSelected((p) => (p < maxIdx ? p + 1 : 0))
          return
        }
        if (key === 'return') {
          const decisions: ('yes' | 'always' | 'no' | 'feedback')[] = hasAlwaysOption
            ? ['yes', 'always', 'no', 'feedback']
            : ['yes', 'no', 'feedback']
          const picked = decisions[permissionSelected]!
          if (picked === 'feedback') {
            setPermissionFeedback({ text: '', cursor: 0 })
            return
          }
          permission.onResolve(picked)
          return
        }
        // Esc rejects, matching codex-cli's approval overlay (and the
        // hint footer that advertises it).
        if (key === 'escape') {
          permission.onResolve('no')
          return
        }
        return
      }
      // Select-options dialog captures navigation + submit keys. When
      // the highlighted option is `freeform`, editing keys (backspace,
      // delete, left, right, home, end) also feed its inline text
      // buffer instead of being swallowed.
      if (selectRequest && !dialogSlashMode) {
        const len = selectRequest.options.length
        const opt = selectRequest.options[selectIndex]
        const isFreeform = !!opt?.freeform
        // Esc dismisses user-initiated pickers (slash commands like
        // /theme, /model) — the user may have just been browsing and
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
          if (key === 'clear') {
            setFreeform({ text: '', cursor: 0 })
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
        // selection, then Enter — redundant. `applyText` carries the full
        // path so picking a stage-2 subcommand submits `/mcp auth`, not
        // bare `auth`.
        if (currentMatch) {
          handleSubmit(currentMatch.applyText)
          return
        }
        // Backslash continuation: `\` immediately before the cursor + Enter
        // converts to a literal newline instead of submitting. Universal
        // fallback for terminals that can't distinguish Ctrl+Enter from
        // Enter (which is most of them — see use-prompt-input.ts).
        const cur = cursorRef.current
        if (cur > 0 && text[cur - 1] === '\\') {
          const next = text.slice(0, cur - 1) + '\n' + text.slice(cur)
          dispatch({ type: 'SET_TEXT', text: next, cursor: cur })
          setCompletionIndex(0)
          return
        }
        handleSubmit()
        return
      }
      if (key === 'newline') {
        // Alt/Option+Enter (or modifyOtherKeys / kitty Ctrl+Enter) — insert
        // a literal newline at the cursor without submitting. Bypasses the
        // @-menu and slash-completion intercepts on purpose: the user has
        // explicitly asked for a line break.
        insertAtCursor('\n')
        setCompletionIndex(0)
        return
      }
      if (key === 'clear') {
        clearInput()
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
          clearInput()
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
          dispatch({ type: 'BACKSPACE_REF', pos, deleteCount: pos - previousGraphemeBoundary(text, pos) })
        }
        setCompletionIndex(0)
        return
      }
      if (key === 'delete') {
        const pos = cursorRef.current
        const end = nextGraphemeBoundary(text, pos)
        dispatch({ type: 'SET_TEXT', text: text.slice(0, pos) + text.slice(end), cursor: pos })
        return
      }
      if (key === 'left') {
        dispatch({ type: 'SET_CURSOR', cursor: previousGraphemeBoundary(text, cursorRef.current) })
        return
      }
      if (key === 'right') {
        dispatch({ type: 'SET_CURSOR', cursor: nextGraphemeBoundary(text, cursorRef.current) })
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
          dispatch({ type: 'SET_TEXT', text: currentMatch.applyText, cursor: currentMatch.applyText.length })
          setCompletionIndex(0)
        }
        return
      }
      if (key === 'up') {
        // Suggestion menu wins over history nav when there's a real selection
        // to make. The carve-out is the single-match-in-history-nav case: a
        // restored `/model` entry auto-opens a 1-item slash menu, where
        // cycling is a no-op — if we let the menu swallow Up the user is
        // trapped with no way to keep scrolling back. With 2+ matches the
        // menu's cycling is meaningful, so it wins even mid-history; with
        // 0/1 matches we fall through to cursor + history nav.
        const inHistoryNav = isNavigatingHistory()
        if (activeMenu === 'at' && atMatches.length > 0 && (!inHistoryNav || atMatches.length > 1)) {
          setAtCompletionIndex((p) => (p - 1 + atMatches.length) % atMatches.length)
          return
        }
        if (activeMenu === 'slash' && matches.length > 0 && (!inHistoryNav || matches.length > 1)) {
          setCompletionIndex((p) => (p - 1 + matches.length) % matches.length)
          return
        }
        // Cursor first; fall through to history nav only when the cursor was
        // already on the logical first line (so multi-line drafts and recalled
        // entries can still be edited row-by-row).
        if (!moveCursorVertically(-1)) {
          // Mid-turn queue pop wins over history recall on an empty input:
          // the user most likely wants to edit what they just queued
          // (LIFO — Codex's Alt+Up equivalent).
          const tail = text.length === 0 && queuedMessages?.length ? queuedMessages[queuedMessages.length - 1] : null
          if (tail) {
            dispatch({ type: 'SET_TEXT', text: tail.text, cursor: tail.text.length })
            onPopQueued?.(tail.id)
          } else {
            navigateHistoryUp()
          }
        }
        return
      }
      if (key === 'down') {
        const inHistoryNav = isNavigatingHistory()
        if (activeMenu === 'at' && atMatches.length > 0 && (!inHistoryNav || atMatches.length > 1)) {
          setAtCompletionIndex((p) => (p + 1) % atMatches.length)
          return
        }
        if (activeMenu === 'slash' && matches.length > 0 && (!inHistoryNav || matches.length > 1)) {
          setCompletionIndex((p) => (p + 1) % matches.length)
          return
        }
        if (!moveCursorVertically(1)) navigateHistoryDown()
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
      blankRowsAboveFrameRef.current = 0
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
    // /clear shrinks the message list back to empty. Push the current
    // viewport into real terminal scrollback before repainting an empty
    // viewport. CSI 3J must not be used here: unlike a shell `clear`, it
    // destroys history that the user expects to reach by scrolling up.
    //
    // `didClearScreen` forces the immediate-flush path below: the erase +
    // scroll bytes built here are ONE-SHOT (the branch re-runs only when
    // messages shrink again), so the cancellable deferred/throttle paths
    // must never carry them — a superseded clear payload loses the bytes
    // forever while justClearedRef still anchors the new frame at row 1,
    // leaving the old conversation visible below it.
    let didClearScreen = false
    if (messages.length < writtenMessageCountRef.current) {
      didClearScreen = true
      const retainedClearEcho =
        messages.length === 1 && messages[0]?.kind === 'command-echo' && messages[0].content.trim() === '/clear'
      const clearRows = stdout?.rows ?? 25
      const oldFrameTop = Math.max(1, lastFrameTopRef.current || clearRows - lastFrameHRef.current + 1)
      for (let row = oldFrameTop; row <= clearRows; row++) preBuf += `\x1b[${row};1H\x1b[K`
      preBuf += `\x1b[${clearRows};1H${'\n'.repeat(clearRows)}\x1b[H`
      // A retained /clear echo is NOT written into the old viewport here.
      // Leaving writtenMessageCountRef at 0 lets the normal message loop +
      // commit path below render it as the first content of the fresh
      // viewport — the same padded card every other command echo gets.
      // (Writing it at the old viewport's bottom pushed it into scrollback,
      // hiding it entirely and dropping its bg padding rows on terminals
      // that trim bg-only rows when they enter history.)
      writtenMessageCountRef.current = retainedClearEcho ? 0 : messages.length
      prevFrameRef.current = []
      lastFrameHRef.current = 0
      lastFrameTopRef.current = 0
      freeBlanksAboveFrameRef.current = 0
      blankRowsAboveFrameRef.current = 0
      // The clear wipes the scrollback we were about to write to. Any
      // pending bytes from a prior cancelled throttle are now stale —
      // they belong to messages that no longer exist (post-/clear,
      // messages.length is 0).
      pendingScrollbackRef.current = ''
      activeRef.current = false
      justClearedRef.current = true
      // Drops scrollback-spacing flags + buffered read-group entries
      // (those summaries pointed at messages we just wiped — flushing
      // them later would leave a phantom row above the empty history).
      resetScrollbackSpacing()
    }
    const termRows = stdout?.rows ?? 25
    // `hasNewMessages` — we walked new entries this render (advanced
    // `writtenMessageCountRef`). True even if every message got buffered
    // by the read-group collapser and produced zero scrollback bytes.
    // Used by the message-write loop and the permission-slot bookkeeping.
    //
    // `didCommitMessages` — actual scrollback bytes were produced. ONLY
    // this gates the geometry/scroll branches below: `countContentRows`
    // returns 1 for an empty string (a single empty line), so treating
    // a buffered-only render as if it scrolled 1 row drifted the frame
    // down on every consecutive Read/Glob/Grep tool, accumulating real
    // blank rows in terminal scrollback (the "lots of blank lines"
    // symptom on multi-read chains).
    const hasNewMessages = messages.length > writtenMessageCountRef.current
    const collectWrite: (data: string) => void = (data) => {
      pendingScrollbackRef.current += data
    }
    if (hasNewMessages) {
      for (let i = writtenMessageCountRef.current; i < messages.length; i++) {
        writeMessageToStdout(collectWrite, messages[i])
      }
      writtenMessageCountRef.current = messages.length
    }
    // End-of-turn safety net: writeMessageToStdout buffers consecutive
    // read-only tool messages (Read / Glob / Grep / ListDir) and flushes
    // them inline when the next non-collapsible message arrives. If a
    // chain ends without that closing message — user pressed Esc mid-chain,
    // the model returned `finishReason='stop'` with no text, etc. — the
    // buffer would otherwise sit until the user submits again. Flushing
    // when isLoading drops to false commits the trailing summary so it
    // lands on this same render's atomic write.
    if (!isLoading) {
      flushPendingReadGroup(collectWrite)
    }
    // Snapshot the cross-render ref into a local. The geometry path reads
    // `scrollbackContent` multiple times and the snapshot keeps a single
    // render's view consistent. The bytes stay in the ref until doFlush
    // confirms they made it to stdout — see pendingScrollbackRef's docs.
    const scrollbackContent = pendingScrollbackRef.current
    const didCommitMessages = scrollbackContent.length > 0

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
    // Only reserve when one to three tools are pending. The boxed
    // permission dialog is 11 rows (top rule + title + blank + content +
    // blank + Yes + Always + No + feedback + blank + hint + bottom rule)
    // + 3 input = 14; one running tool takes 2 rows so it needs 9 blanks
    // to hold that height, two tools take 4 rows and need 7, three take
    // 6 and need 5. Four or more tools make the frame LARGER than the
    // dialog, which is a grow (handled correctly by the existing
    // freeBlanks/preScroll path); zero tools means the approved tool was
    // denied or hasn't produced an onToolCall yet — reserving blank rows
    // there would just shift the gap around rather than eliminate it.
    //
    // The 11-row figure is the COMMON case: suggestRuleLabel only
    // returns null for enterPlanMode (which runs no tools on approval),
    // so the Always row is effectively always present. Rare 9-row
    // dialogs (unknown tool with no content row) over-reserve by two —
    // transient blank rows, cheaper than the stale residue an
    // under-reserved shrink leaves behind.
    const hadPermissionLastRender = prevHadPermissionRef.current
    const runningToolCount = activeToolCalls?.length ?? 0
    if (hasNewMessages || permission) {
      permissionSlotReserveRef.current = 0
    } else if (hadPermissionLastRender && !permission && runningToolCount >= 1 && runningToolCount <= 3) {
      permissionSlotReserveRef.current = 11 - runningToolCount * 2
    }
    prevHadPermissionRef.current = !!permission

    const vpWidth = inputViewportWidth(termWidth)
    // Rounded prompt box (Crush-style): `╭╮╰╯` corners, `─` top/bottom
    // rules, `│` side rails. All box-drawing chars sit in the CP437-safe
    // U+2500–U+257F range, so legacy ConHost needs no glyph fallback.
    const boxWidth = Math.max(2, termWidth - 1)
    const boxRule = '─'.repeat(Math.max(0, boxWidth - 2))
    // Keep the frame neutral so persistent permission modes do not turn the
    // whole composer into a warning banner. The footer label carries the mode.
    const frameStyle = S_BORDER

    // Wraps content cells in a full-width `│ … │` row: clips overflow,
    // then pads with trailing spaces so the right rail lands on the box's
    // last column. Rows this wide are safe mid-frame — only the frame's
    // LAST row must stay narrow (xterm.js auto-wrap ghost-line issue,
    // documented at the footer below).
    const boxContentWidth = Math.max(10, boxWidth - BOX_INNER_PAD)
    const boxedRow = (cells: Cell[], borderStyle: string): Cell[] => {
      const clipped = truncateCellRow(cells, boxContentWidth)
      const used = clipped.reduce((sum, cell) => sum + cell.width, 0)
      const row: Cell[] = [
        { char: '│', style: borderStyle, width: 1 },
        { char: ' ', style: S_NONE, width: 1 },
        ...clipped,
      ]
      for (let i = used; i < boxContentWidth; i++) row.push({ char: ' ', style: S_NONE, width: 1 })
      row.push({ char: ' ', style: S_NONE, width: 1 })
      row.push({ char: '│', style: borderStyle, width: 1 })
      return row
    }

    // ── Input display lines (with soft-wrap + viewport windowing) ──
    // Raw lines are split by explicit `\n` only. Each raw line is then
    // soft-wrapped at vpWidth columns into one or more visual lines, so
    // the input doesn't run off the right edge of the terminal. The
    // cursor's character offset is mapped into the matching (visualLine,
    // visualCol) pair for the render/diff paths below. Both computations
    // share their implementation with Up/Down cursor movement — see the
    // module-level soft-wrap geometry helpers.
    const rawLines = text.length === 0 ? [''] : text.split('\n')
    const visualLines = buildVisualLines(rawLines, vpWidth)
    const { line: visCursorLine, col: visCursorCol } = locateVisualCursor(visualLines, rawLines, cursor)

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

    // Frame-relative row of the input box's first display line, captured
    // while pushing input rows below. Fallback park target for the hidden
    // hardware cursor when no S_CURSOR caret cell exists in the frame
    // (caret scrolled out of the visible window). See the cursor-park
    // block further down for why the park position matters to IMEs.
    let inputFirstLineRow = -1

    // Error line (if any)
    if (errorMessage) {
      const cells: Cell[] = []
      cells.push({ char: ' ', style: S_NONE, width: 1 })
      cells.push(...textToCells(`Error: ${errorMessage}`, S_ERROR))
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
    // When tools are running we replace the generic "Working..." line with
    // a live tool-status block, one 2-row group per in-flight tool call:
    //    ● ToolName(preview)
    //    ⎿ ⠋ progressText          (← replaced by onToolProgress stream)
    // Mirrors Claude Code's AssistantToolUseMessage + renderToolUseProgress
    // flow. Elapsed/token meta moves onto the LAST progress line so the
    // block stays compact (no separate Working row competing for space).
    if (spinner && shellWaitStreak?.waiting) {
      const glyph = SPINNER_FRAMES[spinnerFrame]
      const elapsedMs = Math.max(0, Date.now() - shellWaitStreak.startedAt)
      const meta = elapsedMs >= 1_000 ? ` (${formatElapsed(elapsedMs)} · esc to interrupt)` : ' (esc to interrupt)'
      frame.push([...textToCells(` ${glyph} Waiting for background terminal`, S_SPINNER), ...textToCells(meta, S_DIM)])
      if (shellWaitStreak.command) {
        frame.push([
          ...textToCells('   ', S_NONE),
          ...textToCells(GLYPH_RESULT_BRACKET, S_GRAY_90),
          ...textToCells(` ${shellWaitStreak.command}`, S_DIM),
        ])
      }
    }

    if (spinner && !shellWaitStreak?.waiting) {
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
      // When Working sits directly below scrollback content, the last
      // message already ends with `\n\n` → one blank row is ALREADY
      // there, and adding another would make the gap look too large.
      if (permission) frame.push([])

      // Collapsible read-only tools (Read/Glob/Grep/ListDir) don't get a
      // live `● Read(file) / ⎿ Running…` indicator row — their results are
      // buffered into a single summary line that flushes at chain end, and
      // showing per-tool live indicators while buffering causes a visible
      // "appears then vanishes" flash on every fast read: the tool-call
      // render commits a 7-row frame with the live indicator, the result
      // arrives 1-5ms later, the post-result commit gets throttled 50ms,
      // and during that window the user sees the indicator land — then the
      // throttle releases, the frame shrinks back to 5 rows, and because
      // the read message was buffered (no scrollback row to take its
      // place) the indicator simply disappears. CC's batched-read flow
      // does the same: spinner during the chain, summary after. Slow reads
      // lose per-file visibility this way, but they're the rare case in
      // chains and the chain-end summary lists every file by basename.
      const tools = (activeToolCalls ?? []).filter((tc) => !isCollapsibleReadOnlyTool(tc.toolName))
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

          const label = authorityVisibleText(getToolLabel(tc.toolName))
          const preview = authorityVisibleText(getToolInputPreview(tc.toolName, tc.input))

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
          row1.push(...textToCells(GLYPH_TOOL_BULLET, dotStyle))
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
            // Shell commands get codex-style syntax highlighting —
            // mirrors the committed scrollback row in
            // `stdout-writer.formatToolCall`, which must match this
            // live row's coloring exactly (see the note above about
            // the live→commit color-flash).
            if (isShellToolName(tc.toolName)) {
              row1.push(...textToCells('(', S_PRIMARY))
              row1.push(...ansiTextToCells(highlightShellCommand(trimmed)))
              row1.push(...textToCells(')', S_PRIMARY))
            } else {
              row1.push(...textToCells(`(${trimmed})`, S_PRIMARY))
            }
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
              row.push(...textToCells(authorityVisibleText(history[hi]!), isLast ? S_DIM : S_GRAY_90))
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
            row2.push(...textToCells(authorityVisibleText(tc.progress ?? 'Running...'), S_DIM))
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
        // the user perceives the "Working" label flashing default-color
        // → blue → default → blue as the spaces in between trigger
        // resets. Keeping one continuous SGR run for the whole prefix
        // makes the row paint as one solid blue stripe.
        const cells: Cell[] = textToCells(` ${glyph} ${spinner.label}...`, S_SPINNER)
        if (meta) cells.push(...textToCells(meta, S_DIM))
        frame.push(cells)
      }
    }

    // Queued mid-turn user messages: dim one-line previews pinned between
    // the spinner and the input box — the closest visual anchor to where
    // the user just typed. One blank row above separates the block from
    // the spinner; below it hugs the input separator directly (two-sided
    // margins read as excessive padding here). The rows vanish the moment
    // the loop injects them — they reappear in scrollback as regular user
    // messages via consumeQueuedInputs.
    if (queuedMessages && queuedMessages.length > 0) {
      frame.push([])
      for (const q of queuedMessages) {
        const preview = q.text.replace(/\s+/g, ' ').trim()
        const cells: Cell[] = []
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push(...textToCells('queued: ', S_GRAY_90))
        cells.push(...textToCells(preview, S_DIM))
        frame.push(truncateCellRow(cells, Math.max(20, termWidth - 1)))
      }
    }

    // Permission dialog — rendered ABOVE the input box (between spinner
    // and the input's top separator) so the input stays pinned at the
    // bottom of the screen regardless of dialog state.
    if (permission) {
      // Boxed dialog (same `╭╮│╰╯` language as the prompt box) in
      // neutral white, matching the title and option text — the modal
      // moment should read as a container, not as more scrolling text.
      // Layout follows codex-cli's approval overlay: bold question title,
      // blank, content, blank, numbered options with dim shortcut suffixes,
      // blank, dim key-hint footer. Selected row uses the accent color.
      frame.push(textToCells(`╭${boxRule}╮`, S_TEXT_STRONG))
      const titleText = permissionTitle(permission.toolName, permission.mcp)
      const titleCells: Cell[] = []
      titleCells.push({ char: ' ', style: S_NONE, width: 1 })
      titleCells.push({ char: ' ', style: S_NONE, width: 1 })
      titleCells.push(...textToCells(titleText, S_TEXT_STRONG_BOLD))
      frame.push(boxedRow(titleCells, S_TEXT_STRONG))

      const contentCells = permissionContentCells(permission.toolName, permission.input, termWidth, permission.mcp)
      if (contentCells) {
        frame.push(boxedRow([], S_TEXT_STRONG))
        frame.push(boxedRow(contentCells, S_TEXT_STRONG))
      }
      frame.push(boxedRow([], S_TEXT_STRONG))

      const ruleLabel = suggestRuleLabel(permission.toolName, permission.input, !!permission.mcp)
      // When no rule can be suggested (e.g. powershell -Command "...",
      // enterPlanMode), the always-option is omitted. The last row is
      // kimi-cli's reject-with-feedback: selecting it (Enter / digit /
      // 'f') opens an inline text field instead of resolving.
      const options: { label: string; shortcut: string }[] = [{ label: 'Yes', shortcut: 'y' }]
      if (ruleLabel) options.push({ label: `Yes, don't ask again for: ${ruleLabel}`, shortcut: 'a' })
      options.push({ label: 'No', shortcut: 'esc' })
      options.push({ label: 'No, and tell X-Code what to do instead', shortcut: 'f' })

      options.forEach((opt, index) => {
        const selected = permissionSelected === index
        const style = selected ? S_PRIMARY_BOLD : S_TEXT_STRONG
        const cells: Cell[] = []
        cells.push(...textToCells(selected ? `${GLYPH_SELECT_POINTER} ` : '  ', style))
        if (index === options.length - 1 && permissionFeedback) {
          // Active feedback row collapses to an inline text field with
          // the same inverse-video cursor as the main input.
          cells.push(...textToCells(`${index + 1}. No: `, style))
          const t = permissionFeedback.text
          const c = permissionFeedback.cursor
          const before = t.slice(0, c)
          const cursorChar = c < t.length ? (graphemeAt(t, c) ?? ' ') : ' '
          const after = c < t.length ? t.slice(c + cursorChar.length) : ''
          cells.push(...textToCells(before, style))
          cells.push({ char: cursorChar, style: S_CURSOR, width: charWidth(cursorChar) })
          cells.push(...textToCells(after, style))
        } else {
          cells.push(...textToCells(`${index + 1}. ${opt.label}`, style))
          cells.push(...textToCells(` (${opt.shortcut})`, S_DIM))
        }
        frame.push(boxedRow(cells, S_TEXT_STRONG))
      })

      frame.push(boxedRow([], S_TEXT_STRONG))
      // ↑/↓ (U+2191/2193) and · (U+00B7) are both in CP437, so legacy
      // ConHost renders them without a glyph fallback.
      const hintCells: Cell[] = []
      hintCells.push(
        ...textToCells(
          permissionFeedback
            ? '  Type your feedback, then press Enter to submit · Esc to go back'
            : '  ↑/↓ select · Enter confirm · Esc cancel',
          S_DIM,
        ),
      )
      frame.push(boxedRow(hintCells, S_TEXT_STRONG))
      frame.push(textToCells(`╰${boxRule}╯`, S_TEXT_STRONG))
    }

    if (authorityRequest) {
      const preview = authorityRequest.preview
      const titleCells: Cell[] = []
      titleCells.push(...textToCells('  Peer-influenced request · allow once only', S_WARNING_BOLD))
      frame.push(truncateCellRow(titleCells, termWidth))

      const firstViewerRow = authorityPage * 8
      for (const row of authorityViewerRows.slice(firstViewerRow, firstViewerRow + 8)) {
        frame.push([...textToCells('  ', S_NONE), ...row])
      }
      frame.push(
        textToCells(
          authorityViewedComplete
            ? `  Complete payload viewed · SHA-256 ${preview.outboundPayload?.sha256 ?? preview.canonicalCallSha256}`
            : `  Payload page ${authorityPage + 1}/${authorityPageCount} · Enter/→ for next page; approval locked.`,
          authorityViewedComplete ? S_SUCCESS : S_WARNING,
        ),
      )

      const allowCells = textToCells(
        `${authoritySelected === 0 ? `    ${GLYPH_SELECT_POINTER}` : '     '} Allow once`,
        authoritySelected === 0 ? S_SUCCESS : S_DIM,
      )
      frame.push(allowCells)
      const denyCells = textToCells(
        `${authoritySelected === 1 ? `    ${GLYPH_SELECT_POINTER}` : '     '} Deny`,
        authoritySelected === 1 ? S_ERROR_BOLD : S_DIM,
      )
      frame.push(denyCells)
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
      // Match the live-tool-block filter above: collapsible read-only
      // tools don't draw an indicator, so they don't consume rows here
      // either. Without this filter the select-options dialog would
      // reserve phantom rows for invisible tools and place itself too
      // high (or scroll its own viewport unnecessarily).
      const tools = (activeToolCalls ?? []).filter((tc) => !isCollapsibleReadOnlyTool(tc.toolName))
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
        //   › 1. Label        ← focused: pointer "suggestion", label "suggestion"
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
          const labelStyle = active ? S_PRIMARY : S_NONE
          const cells: Cell[] = []
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          if (active) {
            cells.push(...textToCells(`${GLYPH_SELECT_POINTER} `, S_PRIMARY))
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
            const cursorChar = c < t.length ? (graphemeAt(t, c) ?? ' ') : ' '
            const after = c < t.length ? t.slice(c + cursorChar.length) : ''
            cells.push(...textToCells(before, S_NONE))
            cells.push({ char: cursorChar, style: S_CURSOR, width: charWidth(cursorChar) })
            cells.push(...textToCells(after, S_NONE))
          }
          frame.push(truncateCellRow(cells, maxRowWidth))
          if (opt.description && !opt.freeform) {
            const descCells: Cell[] = []
            descCells.push({ char: ' ', style: S_NONE, width: 1 })
            descCells.push(...textToCells(' '.repeat(descIndent), S_NONE))
            descCells.push(...textToCells(opt.description, S_DIM))
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
            cells.push(...textToCells(`${GLYPH_SELECT_POINTER} `, S_PRIMARY))
          } else {
            cells.push(...textToCells('  ', S_NONE))
          }
          cells.push(...textToCells(idx, S_DIM))

          const labelStyle = active ? S_PRIMARY : S_NONE
          cells.push(...textToCells(opt.label, labelStyle))

          if (opt.freeform && active) {
            cells.push(...textToCells(': ', S_NONE))
            const t = freeform.text
            const c = freeform.cursor
            const before = t.slice(0, c)
            const cursorChar = c < t.length ? (graphemeAt(t, c) ?? ' ') : ' '
            const after = c < t.length ? t.slice(c + cursorChar.length) : ''
            cells.push(...textToCells(before, S_NONE))
            cells.push({ char: cursorChar, style: S_CURSOR, width: charWidth(cursorChar) })
            cells.push(...textToCells(after, S_NONE))
          } else if (opt.description) {
            const curLabelW = visualWidth(opt.label)
            const pad = Math.max(1, labelCol - curLabelW)
            cells.push(...textToCells(' '.repeat(pad), S_NONE))
            cells.push(...textToCells(opt.description, S_DIM))
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
      // array of pre-rendered ANSI rows (e.g. the `/theme` picker
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
    //     "waiting", not "forgotten"). In-progress: filled square in
    //     primary + bold content — shape (filled vs hollow), weight
    //     (bold vs regular) AND the single brand hue mark active state.
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
          cells.push(...textToCells(GLYPH_TODO_IN_PROGRESS, S_PRIMARY_BOLD))
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

    if (backgroundTerminalCount > 0) {
      const label = `${backgroundTerminalCount} background terminal${backgroundTerminalCount === 1 ? '' : 's'} running · /ps to view · /stop to close`
      const style = backgroundTerminalWarningCount > 0 ? S_WARNING_BOLD : S_DIM
      frame.push([...textToCells(' ', S_NONE), ...textToCells(label, style)])
    }

    // Reserved padding left over from a permission dialog that just closed.
    // Sits between the in-progress tool rows (above) and the input
    // separators (below) so the frame keeps the dialog's total height
    // until the approved tool's result commits and slides into the
    // reserved space.
    for (let i = 0; i < permissionSlotReserveRef.current; i++) {
      frame.push([])
    }

    // Top box rule
    frame.push(textToCells(`╭${boxRule}╮`, frameStyle))

    // Input lines. The terminal's hardware cursor is hidden for the
    // entire TUI lifetime; the visible "cursor" the user sees is just an
    // inverse-video cell (S_CURSOR) drawn into the frame at the cursor
    // position. So we don't compute or emit a cursor-park CSI here.
    for (let i = 0; i < displayLines.length; i++) {
      const line = displayLines[i]
      if (i === 0) inputFirstLineRow = frame.length
      // Same `›` glyph the committed echo uses (stdout-writer) — the
      // plain ASCII `>` reads pointier and out of place next to it.
      // U+203A is width-1 per text-width.ts, so the prompt keeps its
      // two-cell footprint (arrow + space).
      const prompt = i === 0 ? `${GLYPH_PROMPT_ARROW} ` : '  '
      const showCursor = !disabled && i === cursorLine && cursorLine >= 0
      const cells: Cell[] = []

      cells.push({ char: prompt[0], style: frameStyle, width: 1 })
      cells.push({ char: prompt[1], style: S_NONE, width: 1 })

      if (!showCursor) {
        const lw = visualWidth(line)
        const truncated = lw > vpWidth ? sliceByWidth(line, vpWidth) : line
        cells.push(...textToCells(truncated, S_RESET))
      } else {
        const before = line.slice(0, cursorCol)
        const cursorChar = cursorCol < line.length ? (graphemeAt(line, cursorCol) ?? ' ') : ' '
        const after = cursorCol < line.length ? line.slice(cursorCol + cursorChar.length) : ''
        const lw = visualWidth(line)

        if (lw <= vpWidth) {
          cells.push(...textToCells(before, S_RESET))
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
          const afterStart = cursorCol < line.length ? cursorCol + cursorChar.length : line.length
          const remaining = vpWidth - visualWidth(vb) - charWidth(cursorChar)
          const va = sliceByWidth(line.slice(afterStart), Math.max(0, remaining))
          cells.push(...textToCells(vb, S_RESET))
          cells.push({ char: cursorChar, style: S_CURSOR, width: charWidth(cursorChar) })
          cells.push(...textToCells(va, S_RESET))
        }
      }
      frame.push(boxedRow(cells, frameStyle))
    }

    // Bottom box rule
    frame.push(textToCells(`╰${boxRule}╯`, frameStyle))

    // Footer row — compact mode/model/context status owned entirely by the
    // cell-diff buffer. Its width is capped at `termWidth - 1` so it never
    // lands on the terminal's auto-wrap boundary.
    //
    // Left side  — notice / mode indicator (mutually exclusive). Priority:
    //              notice > plan > acceptEdits. Mode switching via slash
    //              commands only (/plan); the Shift+Tab keybinding was
    //              removed because Windows needs Node ≥22.17 VT input mode
    //              and Alt+M is too easily clobbered by IDE menus.
    // Right side — active model plus `ctx 6.6k / 200k · 3%` when usage is
    //              available. Context is green normally, amber from 70%,
    //              and red at the 80% compression threshold.
    let leftCells: Cell[] | null = null
    if (notice) {
      const cells: Cell[] = []
      cells.push({ char: ' ', style: S_NONE, width: 1 })
      cells.push(...ansiTextToCells(notice))
      leftCells = cells
    } else if (peerInfluenced || pendingPeerCount > 0) {
      const cells: Cell[] = []
      cells.push({ char: ' ', style: S_NONE, width: 1 })
      if (peerInfluenced) {
        cells.push(
          ...textToCells(
            trustMode
              ? 'Peer-influenced context · local trust active'
              : 'Peer-influenced context · auto permissions off',
            S_WARNING_BOLD,
          ),
        )
      }
      if (pendingPeerCount > 0) {
        if (peerInfluenced) cells.push(...textToCells('  ·  ', S_DIM))
        cells.push(...textToCells(`${pendingPeerCount} peer pending`, S_DIM))
      }
      leftCells = cells
    } else if (permissionMode === 'plan') {
      const cells: Cell[] = []
      cells.push({ char: ' ', style: S_NONE, width: 1 })
      cells.push(...textToCells('plan mode', S_PRIMARY_BOLD))
      cells.push(...textToCells('  /plan to toggle', S_DIM))
      leftCells = cells
    } else if (permissionMode === 'acceptEdits') {
      const cells: Cell[] = []
      cells.push({ char: ' ', style: S_NONE, width: 1 })
      cells.push(...textToCells('accept edits', S_WARNING_BOLD))
      leftCells = cells
    }

    const rightCells: Cell[] = []
    if (modelLabel) rightCells.push(...textToCells(modelLabel, S_MODEL))
    if (contextUsage && contextUsage.used > 0 && contextUsage.window > 0) {
      const pct = Math.round((contextUsage.used / contextUsage.window) * 100)
      const usage = `${formatTokenCount(contextUsage.used)} / ${formatTokenCount(contextUsage.window)} · ${pct}%`
      const usageStyle = pct >= 80 ? S_ERROR : pct >= 70 ? S_WARNING : S_USAGE
      if (modelLabel) rightCells.push(...textToCells(' · ', S_DIM))
      rightCells.push(...textToCells('ctx ', S_DIM))
      rightCells.push(...textToCells(usage, usageStyle))
    }

    if (leftCells || rightCells.length > 0) {
      // Footer row built as a NARROW cell sequence — left + ` · ` + right —
      // never padded out to termWidth-1.
      //
      // Why narrow: an earlier revision right-justified `rightText` by
      // padding with spaces to termWidth-1 cells. That made the LAST row
      // of the frame land its final cell on the terminal's auto-wrap
      // column. Under BSU/ESU sync mode on xterm.js (VS Code's terminal),
      // a frame whose bottom row is that wide leaks residual cells into
      // native scrollback every time a tool-result commit fires its LF
      // auto-scroll — manifesting as ghost "Working…" rows piling up
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
      if (rightCells.length > 0) {
        if (leftWidth > 0) {
          cells.push(...textToCells('  ·  ', S_DIM))
        } else {
          cells.push({ char: ' ', style: S_NONE, width: 1 })
        }
        cells.push(...rightCells)
      }
      // Truncate defensively: the model label made this row longer than it
      // used to be, and a hard physical wrap would desync the cell-diff
      // grid (same reasoning as the menu-row truncation above).
      frame.push(truncateCellRow(cells, Math.max(20, termWidth - 1)))
    }

    // Completion menu — at most one of slash / at renders per frame
    // (activeMenu enforces the mutex). Two writers in the same frame
    // would both compete for the rows above the input box, and a
    // resize would clobber whichever drew last.
    if (activeMenu === 'slash') {
      // Column width includes the longest "name + space + argumentHint" so
      // every description column starts at the same x. Without folding
      // the hint into the width, hint-bearing rows would push description
      // to a different column from hint-less rows, producing a ragged
      // right edge.
      const labelWidth = matches.reduce((max, cmd) => {
        const hintW = cmd.argumentHint ? cmd.argumentHint.length + 1 : 0
        return Math.max(max, cmd.name.length + hintW)
      }, 0)
      // Each description is wrapped across up to 2 rows; a description that
      // still overflows gets an ellipsis at the end of row 2. Truncation is
      // required: a row wider than termWidth hard-wraps at the physical-row
      // level (cell-diff treats it as one grid row, so [K clears miss the
      // wrapped overflow) and, when it spills past the last terminal row,
      // scrolls the viewport — drifting the frame out of sync with
      // lastFrameTopRef and leaving a phantom input box on every menu
      // open/dismiss cycle.
      const maxRowWidth = Math.max(20, termWidth - 1)
      const descCol = labelWidth + 4 // 2-space gutter + label area (labelWidth + 2-space pad)
      const descWidth = Math.max(10, maxRowWidth - descCol)
      // Windowed rendering: show at most MAX_VISIBLE_MENU_ITEMS items
      // at a time, sliding the window to keep safeIndex visible. This
      // caps the frame height so the menu never pushes scrollback
      // content out of the viewport (the root cause of the streaming-
      // corruption bug where `/` during an AI reply overwrote committed
      // scrollback and froze the display).
      const total = matches.length
      const cap = MAX_VISIBLE_MENU_ITEMS
      let winStart: number
      let winEnd: number
      if (total <= cap) {
        winStart = 0
        winEnd = total
      } else {
        winStart = Math.max(0, Math.min(safeIndex - Math.floor(cap / 2), total - cap))
        winEnd = winStart + cap
      }
      if (winStart > 0) {
        frame.push(textToCells(`  ▲ ${winStart} more`, S_DIM))
      }
      for (let i = winStart; i < winEnd; i++) {
        const cmd = matches[i]
        const sel = i === safeIndex
        const labelLen = cmd.name.length + (cmd.argumentHint ? cmd.argumentHint.length + 1 : 0)
        const padRight = ' '.repeat(Math.max(2, labelWidth + 2 - labelLen))
        const padStyle = sel ? S_NONE : S_DIM
        const descStyle = sel ? S_RESET : S_DIM

        const labelCells: Cell[] = []
        labelCells.push({ char: ' ', style: S_NONE, width: 1 })
        labelCells.push({ char: ' ', style: S_NONE, width: 1 })
        labelCells.push(...textToCells(cmd.name, sel ? S_PRIMARY_BOLD : S_DIM))
        if (cmd.argumentHint) {
          labelCells.push(...textToCells(' ', padStyle))
          labelCells.push(...textToCells(cmd.argumentHint, S_DIM))
        }
        labelCells.push(...textToCells(padRight, padStyle))

        const descRows = wrapCellsToRows(textToCells(cmd.description, descStyle), descWidth, 2)
        const row1: Cell[] = [...labelCells, ...(descRows[0] ?? [])]
        frame.push(truncateCellRow(row1, maxRowWidth))
        if (descRows.length > 1) {
          const indent: Cell[] = []
          for (let k = 0; k < descCol; k++) indent.push({ char: ' ', style: S_NONE, width: 1 })
          frame.push(truncateCellRow([...indent, ...descRows[1]!], maxRowWidth))
        }
      }
      if (winEnd < total) {
        frame.push(textToCells(`  ▼ ${total - winEnd} more`, S_DIM))
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
        const atTotal = atMatches.length
        const atCap = MAX_VISIBLE_MENU_ITEMS
        let atWinStart: number
        let atWinEnd: number
        if (atTotal <= atCap) {
          atWinStart = 0
          atWinEnd = atTotal
        } else {
          atWinStart = Math.max(0, Math.min(safeAtIndex - Math.floor(atCap / 2), atTotal - atCap))
          atWinEnd = atWinStart + atCap
        }
        if (atWinStart > 0) {
          frame.push(textToCells(`  ▲ ${atWinStart} more`, S_DIM))
        }
        for (let i = atWinStart; i < atWinEnd; i++) {
          const entry = atMatches[i]
          const sel = i === safeAtIndex
          const cells: Cell[] = []
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          const display = '@' + entry.relPath + (entry.isDirectory ? '/' : '')
          const truncated = truncatePathFromStart(display, maxColWidth)
          cells.push(...textToCells(truncated, sel ? S_PRIMARY_BOLD : S_DIM))
          frame.push(cells)
        }
        if (atWinEnd < atTotal) {
          frame.push(textToCells(`  ▼ ${atTotal - atWinEnd} more`, S_DIM))
        }
      }
    }

    // ── Hardware-cursor park target ────────────────────────────────────
    //
    // The terminal's hardware cursor is hidden app-wide, but macOS
    // terminals (Terminal.app, iTerm2) still draw the IME composition
    // preview (marked text — e.g. pinyin letters mid-composition) AT the
    // hardware cursor position; the app only receives the committed
    // characters. Our cell-diff loop leaves the cursor wherever the last
    // changed cell ended: on a spinner tick that's mid-Working-row, after
    // a keystroke it's one cell PAST the input box's right rail. The IME
    // preview then lands there — pinyin letters overwriting the Working
    // label, or a stray letter outside the box's right border. And since
    // those glyphs never enter our cell grid, the diff (which compares
    // against prevFrameRef, not the screen) doesn't know to erase them.
    //
    // Fix: park the hidden cursor on the visible caret cell at the end of
    // every flush so the composition preview renders where the user is
    // actually typing. The caret is the first S_CURSOR cell in the frame
    // (dialogs render above the input box, so a freeform-dialog caret
    // wins over the main input caret when both exist). When no caret is
    // drawn (caret scrolled out of the windowed input), fall back to the
    // input box's first text column so the preview stays inside the box.
    let caretParkRow = inputFirstLineRow
    let caretParkCol = 5 // 1-based: │ + space + › + space, then text
    scanCaret: for (let r = 0; r < frame.length; r++) {
      let col = 0
      for (const cell of frame[r]!) {
        if (cell.style === S_CURSOR) {
          caretParkRow = r
          caretParkCol = col + 1
          break scanCaret
        }
        col += cell.width
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
    //
    // Post-/clear is also a first-paint (we reset activeRef above) but
    // the banner is gone — we just \x1b[2J'd the viewport — so reserving
    // initialContentRows here would leave a phantom banner-sized empty
    // strip at the top with the frame floating mid-screen. Treat the
    // entire viewport as free blanks instead, so the frame anchors at
    // row 1 with empty space below (the user's "fresh launch minus the
    // banner" expectation).
    if (justClearedRef.current) {
      // When the retained /clear echo rides this render as a commit, the
      // fresh viewport is entirely blank and owned by us — seed the full
      // row budget so the commit path writes the echo at row 1 and floats
      // the frame directly below it. Otherwise reserve only the frame's
      // rows so the empty frame anchors at the top.
      freeBlanksAboveFrameRef.current = didCommitMessages ? termRows : Math.max(0, termRows - nextH)
      frameTop = computeFrameTop(freeBlanksAboveFrameRef.current)
      justClearedRef.current = false
    } else if (isFirstPaint && initialContentRows > 0) {
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
    // Width change: the terminal reflows ALL visible content. Every frame
    // row was written as a hard (non-auto-wrapped) line, so a row of
    // printable length L splits into exactly ceil(L/newW) rows when the
    // terminal narrows and stays 1 row when it widens. onResize captured
    // those lengths (prevFrameRowLensRef), so we can compute the reflowed
    // frame's exact height R. The reflowed remnants do NOT sit at a
    // predictable anchor: with a floating frame (blank rows below it) the
    // split rows push the frame UP past its old top, and on shrink the
    // viewport window itself shifts. The exact post-reflow top is
    //   oldTop - (R - oldFrameH) - max(0, oldTermRows - termRows)
    // (the frame's own split growth, plus the viewport-window shift on a
    // shrink). We erase from the min of that, the last-painted top (covers
    // widen/join and top-anchored reflows), and the bottom-anchored
    // estimate (covers full-viewport narrows where the remnants stay at
    // the bottom). Erasing a few rows higher than the exact remnant top
    // can clip blank rows, never conversation content — split continuations
    // of content rows land below their originals, and scrollback content
    // itself is untouched by reflow.
    const oldTermRows = lastTermRowsRef.current
    const oldTermWidth = lastTermWidthRef.current
    const didResize =
      oldFrameH > 0 &&
      activeRef.current &&
      ((oldTermRows > 0 && oldTermRows !== termRows) || (oldTermWidth > 0 && oldTermWidth !== termWidth))
    if (didResize) {
      const widthChanged = oldTermWidth > 0 && oldTermWidth !== termWidth
      if (widthChanged) {
        const newW = Math.max(1, termWidth)
        const lens = prevFrameRowLensRef.current
        const reflowedFrameH =
          lens.length > 0 ? lens.reduce((sum, len) => sum + Math.max(1, Math.ceil(len / newW)), 0) : oldFrameH
        // The reflowed remnants do NOT sit at a predictable anchor: with
        // a floating frame (blank rows below it) the split rows push the
        // remnants UP past the old top, and on a shrink the viewport
        // window itself shifts. The exact post-reflow top is
        //   oldTop - (R - oldFrameH) - max(0, oldTermRows - termRows)
        // (the frame's own split growth, plus the viewport-window shift
        // on a shrink; split growth above the frame cancels out). Erase
        // from the min of that, the last-painted top (covers widen/join
        // and top-anchored reflows), the bottom-anchored estimate
        // (covers full-viewport narrows whose remnants stay at the
        // bottom). Erasing a few rows higher than the exact remnant top
        // can clip blank rows — split
        // continuations of scrollback content land below their originals,
        // never above, so conversation content is never wiped.
        const bottomAnchoredTop = Math.max(1, termRows - reflowedFrameH + 1)
        const oldTop = lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, oldTermRows - oldFrameH + 1)
        const shiftedTop = oldTop - Math.max(0, reflowedFrameH - oldFrameH) - Math.max(0, oldTermRows - termRows)
        const eraseFrom = Math.max(1, Math.min(oldTop, shiftedTop, bottomAnchoredTop))
        preBuf += `\x1b[${eraseFrom};1H\x1b[J`
      } else {
        // Height-only change: no reflow, but a shrink shifts the viewport
        // window up by the row delta (overflow leaves via scrollback at
        // the top), so the last-rendered top moves up by the same amount;
        // a grow keeps the old rows in place (top-anchored). Same
        // min-of-candidates erase as the width branch, with R = oldFrameH.
        const bottomAnchoredTop = Math.max(1, termRows - oldFrameH + 1)
        const oldTop = lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, oldTermRows - oldFrameH + 1)
        const shiftedTop = oldTop - Math.max(0, oldTermRows - termRows)
        const eraseFrom = Math.max(1, Math.min(oldTop, shiftedTop, bottomAnchoredTop))
        preBuf += `\x1b[${eraseFrom};1H\x1b[J`
      }
      // Resize invalidates the floating-frame state; the next render
      // re-seeds freeBlanks via the first-paint path or commit branch.
      freeBlanksAboveFrameRef.current = 0
      blankRowsAboveFrameRef.current = 0
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
    // Same idempotency story as pendingFreeBlanks above, but for the
    // blank-row-above-frame counter the shrink path may bump and the
    // grow path may consume. See blankRowsAboveFrameRef for the why.
    let pendingBlankRowsAbove = blankRowsAboveFrameRef.current
    const scrollRows = didCommitMessages ? countContentRows(scrollbackContent, termWidth) : 0
    // Top frame rows to force-repaint this render because the MINIMAL-WRITE
    // commit below may have spilled content onto them (see the spill-heal
    // assignment in that branch for the full rationale).
    let healTopFrameRows = 0
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
      // Stranded blanks above the frame (left by a recent big shrink that
      // bottom-anchored the frame, e.g. permission dialog closing). They
      // are visible to the user as a blank gap between earlier scrollback
      // and the frame. Including them in availSpace lets startRow shift
      // upward so the committed content writes INTO those rows instead of
      // skipping over them — eliminating the gap. Without this, the
      // commit writes at termRows-oldFrameH-freeBlanks+1 and the rows
      // between viewport-top and that startRow stay blank forever.
      const blankAbove = blankRowsAboveFrameRef.current
      const availSpace = oldFrameH + freeBlanks + blankAbove
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
          `freeBlanks=${freeBlanks} blankAbove=${blankAbove}`,
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
      // MUST go through FULL-REDRAW. The cell-diff loop further down
      // assumes the on-screen frame still matches prevFrameRef.current
      // — true when frame stayed put, false when it just moved. Without
      // this guard, after a commit the cell-diff would write the new
      // frame at the new frameTop while the old frame's cells are still
      // painted at the old position — leaving a phantom input box at
      // the old row.
      //
      // Two ways the frame can move on commit:
      //   (a) DOWN — freeBlanks (blank rows BELOW frame) was non-zero,
      //       gets partially consumed by `scrollRows`, frame floats
      //       toward the bottom.
      //   (b) UP — frame was bottom-anchored with blankAbove > 0 (e.g.
      //       a slash menu just shrunk), the commit writes scrollback
      //       INTO that blankAbove region (`startRow` shifts up), and
      //       the new frameTop ends up higher than where the frame
      //       currently sits.
      // The older check (`freeBlanks > 0`) only caught case (a). Case (b)
      // fell through to MINIMAL-WRITE, the old bottom-anchored frame was
      // never erased, and the user saw two stacked input boxes. We now
      // compare the just-computed `frameTop` to where the frame was
      // actually painted last (`lastFrameTopRef`) so both directions are
      // covered.
      const oldFrameTopForMoveCheck =
        lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, termRows - oldFrameH + 1)
      const frameMoved = freeBlanksAboveFrameRef.current > 0 || oldFrameTopForMoveCheck !== frameTop
      if (preScrollRows > 0 || frameSizeChanged || frameMoved) {
        // FULL-REDRAW PATH.
        const oldFrameTopForClear =
          lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, termRows - oldFrameH + 1)
        const oldFrameBottomForClear = Math.min(oldFrameTopForClear + oldFrameH - 1, termRows)
        if (preScrollRows > 0) {
          // Erase old frame BEFORE the pre-scroll LFs. After the LFs push
          // N viewport rows into the terminal's real scrollback history,
          // those rows become permanent — no ANSI escape can clear them.
          // If the old frame (with its Working/spinner line) sits at rows
          // that will be pushed above startRow by the scroll, the post-
          // scroll erase loop can't reach them and they persist as ghost
          // "Working..." lines in the user's scrollback. Erasing the
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
        const postContentScrollRows = computePostContentScrollRows(startRow, scrollRows, frameTop, termRows)
        if (postContentScrollRows > 0) {
          // Content taller than the space above the frame leaves its tail
          // in rows the absolute-positioned frame is about to repaint.
          // Move only that overlap into real scrollback first.
          preBuf += `\x1b[${termRows};1H${'\n'.repeat(postContentScrollRows)}`
        }
        // When the frame shrank significantly (e.g. askUser dialog closed),
        // scrollback content only fills a fraction of the space the old frame
        // occupied. Instead of anchoring the frame at the terminal bottom and
        // leaving a visible blank gap between scrollback and frame, place the
        // frame directly below the scrollback content. The remaining blank
        // rows below the frame are recorded in pendingFreeBlanks so
        // subsequent commits can consume them naturally (frame floats down
        // toward the bottom as new content arrives).
        //
        // Skip when blankAbove > 0: those stranded blanks were JUST consumed
        // (startRow shifted up to fill them), and the leftover space is the
        // budget the dialog grew into. Pulling the frame up to sit directly
        // below content would leave that leftover BELOW the frame — the
        // input bar floats in the middle of the viewport with empty rows
        // beneath it. Keep the frame bottom-anchored instead so the gap
        // stays where the dialog was, above the input bar (the familiar
        // bottom position) — visually the input stays at the terminal edge
        // and the gap is between the recent activity and the input row.
        if (preScrollRows === 0 && frameShrunk > 3 && leftoverBlanks === 0 && blankAbove === 0) {
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
        // Spill heal: the content just written occupies scrollRows rows in
        // our geometry, but a line the terminal wraps later than predicted
        // (CJK/ambiguous width disagreement, delayed-wrap phantom row) spills
        // its tail onto the frame's top rows. The cell-diff below compares
        // against prevFrameRef — which still holds the clean frame — so it
        // would rewrite only differing cells and leave the spill's first
        // column and tail painted ("I+ Waiting…interrupt)ke@example.com…").
        // Rows that never change (the ⎿ command preview) wouldn't be
        // rewritten at all, leaving the spilled row fully visible. Force the
        // at-risk top rows through the fresh-redraw branch (full rewrite
        // from col 0 + \x1b[K) so any spill is wiped in the same flush.
        healTopFrameRows = Math.min(nextH, countSpillRiskRows(scrollbackContent, termWidth))
        if (healTopFrameRows > 0) {
          debugLog('chatinput.flush.spill-heal', `rows=${healTopFrameRows}`)
        }
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
      // Commit just wrote `scrollRows` rows of scrollback content at
      // `startRow`, then placed the frame at `frameTop`. Any rows in
      // between are blank (the clear loop wiped them but no content
      // landed there — typically zero, or one when the special-block
      // path squashed the gap). Whatever it is, that's the new
      // contiguous-blank count directly above the frame; older blanks
      // farther up stop being "directly above" once committed content
      // sits between them and the frame, so they no longer interact
      // with the grow path's scroll-only-real-content logic.
      pendingBlankRowsAbove = Math.max(0, frameTop - (startRow + scrollRows))
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
        // Then consume any blank rows DIRECTLY above the frame (left
        // there by a prior large-shrink). The frame can extend up into
        // these rows via the cell-grid repaint without any LF scroll —
        // emitting LFs here would push the blanks into terminal
        // scrollback as a permanent gap (the symptom: a big stretch
        // of empty rows under a `Task()` line whenever sub-agents
        // open multiple permission dialogs in a row). Only the rows
        // BEYOND that blank zone are real content that genuinely needs
        // to be scrolled into history.
        const fromBlankAbove = Math.min(deltaH - absorbed, pendingBlankRowsAbove)
        pendingBlankRowsAbove -= fromBlankAbove
        const rawNeedsScroll = deltaH - absorbed - fromBlankAbove
        // Cap LF count to the rows of REAL CONTENT actually sitting above
        // the old frame. Without this cap, the slash menu's grow path
        // (e.g. nextH=22 in an 18-row terminal) would emit `deltaH - absorbed`
        // LFs at the bottom edge — but every LF beyond `oldTop - 1` is
        // scrolling a phantom row (frame extends upward off-screen) and
        // each phantom scroll pushes a BLANK row into terminal scrollback,
        // leaving visible empty lines between each /command's output.
        // The frame is allowed to clip at the top of the viewport (the
        // computeFrameTop floor is row 1); we don't need to "make room"
        // for the off-screen portion.
        //
        // We further subtract `blankRowsAboveFrameRef.current` because
        // those rows are blank already (a prior shrink left them) and
        // `fromBlankAbove` only consumed up to `deltaH - absorbed` of
        // them; any leftover blank rows above the frame would otherwise
        // be counted as "real content" by the `oldTop - 1` formula.
        const oldTop = lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, termRows - oldFrameH + 1)
        const realContentAboveFrame = Math.max(0, oldTop - 1 - blankRowsAboveFrameRef.current)
        const needsScroll = Math.min(rawNeedsScroll, realContentAboveFrame)
        if (needsScroll > 0) {
          // Erase the old frame before scrolling so that blank rows — not
          // stale prompt/separator cells — get pushed into terminal scrollback.
          // Without this, the `> ▊` prompt line becomes a permanent ghost in
          // scrollback after the select dialog closes.
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
          `delta=${deltaH} absorbed=${absorbed} fromBlankAbove=${fromBlankAbove} ` +
            `scrolled=${needsScroll}${needsScroll !== rawNeedsScroll ? ` (capped from ${rawNeedsScroll}; realContent=${realContentAboveFrame})` : ''} ` +
            `blanks ${freeBlanksAboveFrameRef.current}->${pendingFreeBlanks} ` +
            `blankAbove ${blankRowsAboveFrameRef.current}->${pendingBlankRowsAbove} ` +
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
        // Large-shrink (deltaH > 3) snaps the frame to the bottom; the
        // rows between oldTop and the new frameTop are now blank but
        // never went to terminal scrollback. Track them so the next
        // grow can extend the frame back up via cell-grid repositioning
        // instead of LF auto-scrolls (which would push these blanks
        // into history). Small shrinks keep their freeBlanks below the
        // frame so frameTop stays put — `frameTop - oldTop` is 0 or
        // negative, yielding no contribution.
        if (frameTop > oldTop) {
          pendingBlankRowsAbove += frameTop - oldTop
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
      // writing the full Working line at the NEW frameTop while the
      // OLD Working remains on screen at the OLD position → two
      // visible "Working…" lines.
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
      // Rows flagged by the spill-heal get an empty prevRow so they take
      // the fresh-redraw branch (col-0 rewrite + \x1b[K) regardless of
      // whether their cells differ from prevFrameRef.
      const prevRow = row < healTopFrameRows ? [] : row < prevH ? prevFrame[row] : []
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
        // entire " glyph  Working… (5s · ↑ 2k tokens)" suffix every
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

    // Cursor parking happens at the END of the payload (see below), not
    // here: the target's absolute row depends on the final `frameTop`,
    // which the commit/geometry paths above may still reassign. What
    // matters is that every flush that moves the cursor re-parks it on
    // the caret cell — see the "Hardware-cursor park target" block at
    // frame-build time for why (IME marked text renders at the hardware
    // cursor even while hidden). The visual "input cursor" the user sees
    // remains the inverse-video cell (S_CURSOR) drawn atomically by the
    // cell-diff loop above.

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
      // Empty diff means the current render's frame matches what's
      // already on screen (prevFrameRef). If a deferred flush is
      // pending, it was scheduled by an earlier render whose frame
      // diverged from prevFrameRef — letting it fire now would draw
      // that intermediate state on top of the (already correct)
      // current frame. Concrete case: a fast read tool grew the frame
      // to 7 rows (deferred 8ms), then the result arrived and the
      // next render computed 5 rows — same as last actually-flushed,
      // so this empty-diff branch ran. Without the cancel below, the
      // 8ms deferred fired and painted the stale `● Read / ⎿ Running`
      // live indicator after the read had already finished, leaving
      // it stuck on screen until the next tool call's grow overwrote
      // it. Symptom users reported as "read tool appears then
      // disappears between consecutive reads".
      if (deferredFlushRef.current !== null) {
        clearTimeout(deferredFlushRef.current)
        deferredFlushRef.current = null
        debugLog('chatinput.flush.deferred-cancelled-empty', 'empty diff supersedes stale deferred')
      }
      if (deferredImmediateRef.current !== null) {
        clearImmediate(deferredImmediateRef.current)
        deferredImmediateRef.current = null
      }
      // Still need to apply the pending blank-rows update; the
      // shrink path may have computed a new value.
      if (pendingFreeBlanks !== freeBlanksAboveFrameRef.current) {
        debugLog('chatinput.geom.persist-noop', `blanks ${freeBlanksAboveFrameRef.current}->${pendingFreeBlanks}`)
      }
      freeBlanksAboveFrameRef.current = pendingFreeBlanks
      if (pendingBlankRowsAbove !== blankRowsAboveFrameRef.current) {
        debugLog(
          'chatinput.geom.persist-noop',
          `blankAbove ${blankRowsAboveFrameRef.current}->${pendingBlankRowsAbove}`,
        )
      }
      blankRowsAboveFrameRef.current = pendingBlankRowsAbove
      return
    }

    // Park the hidden hardware cursor on the caret cell as the payload's
    // last action. Appended AFTER the no-op early-return above so a flush
    // that writes nothing stays byte-silent (the cursor is already parked
    // from the previous write); any flush that DID write leaves the
    // cursor mid-frame (mid-Working-row on a spinner tick, one cell past
    // the right rail after a keystroke), which is exactly where macOS
    // terminals would then paint the IME composition preview. One extra
    // CSI per non-empty flush; caretParkRow is -1 only when the frame has
    // no input box at all (nextH=0), in which case there's no caret to
    // anchor and we leave the cursor where the writes left it.
    if (caretParkRow >= 0) {
      buf += `\x1b[${frameTop + caretParkRow};${caretParkCol}H`
    }

    const payload = preBuf + buf + esu
    debugLog(
      'chatinput.flush',
      `bytes=${payload.length} preBufBytes=${preBuf.length} bufBytes=${buf.length} msgsCommitted=${writtenMessageCountRef.current} pendingBlanks=${pendingFreeBlanks} frameTop=${frameTop} nextH=${nextH}`,
    )
    // The rendered frame may contain peer messages, secrets, or the complete
    // egress approval viewer. Log only geometry so debug mode cannot become a
    // second, persistent copy of security-sensitive terminal content.
    debugLog('chatinput.flush.payload', `bytes=${Buffer.byteLength(payload, 'utf8')} rows=${nextH}`)

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
    //   • Commit and resize frames write IMMEDIATELY — they cancel any
    //     pending deferred write since both carry one-shot scroll/erase
    //     operations that must reach the terminal atomically.
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
      // Bytes are now on stdout. Drop the ref so the next render doesn't
      // re-emit them. Setting to '' (rather than slicing scrollbackContent
      // off the front) is safe: any render that mutates the ref between
      // scheduling and firing this throttled doFlush would have entered
      // the immediate structural branch below and replaced the throttle
      // with a fresh payload that includes the new bytes.
      pendingScrollbackRef.current = ''
      if (pendingFreeBlanks !== freeBlanksAboveFrameRef.current) {
        debugLog(
          'chatinput.geom.persist',
          `blanks ${freeBlanksAboveFrameRef.current}->${pendingFreeBlanks} ` + `frameTop=${frameTop} nextH=${nextH}`,
        )
      }
      freeBlanksAboveFrameRef.current = pendingFreeBlanks
      if (pendingBlankRowsAbove !== blankRowsAboveFrameRef.current) {
        debugLog(
          'chatinput.geom.persist',
          `blankAbove ${blankRowsAboveFrameRef.current}->${pendingBlankRowsAbove} ` +
            `frameTop=${frameTop} nextH=${nextH}`,
        )
      }
      blankRowsAboveFrameRef.current = pendingBlankRowsAbove
      // Bump the generation. Any pending deferred-flush macrotask whose
      // captured flushId now differs from this value will short-circuit
      // when it runs — see the schedule path below.
      flushGenRef.current++
    }

    // `hasNewMessages` (not `didCommitMessages`) drives the scheduler:
    // a render that processed new messages — even if every one got
    // buffered by the read-group collapser and produced zero scrollback
    // bytes — is still "real" state change and must paint promptly.
    // Without this, the post-result render of a buffered read tool
    // takes the deferred path (160ms delay) and the previous render's
    // grow-frame (the `● Read(file) / ⎿ Running…` live indicator) sits
    // staged in the deferred timer. It fires later — long after the
    // read actually finished — leaving a stale live indicator on screen
    // until the next read's grow overwrites it. Visible symptom users
    // reported: the `● Read` row "appears then disappears" between
    // consecutive read tools.
    if (didCommitMessages || hasNewMessages || didClearScreen || didResize) {
      // Invalidate a deferred frame as soon as structural output is observed,
      // not only after it reaches stdout. Its timer may already have queued a
      // setImmediate and cleared deferredFlushRef; without this generation
      // bump that stale callback can paint first, clear pending scrollback,
      // or strand a resize erase that cannot be reconstructed next render.
      flushGenRef.current++
      if (deferredFlushRef.current !== null) {
        clearTimeout(deferredFlushRef.current)
        deferredFlushRef.current = null
        debugLog('chatinput.flush.deferred-cancelled', `${didResize ? 'resize' : 'commit'} superseded deferred frame`)
      }
      if (deferredImmediateRef.current !== null) {
        clearImmediate(deferredImmediateRef.current)
        deferredImmediateRef.current = null
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
      // /clear and resize payloads are exempt from the gap throttle: their
      // one-shot erase bytes cannot be re-collected by a later render. In
      // particular, advancing lastTermWidthRef before a throttled resize
      // flush lets the next reasoning/spinner render cancel the only payload
      // that erases xterm.js's reflowed old frame.
      if (!didClearScreen && !didResize && lastFlushTimeRef.current > 0 && dt < MIN_COMMIT_GAP_MS) {
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
      if (deferredImmediateRef.current !== null) {
        clearImmediate(deferredImmediateRef.current)
        deferredImmediateRef.current = null
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
        deferredImmediateRef.current = setImmediate(() => {
          deferredImmediateRef.current = null
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
      flushGenRef.current++ // eslint-disable-line react-hooks/exhaustive-deps -- invalidates callbacks queued before unmount
      if (deferredFlushRef.current !== null) {
        clearTimeout(deferredFlushRef.current)
        deferredFlushRef.current = null
      }
      if (deferredImmediateRef.current !== null) {
        clearImmediate(deferredImmediateRef.current)
        deferredImmediateRef.current = null
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
