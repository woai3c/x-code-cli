// @x-code-cli/core — Tool-output truncation
//
// Dual-budget truncation (lines OR bytes, whichever hits first). The 20/80
// head/tail split is from gemini-cli; the per-tool direction is from opencode.
// Shell output wants head-only (the tail repeats the prompt / exit line and
// the head carries the action), while file reads and grep results prefer
// head+tail so both the top-of-file context and the last section remain
// visible.
//
// Why not a separate char budget? For ASCII, chars == bytes, so a char budget
// is redundant with the byte budget. For non-ASCII (CJK code/comments), the
// byte budget is the one that actually matches how providers bill — they
// count UTF-8 bytes, not UTF-16 code units. Running two size axes (chars +
// bytes) made the slice logic three-pass and produced no behavioural win.

/** Default per-result line cap. Above this we keep a head/tail slice. */
export const MAX_TOOL_RESULT_LINES = 2000

/** Default per-result byte cap (UTF-8). Covers both ASCII single-line
 *  minified dumps and non-ASCII content where a modest char count still adds
 *  up to a lot of wire bytes. */
export const MAX_TOOL_RESULT_BYTES = 50 * 1024

/** Head:tail ratio when slicing. 0.2 keeps the first 20% + last 80%. */
export const DEFAULT_HEAD_RATIO = 0.2

export interface TruncateOptions {
  /** Max lines before truncation kicks in. Default {@link MAX_TOOL_RESULT_LINES}. */
  maxLines?: number
  /** Max bytes (UTF-8). Default {@link MAX_TOOL_RESULT_BYTES}. */
  maxBytes?: number
  /**
   * Where to keep content when truncating:
   *  - `head-tail` (default): keep head 20% + tail 80%, drop middle.
   *  - `head`: keep first N bytes only, drop tail. Good for streamed shell
   *    output where the tail repeats noise (prompt, exit code).
   *  - `tail`: keep last N bytes only, drop head. Good for logs where the
   *    interesting part is the most recent.
   */
  direction?: 'head-tail' | 'head' | 'tail'
  /** Head ratio in head-tail mode. Default {@link DEFAULT_HEAD_RATIO}. */
  headRatio?: number
}

function byteLength(str: string): number {
  return Buffer.byteLength(str, 'utf-8')
}

/** Byte-aware slice that always cuts on a UTF-8 boundary so we don't produce
 *  a replacement char. Walks back up to 4 bytes to find a clean boundary. */
function sliceBytes(buf: Buffer, bytes: number, direction: 'head' | 'tail'): Buffer {
  if (buf.length <= bytes) return buf
  if (direction === 'head') {
    let end = bytes
    // Back off to the last full codepoint start byte: continuation bytes in
    // UTF-8 have the high bits `10xxxxxx`; we want to stop before them.
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
    return buf.subarray(0, end)
  }
  let start = buf.length - bytes
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
  return buf.subarray(start)
}

type SliceResult = {
  sliced: string
  /** Character index in `sliced` where the head ends and the tail begins
   *  (head-tail mode only). Used to insert the truncation marker cleanly. */
  headEnd: number | null
}

function applyLineSlice(
  result: string,
  maxLines: number,
  direction: 'head-tail' | 'head' | 'tail',
  headRatio: number,
): { result: SliceResult; linesDropped: number } {
  const lines = result.split('\n')
  if (lines.length <= maxLines) return { result: { sliced: result, headEnd: null }, linesDropped: 0 }

  if (direction === 'head') {
    return {
      result: { sliced: lines.slice(0, maxLines).join('\n'), headEnd: null },
      linesDropped: lines.length - maxLines,
    }
  }
  if (direction === 'tail') {
    return {
      result: { sliced: lines.slice(-maxLines).join('\n'), headEnd: null },
      linesDropped: lines.length - maxLines,
    }
  }

  const headLines = Math.max(1, Math.floor(maxLines * headRatio))
  const tailLines = maxLines - headLines
  const head = lines.slice(0, headLines).join('\n')
  const tail = lines.slice(-tailLines).join('\n')
  return { result: { sliced: head + '\n' + tail, headEnd: head.length }, linesDropped: lines.length - maxLines }
}

function applyByteSlice(
  input: SliceResult,
  maxBytes: number,
  direction: 'head-tail' | 'head' | 'tail',
  headRatio: number,
): SliceResult {
  const buf = Buffer.from(input.sliced, 'utf-8')
  if (buf.length <= maxBytes) return input

  if (direction === 'head') return { sliced: sliceBytes(buf, maxBytes, 'head').toString('utf-8'), headEnd: null }
  if (direction === 'tail') return { sliced: sliceBytes(buf, maxBytes, 'tail').toString('utf-8'), headEnd: null }

  const headBudget = Math.max(256, Math.floor(maxBytes * headRatio))
  const tailBudget = maxBytes - headBudget
  const head = sliceBytes(buf, headBudget, 'head').toString('utf-8')
  const tail = sliceBytes(buf, tailBudget, 'tail').toString('utf-8')
  return { sliced: head + tail, headEnd: head.length }
}

/**
 * Truncate tool output to the line / byte budget. Returns the input unchanged
 * if it fits both. Adds a one-line marker so the model can tell intentional
 * omission from corrupted output.
 */
export function truncateToolResult(result: string, options: TruncateOptions = {}): string {
  const maxLines = options.maxLines ?? MAX_TOOL_RESULT_LINES
  const maxBytes = options.maxBytes ?? MAX_TOOL_RESULT_BYTES
  const direction = options.direction ?? 'head-tail'
  const headRatio = options.headRatio ?? DEFAULT_HEAD_RATIO

  const origLines = (result.match(/\n/g)?.length ?? 0) + 1
  const origBytes = byteLength(result)
  const origChars = result.length

  if (origLines <= maxLines && origBytes <= maxBytes) return result

  // Line slice first: preserves structured chunking for line-oriented output
  // (grep matches, listDir entries). After the line cut we may still be over
  // the byte budget — a long single line or CJK-heavy content where the line
  // count was fine — and the byte slice handles the remainder.
  const lineSlice = applyLineSlice(result, maxLines, direction, headRatio)
  const byteSlice = applyByteSlice(lineSlice.result, maxBytes, direction, headRatio)

  const droppedChars = origChars - byteSlice.sliced.length
  const marker =
    lineSlice.linesDropped > 0
      ? `[truncated: ${lineSlice.linesDropped} lines / ${droppedChars.toLocaleString()} chars dropped — narrow the tool args or read specific ranges]`
      : `[truncated: ${droppedChars.toLocaleString()} chars dropped — output exceeded byte budget]`

  if (direction === 'head') return `${byteSlice.sliced}\n\n${marker}`
  if (direction === 'tail') return `${marker}\n\n${byteSlice.sliced}`

  if (byteSlice.headEnd != null && byteSlice.headEnd > 0 && byteSlice.headEnd < byteSlice.sliced.length) {
    return `${byteSlice.sliced.slice(0, byteSlice.headEnd)}\n\n${marker}\n\n${byteSlice.sliced.slice(byteSlice.headEnd)}`
  }
  return `${marker}\n\n${byteSlice.sliced}`
}
