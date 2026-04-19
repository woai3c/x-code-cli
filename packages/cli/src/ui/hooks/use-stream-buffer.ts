// @x-code-cli/cli — Streaming-text buffer management
import { useCallback, useRef } from 'react'

import type { DisplayMessage, ModelMessage } from '@x-code-cli/core'

/**
 * Flush thresholds for streaming text. These are tuned for CJK terminals,
 * not arbitrary cosmetic choices:
 *
 *   FLUSH_CHAR_THRESHOLD — bytes to accumulate before a flush. Chosen so that
 *     a paragraph of Chinese (~150-200 CJK chars) flushes together, which
 *     keeps enough on-screen for the user to read while avoiding mid-clause
 *     cuts. Lower values caused flicker; higher values felt laggy.
 *
 *   FLUSH_LINE_THRESHOLD — line count safety net for responses that are
 *     short-line-heavy (bullet lists, code snippets) and would otherwise sit
 *     in the buffer under the char threshold.
 */
const FLUSH_CHAR_THRESHOLD = 300
const FLUSH_LINE_THRESHOLD = 5

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
  /** Accept a text delta from the agent loop. Auto-flushes on boundary triggers. */
  appendTextDelta: (delta: string) => void
  /** Push whatever is in the buffer into `messages` as one assistant text item. */
  flushBuffer: () => void
  /** Discard any buffered text without emitting. */
  resetBuffer: () => void
}

/**
 * Manage the streaming-text buffer.
 *
 * We deliberately DO NOT render streaming text in Ink's dynamic region.
 * Ink + CJK wide characters + Yoga layout don't play well: long Chinese
 * paragraphs get their visual row count miscalculated, so when Ink rewinds
 * to repaint the dynamic region the cursor overshoots and old content
 * splices into new content — merged bullet points, mangled scrollback.
 *
 * Instead, deltas are accumulated in a ref and flushed to `messages`
 * (which renders via Ink <Static> — write-once scrollback). Flushes happen
 * at paragraph breaks, every ~300 chars, and on tool-call / end-of-turn
 * boundaries. The user sees text appear a paragraph at a time rather than
 * char-by-char, which trades some "typewriter" feel for a completely
 * corruption-free terminal.
 */
export function useStreamBuffer(appendMessage: (msg: DisplayMessage) => void): StreamBufferApi {
  const bufferRef = useRef<string>('')

  const flushBuffer = useCallback(() => {
    const text = bufferRef.current
    if (!text) return
    bufferRef.current = ''
    appendMessage({
      id: `stream-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'assistant',
      content: text,
      timestamp: Date.now(),
    })
  }, [appendMessage])

  const appendTextDelta = useCallback(
    (delta: string) => {
      if (!delta) return
      bufferRef.current += delta
      const buf = bufferRef.current
      const shouldFlush =
        buf.includes('\n\n') || buf.length >= FLUSH_CHAR_THRESHOLD || buf.split('\n').length > FLUSH_LINE_THRESHOLD
      if (shouldFlush) flushBuffer()
    },
    [flushBuffer],
  )

  const resetBuffer = useCallback(() => {
    bufferRef.current = ''
  }, [])

  return { appendTextDelta, flushBuffer, resetBuffer }
}
