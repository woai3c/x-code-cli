// @x-code-cli/cli — Streaming-text buffer management
//
// Two-stage buffering:
//
//   1. `bufferRef` — active, UNTERMINATED text. Deltas append here; as
//      soon as the buffer contains a `\n`, the newly-completed line(s)
//      move into the pending batch. The trailing partial line stays put
//      until it's either completed by a later delta or `flushBuffer()`
//      is called.
//
//   2. `pendingRef` — complete lines waiting for the COMMIT_DEBOUNCE_MS
//      timer. The FIRST line to arrive arms the timer; further lines in
//      the window accumulate without re-arming. When the timer fires,
//      the whole batch emits as ONE `streamingChunk: true` message.
//
// Why batch: each streamingChunk commit triggers ChatInput's useEffect
// to `eraseRegion + writeMessageToStdout + redraw frame` in one atomic
// payload. Even though each payload is BSU/ESU-wrapped, the TERMINAL
// still has to physically scroll when new content pushes past the
// bottom row — and that scroll is visible as a brief "flash" on
// Windows Terminal. Committing every line separately gave roughly one
// flash every 1-2 seconds (observed in the field as "渲染几行就会闪
// 烁一下"). Bundling lines into 100ms batches cuts that rate by 3-5×
// with no perceptible delay added to the scrollback progress.
//
// Immediate flushes (not debounced):
//   - `flushBuffer()` — tool-call / end-of-turn boundary. User expects
//     to see accumulated text BEFORE the next transition UI appears.
//   - Paragraph break `\n\n` in the stream — natural boundary, makes
//     long outputs feel "chunky" rather than trickle-by-trickle.
import { useCallback, useRef } from 'react'

import type { DisplayMessage, ModelMessage } from '@x-code-cli/core'
import { debugLog } from '@x-code-cli/core'

/** Debounce window for batched streamingChunk commits. 100ms is below
 *  human flicker-detection threshold (we perceive motion as continuous
 *  around 60-80ms cadence); anything longer makes the user wait visibly. */
const COMMIT_DEBOUNCE_MS = 100

/**
 * Safety net: extract the text from the most recent assistant message in
 * the loop state. Used to display a reply when the stream produced no
 * text-delta events but the final response message still carries text
 * (e.g. some reasoning-model providers put everything in one final part).
 */
export function extractLastAssistantText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    const content = msg.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    const parts: string[] = []
    for (const part of content as Array<{ type: string; text?: string }>) {
      if (part.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text)
      }
    }
    return parts.join('')
  }
  return ''
}

export interface StreamBufferApi {
  /** Accept a text delta from the agent loop. Emits a streamingChunk
   *  message for every complete line (`\n`-terminated substring) in the
   *  rolling buffer; the trailing partial line stays buffered. */
  appendTextDelta: (delta: string) => void
  /** Emit any remaining partial line as a final streamingChunk. Called
   *  on tool-call / end-of-turn boundaries to drain the buffer. */
  flushBuffer: () => void
  /** Discard any buffered text without emitting. */
  resetBuffer: () => void
}

let streamChunkSeq = 0

function makeStreamChunkMessage(content: string): DisplayMessage {
  return {
    id: `stream-${Date.now()}-${streamChunkSeq++}`,
    role: 'assistant',
    content,
    streamingChunk: true,
    timestamp: Date.now(),
  }
}

export function useStreamBuffer(appendMessage: (msg: DisplayMessage) => void): StreamBufferApi {
  /** Active buffer — text not yet terminated by `\n`. */
  const bufferRef = useRef<string>('')
  /** Pending batch — complete lines waiting for the debounce timer. */
  const pendingRef = useRef<string>('')
  /** Debounce timer handle. `null` = no timer armed. */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Commit `pendingRef` as a single streamingChunk. Clears the timer
   *  so the next line re-arms from scratch. Safe to call even when
   *  the batch is empty (no-op). */
  const drainPending = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const batch = pendingRef.current
    if (!batch) return
    pendingRef.current = ''
    debugLog('buffer.commit', `lines=${batch.split('\n').length - 1}`)
    appendMessage(makeStreamChunkMessage(batch))
  }, [appendMessage])

  const appendTextDelta = useCallback(
    (delta: string) => {
      if (!delta) return
      debugLog('buffer.append', delta)
      bufferRef.current += delta

      // Move every complete line from active buffer → pending batch.
      let hasParagraphBreak = false
      while (true) {
        const nl = bufferRef.current.indexOf('\n')
        if (nl < 0) break
        const line = bufferRef.current.slice(0, nl + 1)
        bufferRef.current = bufferRef.current.slice(nl + 1)
        pendingRef.current += line
        // A completely-empty line = paragraph break. Flush immediately
        // on it so the user sees a natural "paragraph finished" beat
        // before we go back to 100ms-batched accumulation.
        if (line === '\n') hasParagraphBreak = true
      }

      if (hasParagraphBreak) {
        drainPending()
        return
      }

      // Arm the debounce timer if there's something pending AND no
      // timer is already running. Subsequent deltas within the window
      // just pile more lines onto the batch.
      if (pendingRef.current && timerRef.current === null) {
        timerRef.current = setTimeout(drainPending, COMMIT_DEBOUNCE_MS)
      }
    },
    [drainPending],
  )

  const flushBuffer = useCallback(() => {
    // Fold the trailing partial line (if any) into the pending batch,
    // then drain synchronously. Called on tool-call / turn-end so the
    // user sees the final bit before the next UI transition.
    const tail = bufferRef.current
    if (tail) {
      bufferRef.current = ''
      pendingRef.current += tail.endsWith('\n') ? tail : tail + '\n'
      debugLog('buffer.flush-tail', tail)
    }
    drainPending()
  }, [drainPending])

  const resetBuffer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    bufferRef.current = ''
    pendingRef.current = ''
  }, [])

  return { appendTextDelta, flushBuffer, resetBuffer }
}
