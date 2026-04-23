// @x-code-cli/cli — Streaming-text buffer management
//
// Deltas accumulate in `bufferRef`. After every delta we look for the
// latest `\n\n` (paragraph break) position whose prefix does NOT end
// inside an open multi-line markdown structure (table or code fence),
// and commit everything up to that point as a `streamingChunk` message.
// Everything after the cut point stays in the buffer, merging with
// subsequent deltas until the next safe boundary is found (or the
// stream ends and `flushBuffer()` force-drains the remainder).
//
// Why the open-block check: marked's GFM table grammar requires the
// header + separator + rows to land in the SAME lexer pass. Committing
// `| a | b |\n` on its own parses as a paragraph; the user sees raw
// pipes. So paragraphs stream out (good UX — Claude Code does the same
// via live React re-renders), but once a table row or code fence has
// opened in the buffer, we hold everything until the structure closes.
//
// A simpler "buffer the whole response" approach kills streaming UX
// entirely. A simpler "emit per-newline" approach breaks tables. This
// safe-boundary cut is the middle path.
import { useCallback, useRef } from 'react'

import type { DisplayMessage, ModelMessage } from '@x-code-cli/core'
import { debugLog } from '@x-code-cli/core'

/** Does `text` end inside an open multi-line markdown structure that
 *  the renderer needs whole to format correctly?
 *
 *  - Code fence: odd number of ``` at start-of-line = fence is open.
 *  - Table: the IMMEDIATELY-LAST line (not past blanks) starts with
 *    `|`. A blank line after the rows terminates the table in GFM,
 *    so once `...|\n\n` arrives the table is closed. */
function hasOpenMarkdownBlock(text: string): boolean {
  const fences = text.match(/^```/gm)
  if (fences && fences.length % 2 !== 0) return true

  const lines = text.split('\n')
  // Strip the ONE trailing '' that `split('\n')` produces for text
  // ending in a newline — that's a split artifact, not a real blank line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return false

  const lastLine = lines[lines.length - 1]
  if (lastLine.trim() === '') return false
  if (lastLine.trimStart().startsWith('|')) return true
  return false
}

/** Return the position just past the LAST safe `\n\n` in `text`, or -1
 *  if none exists. "Safe" means the prefix up to that `\n\n` doesn't
 *  end inside an open multi-line block — committing that prefix gives
 *  the markdown renderer something it can fully format. */
function findSafeBoundary(text: string): number {
  let lastSafe = -1
  let scan = 0
  while (scan < text.length) {
    const found = text.indexOf('\n\n', scan)
    if (found < 0) break
    const prefix = text.slice(0, found + 2)
    if (!hasOpenMarkdownBlock(prefix)) {
      lastSafe = found + 2
    }
    scan = found + 1
  }
  return lastSafe
}

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
  /** Accumulating buffer — holds everything since the last safe-boundary
   *  commit (or last flush). */
  const bufferRef = useRef<string>('')

  const appendTextDelta = useCallback(
    (delta: string) => {
      if (!delta) return
      debugLog('buffer.append', delta)
      bufferRef.current += delta
      const boundary = findSafeBoundary(bufferRef.current)
      if (boundary > 0) {
        const chunk = bufferRef.current.slice(0, boundary)
        bufferRef.current = bufferRef.current.slice(boundary)
        debugLog('buffer.commit', `chars=${chunk.length}`)
        appendMessage(makeStreamChunkMessage(chunk))
      }
    },
    [appendMessage],
  )

  const flushBuffer = useCallback(() => {
    // End-of-turn / tool-call boundary — no more deltas are coming, so
    // drain whatever's left (even if it's an unclosed table, there's
    // nothing more to hold for).
    const content = bufferRef.current
    if (!content) return
    bufferRef.current = ''
    debugLog('buffer.commit', `chars=${content.length} (flush)`)
    appendMessage(makeStreamChunkMessage(content))
  }, [appendMessage])

  const resetBuffer = useCallback(() => {
    bufferRef.current = ''
  }, [])

  return { appendTextDelta, flushBuffer, resetBuffer }
}
