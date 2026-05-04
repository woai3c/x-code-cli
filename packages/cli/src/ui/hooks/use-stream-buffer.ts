// @x-code-cli/cli — Streaming-text buffer management
//
// Deltas accumulate in `bufferRef`. After every delta we look for the
// latest single-`\n` position whose prefix does NOT end inside an open
// multi-line markdown structure (table, code fence, list, blockquote),
// and commit everything up to that point as a `streamingChunk` message.
// Everything after the cut point stays in the buffer, merging with
// subsequent deltas until the next safe boundary is found (or the
// stream ends and `flushBuffer()` force-drains the remainder).
//
// Why per-line (not per-paragraph) cuts: paragraph-break (`\n\n`) cuts
// produce a "block-by-block" reveal — readable but visibly chunky on
// long answers. Cutting at every safe `\n` lands content line-by-line,
// which matches what Claude Code does (it re-renders the whole text
// each delta and only HIDES the in-progress trailing line until the
// next `\n` arrives). We can't re-render arbitrary scrollback once
// committed, so per-line cuts are the closest we get within an append-
// only architecture.
//
// Why the open-block check: marked's lexer needs the FULL structure in
// one parse pass for tables, code fences, list runs, and blockquotes —
// committing `| a | b |\n` on its own parses as a paragraph (raw pipes
// in the rendered output); committing `- item 1\n` then `- item 2\n`
// separately parses as TWO 1-item lists with a vertical gap between
// them instead of one cohesive list. So the boundary check holds the
// buffer as long as the LAST line still looks like part of an open
// structure, and only releases when a non-continuation line arrives
// (heading, plain paragraph, or a blank line that explicitly closes
// the block).
//
// A simpler "buffer the whole response" approach kills streaming UX
// entirely. A simpler "commit at every \n unconditionally" approach
// breaks tables and lists. This guarded per-line cut is the middle
// path.
//
// On top of the safe-boundary cut we COALESCE successive commits inside
// a small time window into a single appendMessage call. The model often
// emits 2-3 short paragraphs back-to-back ("...整理：\n\n", "---\n\n",
// "## 标题\n\n"). Without coalescing each one becomes its own setState →
// ChatInput render → BSU/ESU [J+redraw payload, and on terminals that
// don't perfectly atomize DEC 2026 sync (notably xterm.js inside VS Code)
// several large redraws inside one vsync window manifest as visible
// flicker. A ~32ms always-defer window (≈2 frames @ 60Hz) is shorter than
// typical 80-200ms inter-delta gaps from the provider, well below human
// perception, and lets every commit arriving in the same window ride out
// in one React render → one stdout write.
import { useCallback, useRef } from 'react'

import type { DisplayMessage, ModelMessage } from '@x-code-cli/core'
import { debugLog } from '@x-code-cli/core'

/** Does `text` end inside an open multi-line markdown structure that
 *  the renderer needs whole to format correctly?
 *
 *  We hold ONLY the structures whose visual rendering genuinely breaks
 *  when split mid-block:
 *
 *  - Code fence: odd number of ``` at start-of-line = fence is open.
 *    Cutting inside an open fence would render the partial code as
 *    plain prose and lose the monospace block context.
 *  - Table: last non-empty line starts with `|`. GFM tables require
 *    header + separator + rows in ONE lexer pass; cutting mid-table
 *    renders incomplete rows as raw `| a | b |` text.
 *
 *  Lists (ordered, unordered) and blockquotes are deliberately NOT held
 *  here — committing them line-by-line still renders identically to
 *  the whole-block version. Each `- item N\n` parsed standalone becomes
 *  a 1-item list rendering as `• item N\n`, and concatenating those is
 *  the same byte stream as parsing the full list (`- a\n- b\n` →
 *  `• a\n• b\n`). The same holds for `> line\n` quotes (each parses
 *  to `▎ line\n`). The minor cost — a multi-line list item with a
 *  lazy continuation gets the continuation rendered as a separate
 *  indented paragraph — is rare in AI output and the streaming-feel
 *  win is large: list items appear one at a time as the model emits
 *  them instead of popping in as a finished block. */
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

/** Return the position just past the LATEST safe single-`\n` in `text`,
 *  or -1 if none exists. "Safe" means the prefix up to that `\n` doesn't
 *  end inside an open multi-line block — committing that prefix gives
 *  the markdown renderer something it can fully format.
 *
 *  Scans backward from the end so the first hit IS the latest safe cut
 *  (no need to walk every newline tracking a maximum). */
function findSafeBoundary(text: string): number {
  let scan = text.length
  while (scan > 0) {
    const found = text.lastIndexOf('\n', scan - 1)
    if (found < 0) return -1
    const prefix = text.slice(0, found + 1)
    if (!hasOpenMarkdownBlock(prefix)) {
      return found + 1
    }
    scan = found
  }
  return -1
}

// When a code fence is open, the normal `\n\n` safe-boundary logic holds
// everything until the fence closes. For long code blocks (100+ lines) this
// produces a single massive commit whose pre-scroll `\n`s leave visible blank
// rows in the terminal scrollback. To avoid that, we force a line-based commit
// once the buffer exceeds this threshold while inside an open code fence.
// The markdown renderer's `code` token handler outputs raw text, so splitting
// inside a fence is visually identical — the only difference is that the first
// chunk carries the opening ``` (parsed as a `code` token by marked.lexer) and
// subsequent chunks are plain text lines (rendered as-is by the fallback path).
const CODE_FENCE_COMMIT_THRESHOLD = 800

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

/** Always-defer window for coalescing commits. The first commit in a
 *  quiet period arms a timer; any further commits arriving before it
 *  fires join the same emit. 150ms is below the ~200ms human-perception
 *  threshold for "stuttering" but long enough to absorb most paragraph +
 *  separator + heading bursts (which usually arrive 30-150ms apart
 *  around section boundaries). Cuts the rate of large terminal-frame
 *  redraws roughly in half versus the prior 48ms window — the live
 *  scrollback area "shakes" half as often during streaming, at the cost
 *  of paragraphs appearing in slightly chunkier batches. */
const COMMIT_BATCH_MS = 150

export function useStreamBuffer(appendMessage: (msg: DisplayMessage) => void): StreamBufferApi {
  /** Accumulating buffer — holds everything since the last safe-boundary
   *  commit (or last flush). */
  const bufferRef = useRef<string>('')
  /** Safe-boundary chunks waiting to be coalesced into one appendMessage
   *  call. Cleared when the deferred timer fires (or flushBuffer drains). */
  const pendingChunksRef = useRef<string[]>([])
  /** Timer that fires the deferred emit. Null when nothing is pending. */
  const emitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const drainPending = useCallback(() => {
    if (emitTimerRef.current !== null) {
      clearTimeout(emitTimerRef.current)
      emitTimerRef.current = null
    }
    const chunks = pendingChunksRef.current
    if (chunks.length === 0) return
    pendingChunksRef.current = []
    // Single chunk → reuse as-is to avoid an unnecessary join allocation
    // (the common case once a paragraph has cleanly settled).
    const combined = chunks.length === 1 ? chunks[0] : chunks.join('')
    debugLog('buffer.emit', `chunks=${chunks.length} chars=${combined.length}`)
    appendMessage(makeStreamChunkMessage(combined))
  }, [appendMessage])

  const queueChunk = useCallback(
    (chunk: string) => {
      pendingChunksRef.current.push(chunk)
      if (emitTimerRef.current === null) {
        emitTimerRef.current = setTimeout(drainPending, COMMIT_BATCH_MS)
      }
      // Timer already armed — chunk rides out on the existing deadline so
      // a long burst can't keep extending the wait indefinitely.
    },
    [drainPending],
  )

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
        queueChunk(chunk)
      } else if (bufferRef.current.length > CODE_FENCE_COMMIT_THRESHOLD && hasOpenMarkdownBlock(bufferRef.current)) {
        // Large open code fence — force an intermediate commit at the last
        // newline so the terminal doesn't have to pre-scroll 100+ blank rows
        // in one shot. Find the last `\n` that is NOT part of a `\n\n` pair
        // (those are handled by findSafeBoundary above) and cut there.
        const lastNL = bufferRef.current.lastIndexOf('\n')
        if (lastNL > 0) {
          const chunk = bufferRef.current.slice(0, lastNL + 1)
          bufferRef.current = bufferRef.current.slice(lastNL + 1)
          debugLog('buffer.commit', `chars=${chunk.length} (fence-split)`)
          queueChunk(chunk)
        }
      }
    },
    [queueChunk],
  )

  const flushBuffer = useCallback(() => {
    // End-of-turn / tool-call boundary — no more deltas are coming, so
    // drain whatever's left (even if it's an unclosed table, there's
    // nothing more to hold for). Combine pending chunks + remainder into
    // a single message: emitting them separately would produce two
    // setState → render → flush cycles back-to-back, which is exactly
    // the flicker the batching is meant to avoid.
    if (emitTimerRef.current !== null) {
      clearTimeout(emitTimerRef.current)
      emitTimerRef.current = null
    }
    const remainder = bufferRef.current
    bufferRef.current = ''
    if (remainder) pendingChunksRef.current.push(remainder)
    if (pendingChunksRef.current.length === 0) return
    const chunks = pendingChunksRef.current
    pendingChunksRef.current = []
    const combined = chunks.length === 1 ? chunks[0] : chunks.join('')
    debugLog('buffer.commit', `chars=${combined.length} (flush)`)
    appendMessage(makeStreamChunkMessage(combined))
  }, [appendMessage])

  const resetBuffer = useCallback(() => {
    if (emitTimerRef.current !== null) {
      clearTimeout(emitTimerRef.current)
      emitTimerRef.current = null
    }
    pendingChunksRef.current = []
    bufferRef.current = ''
  }, [])

  return { appendTextDelta, flushBuffer, resetBuffer }
}
