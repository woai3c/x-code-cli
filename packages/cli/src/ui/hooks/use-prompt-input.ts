// @x-code-cli/cli — Custom stdin input hook with bracketed-paste support
// and a time-window fallback for terminals that don't enable it.
//
// Two layered paste-detection strategies:
//
//   1. **Bracketed paste mode** (primary, fast path)
//      We send `\x1b[?2004h` on mount. Terminals that support it wrap every
//      paste in `\x1b[200~ … \x1b[201~`. The state machine below detects
//      these markers and emits the payload as a single `onPaste` call
//      regardless of how Node chunks the stdin bytes.
//
//   2. **Debounce fallback** (for Windows Terminal / PowerShell / tmux /
//      ConEmu / VS Code integrated terminal — any environment where
//      bracketed paste is NOT honored)
//      When no paste markers are seen, printable text is accumulated into
//      a buffer and a short (PASTE_DEBOUNCE_MS) timer is (re)set on every
//      stdin event. Human typing has >100 ms between keystrokes so each
//      character flushes on its own timer, but a paste burst arrives in
//      sub-millisecond bursts — the buffer fills in one tick and flushes
//      as a single atomic chunk, which then gets routed to `onPaste` by
//      the size heuristic below. This is the same approach Claude Code
//      takes in its `usePasteHandler` hook.
//
// Special keys (Enter, backspace, arrows, tab, escape, Ctrl+C) always
// force-flush any pending text before they dispatch, so the pasted content
// is committed BEFORE the key that acts on it.
import { useEffect, useRef } from 'react'

import { useStdin } from 'ink'

const ENABLE_BRACKETED_PASTE = '\x1b[?2004h'
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l'
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

// Time window for batching rapid stdin bursts. 30 ms is well below human
// typing cadence (~100–200 ms between keys) but far above the sub-ms gaps
// between characters of a paste, so it cleanly separates the two.
const PASTE_DEBOUNCE_MS = 30

// Maximum time a keystroke is allowed to sit in the debounce buffer before
// it MUST be flushed — even if more events keep arriving. Without this
// cap, holding a key (OS repeat at ~33 ms / 30 Hz) reset the debounce
// timer on every repeat event, so nothing ever flushed until the user
// released the key — the user felt a freeze / one-shot catch-up on
// release. 50 ms is below human "instant" perception threshold but high
// enough that a sub-ms paste burst still coalesces.
const MAX_BATCH_MS = 50

// Any stdin chunk >= this size (or containing a newline) is suspected
// to be a paste and goes through the debounce buffer so consecutive
// fragments merge into a single onPaste event. Chunks below this size
// are treated as normal typing and dispatched IMMEDIATELY — this
// matches Claude Code's PASTE_THRESHOLD (800) approach. Holding down
// a key produces single-char stdin events; with the old low threshold
// (8) every keystroke went through the debounce and felt laggy.
const PASTE_SIZE_THRESHOLD = 32

export type PromptKey =
  | 'return'
  | 'newline'
  | 'backspace'
  | 'delete'
  | 'tab'
  | 'escape'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'

export interface PromptInputHandlers {
  /** Normal typed text (may be multi-char if the terminal batched a burst). */
  onText: (text: string) => void
  /** Atomic paste — always the full contents of one paste event. */
  onPaste: (content: string) => void
  /** Special keys. */
  onKey: (key: PromptKey) => void
  /** Called on Ctrl+C — should trigger clean Ink unmount via useApp().exit(). */
  onInterrupt: () => void
  /** Turn the listener on/off without unmounting the component. */
  enabled: boolean
}

export function usePromptInput({ onText, onPaste, onKey, onInterrupt, enabled }: PromptInputHandlers): void {
  const { stdin, setRawMode } = useStdin()

  // Stash handlers in a ref so the effect doesn't re-subscribe on every
  // render — each render produces a fresh callback closure, but we want a
  // stable subscription that always calls through to the latest handlers.
  //
  // The assignment has to happen inside a useEffect (not during render)
  // because assigning to ref.current during render is flagged by React's
  // concurrent-mode rules — it could cause Strict Mode double-invocation
  // to see mismatched state. An effect with no dep array runs after every
  // commit, which is exactly the "latest value" semantics we want.
  const handlersRef = useRef({ onText, onPaste, onKey, onInterrupt })
  useEffect(() => {
    handlersRef.current = { onText, onPaste, onKey, onInterrupt }
  })

  // Bracketed-paste state persists across stdin chunks so we can stitch a
  // paste that arrives in multiple data events.
  const pasteStateRef = useRef<{ inPaste: boolean; buffer: string; timer: NodeJS.Timeout | null }>({
    inPaste: false,
    buffer: '',
    timer: null,
  })

  // Debounce buffer + timer for the fallback path.
  const pendingTextRef = useRef<string>('')
  const pendingTimerRef = useRef<NodeJS.Timeout | null>(null)
  /** Wall-clock time (ms since epoch) when the currently-buffered burst
   *  started. 0 means no burst in progress. Used to cap the debounce
   *  delay at MAX_BATCH_MS so sustained key-repeat events flush
   *  periodically instead of indefinitely resetting the timer. */
  const pendingBurstStartRef = useRef<number>(0)

  // Ctrl+C must work even when the input is disabled (e.g. during loading).
  // We always listen on stdin for \x03 and route it to onInterrupt.
  // When enabled=false, all other input is ignored.
  useEffect(() => {
    if (!enabled) {
      // Minimal listener: only Ctrl+C, ignore everything else.
      setRawMode(true)
      const handleCtrlC = (data: Buffer | string): void => {
        const chunk = typeof data === 'string' ? data : data.toString('utf8')
        if (chunk.includes('\x03')) {
          handlersRef.current.onInterrupt()
        }
      }
      stdin.on('data', handleCtrlC)
      return () => {
        stdin.off('data', handleCtrlC)
        setRawMode(false)
      }
    }

    setRawMode(true)
    process.stdout.write(ENABLE_BRACKETED_PASTE)
    const useBracketedPaste = true

    // ── Flush the debounce buffer ──
    //
    // Emits one onPaste (or onText for tiny chunks) with all the text that
    // accumulated during the last burst. We normalize line endings to `\n`
    // here because Windows terminals tend to send `\r` or `\r\n` for
    // pasted newlines; downstream code and the terminal's line-rendering
    // both want `\n`. A bare `\r` in a terminal print means "carriage
    // return" and overwrites previous characters, which was producing
    // the "optimizations Claude Managed Agents is currently in beta"
    // splicing pattern in echoed pastes.
    const flushPending = (): void => {
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = null
      }
      pendingBurstStartRef.current = 0
      const raw = pendingTextRef.current
      if (!raw) return
      pendingTextRef.current = ''
      const text = raw.replace(/\r\n?/g, '\n')

      const looksLikePaste = text.length >= PASTE_SIZE_THRESHOLD || text.includes('\n')
      if (looksLikePaste) {
        handlersRef.current.onPaste(text)
      } else {
        handlersRef.current.onText(text)
      }
    }

    // Compute the next timer delay — debounce from the most recent event,
    // but capped so the buffer can't sit for more than MAX_BATCH_MS after
    // its first character (otherwise a held key perpetually resets the
    // debounce and never flushes until release).
    const armFlushTimer = (): void => {
      if (pendingBurstStartRef.current === 0) {
        pendingBurstStartRef.current = Date.now()
      }
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
      const elapsed = Date.now() - pendingBurstStartRef.current
      const remaining = Math.max(0, MAX_BATCH_MS - elapsed)
      const delay = Math.min(PASTE_DEBOUNCE_MS, remaining)
      pendingTimerRef.current = setTimeout(flushPending, delay)
    }

    // Queue text into the debounce buffer and (re)start the flush timer.
    // Only used for chunks large enough to look like a paste; normal
    // typing bypasses the buffer entirely (see processNormalInput).
    const queueText = (data: string): void => {
      pendingTextRef.current += data
      armFlushTimer()
    }

    // Dispatch a special key. Always force-flushes pending text first so
    // that, e.g., Enter commits the previously-buffered input BEFORE acting
    // on the key.
    const dispatchKey = (key: PromptKey): void => {
      flushPending()
      handlersRef.current.onKey(key)
    }

    // Parse a chunk of non-paste input. Returns immediately for recognized
    // special keys; otherwise buffers as text.
    const processNormalInput = (data: string): void => {
      if (data.length === 0) return

      if (data === '\r' || data === '\n') return dispatchKey('return')
      if (data === '\x7f' || data === '\b') {
        // If the debounce buffer has pending text, absorb the backspace by
        // trimming the buffer instead of flushing + dispatching.
        if (pendingTextRef.current.length > 0) {
          pendingTextRef.current = pendingTextRef.current.slice(0, -1)
          return
        }
        // Dispatch immediately so holding backspace feels responsive
        // (previously queueBackspace sat in the debounce buffer and
        // the timer kept resetting on every repeat event, freezing
        // the delete visually until the key was released).
        dispatchKey('backspace')
        return
      }
      if (data === '\t') return dispatchKey('tab')

      // Alt/Option+Enter → insert a literal newline. Most terminals that
      // distinguish Alt-modified keys send the prefix-ESC form: `\x1b\r`
      // (Alt+Enter on Windows Terminal / Linux xterm / iTerm2 with
      // "Esc+" Option mapping) or `\x1b\n` on a few. The CSI forms below
      // come from modifyOtherKeys / kitty keyboard protocol — not
      // enabled by default anywhere we target, but if a power user has
      // turned them on we honor them too.
      //   xterm modifyOtherKeys: ESC [27;3;13~ (Alt+Enter), ESC [27;5;13~ (Ctrl+Enter)
      //   kitty CSI-u:           ESC [13;3u   (Alt+Enter), ESC [13;5u   (Ctrl+Enter)
      // Plain Ctrl+Enter is indistinguishable from Enter on stock
      // terminals; the kitty/modifyOtherKeys CSI forms are the only way
      // it can reach us, so they're treated identically to Alt+Enter.
      if (data === '\x1b\r' || data === '\x1b\n') return dispatchKey('newline')
      if (data === '\x1b[27;3;13~' || data === '\x1b[27;5;13~') return dispatchKey('newline')
      if (data === '\x1b[13;3u' || data === '\x1b[13;5u') return dispatchKey('newline')

      if (data === '\x1b' || data === '\x1b\x1b') return dispatchKey('escape')

      // Ctrl+C — flush and call the interrupt handler (which triggers Ink's
      // clean unmount via useApp().exit()). We do NOT send SIGINT because on
      // Windows, signal-exit re-raises it after running callbacks, causing
      // the process to exit with code 1 before our gracefulShutdown runs.
      if (data === '\x03') {
        flushPending()
        handlersRef.current.onInterrupt()
        return
      }

      // ANSI arrow keys and navigation (exact matches)
      if (data === '\x1b[A') return dispatchKey('up')
      if (data === '\x1b[B') return dispatchKey('down')
      if (data === '\x1b[C') return dispatchKey('right')
      if (data === '\x1b[D') return dispatchKey('left')
      if (data === '\x1b[H' || data === '\x1b[1~') return dispatchKey('home')
      if (data === '\x1b[F' || data === '\x1b[4~') return dispatchKey('end')
      if (data === '\x1b[3~') return dispatchKey('delete')
      if (data === '\x1b[5~') return dispatchKey('pageup')
      if (data === '\x1b[6~') return dispatchKey('pagedown')
      // (Mode-cycle key bindings — Shift+Tab `\x1b[Z` and the Alt+M
      // `\x1b m` Windows fallback — were removed; mode switching is
      // driven exclusively by slash commands now. See ChatInput hint
      // text and the /plan handler in App.tsx.)

      // Unknown escape sequences — drop so they don't show up as literal
      // "\x1b[…" text in the input.
      if (data.startsWith('\x1b')) return

      // Printable text. Two paths:
      //  - Large or multi-line chunks go through the debounce buffer so
      //    a paste split across several stdin events (non-bracketed
      //    terminals sometimes fragment) merges into one onPaste call.
      //  - Small single-keystroke chunks dispatch IMMEDIATELY. Holding
      //    down a key fires stdin events at ~30 Hz and debouncing each
      //    one made the input feel frozen / stutter. Claude Code does
      //    the same (their usePasteHandler bypasses the paste buffer
      //    for input.length < PASTE_THRESHOLD).
      if (data.length >= PASTE_SIZE_THRESHOLD || data.includes('\n')) {
        queueText(data)
      } else {
        // Preserve ordering: drain any already-buffered text first.
        flushPending()
        handlersRef.current.onText(data)
      }
    }

    // Top-level stdin data handler. Walks the chunk looking for bracketed
    // paste markers; anything outside a paste block goes through
    // processNormalInput (and thus the debounce buffer for text).
    const handleData = (data: Buffer | string): void => {
      let chunk = typeof data === 'string' ? data : data.toString('utf8')

      while (chunk.length > 0) {
        const state = pasteStateRef.current

        if (state.inPaste) {
          const endIdx = chunk.indexOf(PASTE_END)
          if (endIdx === -1) {
            state.buffer += chunk
            return
          }
          state.buffer += chunk.slice(0, endIdx)
          // Clear the safety timeout
          if (state.timer) {
            clearTimeout(state.timer)
            state.timer = null
          }
          // Normalize line endings for the same reason flushPending does —
          // bare `\r` in pasted content acts as carriage return and
          // overwrites previous characters when later echoed to the
          // terminal.
          const content = state.buffer.replace(/\r\n?/g, '\n')
          state.buffer = ''
          state.inPaste = false
          // Bracketed paste trumps the debounce buffer — flush pending
          // text first so it doesn't get mixed in with the paste payload.
          flushPending()
          handlersRef.current.onPaste(content)
          chunk = chunk.slice(endIdx + PASTE_END.length)
          continue
        }

        const startIdx = chunk.indexOf(PASTE_START)
        if (startIdx === -1) {
          processNormalInput(chunk)
          return
        }
        if (startIdx > 0) {
          processNormalInput(chunk.slice(0, startIdx))
        }
        // Flush any pending typing before entering paste mode so we don't
        // concatenate typed chars with the paste content.
        flushPending()
        chunk = chunk.slice(startIdx + PASTE_START.length)
        state.inPaste = true
        // Safety timeout: if PASTE_END is never received (ConHost bug),
        // force-flush the buffer after 1 second so input doesn't freeze.
        state.timer = setTimeout(() => {
          const s = pasteStateRef.current
          if (!s.inPaste) return
          const content = s.buffer.replace(/\r\n?/g, '\n')
          s.buffer = ''
          s.inPaste = false
          s.timer = null
          if (content) {
            handlersRef.current.onPaste(content)
          }
        }, 1000)
      }
    }

    stdin.on('data', handleData)
    return () => {
      flushPending()
      // Clear paste safety timeout
      const ps = pasteStateRef.current
      if (ps.timer) {
        clearTimeout(ps.timer)
        ps.timer = null
      }
      ps.inPaste = false
      ps.buffer = ''
      stdin.off('data', handleData)
      if (useBracketedPaste) {
        process.stdout.write(DISABLE_BRACKETED_PASTE)
      }
      setRawMode(false)
    }
  }, [enabled, stdin, setRawMode])
}
