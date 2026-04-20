// @x-code-cli/cli — Streaming-text buffer management
//
// Each time the model emits text deltas, we accumulate them in a ref.
// As soon as a complete line (ends with `\n`) is available in the buffer,
// that line is emitted as a `streamingChunk: true` assistant message —
// which ChatInput writes DIRECTLY to terminal scrollback (no trailing
// blank line, single `\n` separator so consecutive chunks join into one
// paragraph). The bottom cell buffer (spinner + input + separators) is
// NEVER touched by streaming text, so its rows don't shift position as
// the output grows — exactly the stable Claude-Code-style behaviour.
//
// We commit the remaining unterminated tail only when the stream ends
// or a tool call interrupts it (explicit `flushBuffer()`).
import { useCallback, useRef } from 'react'

import type { DisplayMessage, ModelMessage } from '@x-code-cli/core'
import { debugLog } from '@x-code-cli/core'

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
  const bufferRef = useRef<string>('')

  const appendTextDelta = useCallback(
    (delta: string) => {
      if (!delta) return
      debugLog('buffer.append', delta)
      bufferRef.current += delta

      // Emit every complete line in the buffer. Each is written straight
      // to scrollback by ChatInput (streamingChunk = true → no trailing
      // blank line, so lines of the same paragraph join).
      while (true) {
        const nl = bufferRef.current.indexOf('\n')
        if (nl < 0) break
        const line = bufferRef.current.slice(0, nl + 1) // includes the \n
        bufferRef.current = bufferRef.current.slice(nl + 1)
        debugLog('buffer.emit-line', line)
        appendMessage(makeStreamChunkMessage(line))
      }
    },
    [appendMessage],
  )

  const flushBuffer = useCallback(() => {
    const tail = bufferRef.current
    if (!tail) return
    bufferRef.current = ''
    debugLog('buffer.flush-tail', tail)
    // Emit the remaining partial line. Append a newline so the cursor
    // lands at column 0 for whatever comes next (tool call indicator /
    // next turn's content / input box repaint).
    appendMessage(makeStreamChunkMessage(tail.endsWith('\n') ? tail : tail + '\n'))
  }, [appendMessage])

  const resetBuffer = useCallback(() => {
    bufferRef.current = ''
  }, [])

  return { appendTextDelta, flushBuffer, resetBuffer }
}
