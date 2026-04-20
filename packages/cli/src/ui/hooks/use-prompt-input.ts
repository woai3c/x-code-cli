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

// When the debounce window closes, a buffer of this size or larger — or
// one containing a newline — is classified as a paste. Smaller buffers
// are treated as normal typing.
const PASTE_SIZE_THRESHOLD = 8

export type PromptKey =
  | 'return'
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
    // Pending backspace count — batched with the debounce timer so rapid
    // IME correction sequences (multiple backspaces + committed char) merge
    // into a single render instead of flashing through intermediate states.
    const pendingBackspacesRef = { count: 0 }

    const flushBackspaces = (): void => {
      const n = pendingBackspacesRef.count
      if (n === 0) return
      pendingBackspacesRef.count = 0
      for (let i = 0; i < n; i++) {
        handlersRef.current.onKey('backspace')
      }
    }

    const flushPending = (): void => {
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = null
      }
      // Flush queued backspaces FIRST, then text — this is the order they
      // arrived (IME: backspaces to delete pinyin, then committed chars).
      flushBackspaces()
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

    // Queue text into the debounce buffer and (re)start the flush timer.
    const queueText = (data: string): void => {
      pendingTextRef.current += data
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
      pendingTimerRef.current = setTimeout(flushPending, PASTE_DEBOUNCE_MS)
    }

    const queueBackspace = (): void => {
      pendingBackspacesRef.count++
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
      pendingTimerRef.current = setTimeout(flushPending, PASTE_DEBOUNCE_MS)
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
        // Queue backspace with the same debounce timer so IME correction
        // sequences (rapid backspaces + committed char) batch into one render.
        queueBackspace()
        return
      }
      if (data === '\t') return dispatchKey('tab')
      if (data === '\x1b') return dispatchKey('escape')

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

      // Unknown escape sequences — drop so they don't show up as literal
      // "\x1b[…" text in the input.
      if (data.startsWith('\x1b')) return

      // Printable text — buffer with debounce so a paste burst batches
      // into a single onPaste call.
      queueText(data)
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
