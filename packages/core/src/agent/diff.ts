// @x-code-cli/core — Edit-tool diff payload.
//
// Computed by tool-execution after a successful writeFile / edit, and
// emitted to the UI via AgentCallbacks.onFileEdit so the scrollback row
// can render a colored diff block under the tool bullet (matching
// Claude Code's `Update(file)` → `Added X lines, removed Y` view).
//
// The model still sees only the short result string from executeWriteTool
// (`File edited: ...`) — the diff payload is a UI-side side channel and
// never round-trips through state.messages.
import { structuredPatch } from 'diff'

/** One contiguous diff hunk. Mirrors `diff` package's `StructuredPatchHunk`
 *  shape but redefined here so consumers don't need a `diff` peer dep just
 *  to type the payload. Each entry in `lines` carries a leading sigil
 *  character: `' '` (context), `'+'` (added), `'-'` (removed). */
export interface EditDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export interface EditDiffPayload {
  filePath: string
  hunks: EditDiffHunk[]
  additions: number
  removals: number
  /** True when the file did not exist before the write — used by the UI to
   *  flip the header from "Added X lines, removed Y" to "Created N lines"
   *  and render a content preview instead of an (empty) hunk list. */
  isCreate: boolean
  /** Full new file content. Populated for create payloads so the UI can
   *  render the first ~10 lines as a preview under the "Created N lines"
   *  header (matching Claude Code's FileWriteToolCreatedMessage). Left
   *  undefined for update payloads — there's already a hunk list to show. */
  content?: string
}

const CONTEXT_LINES = 3
const DIFF_TIMEOUT_MS = 5_000

/**
 * Build a structured patch + counts for a single file change. Returns
 * `null` when no actual change was made (writeFile with identical content)
 * so callers can elide the diff display entirely. For brand-new files pass
 * `oldContent: null` — the helper still computes a hunk-less payload with
 * `additions = lineCount(newContent)`.
 */
export function computeEditDiff(
  filePath: string,
  oldContent: string | null,
  newContent: string,
): EditDiffPayload | null {
  if (oldContent === null) {
    return {
      filePath,
      hunks: [],
      additions: countLines(newContent),
      removals: 0,
      isCreate: true,
      content: newContent,
    }
  }

  if (oldContent === newContent) return null

  const result = structuredPatch(filePath, filePath, oldContent, newContent, undefined, undefined, {
    context: CONTEXT_LINES,
    timeout: DIFF_TIMEOUT_MS,
  })

  // structuredPatch returns `false`-y on timeout. The change really did
  // happen on disk; we just don't have a hunk view, so fall back to a
  // counts-only summary derived line-by-line. Better than dropping the
  // payload (UI would silently skip the diff block).
  const hunks: EditDiffHunk[] = result?.hunks ? result.hunks.map(toHunk) : []

  let additions = 0
  let removals = 0
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.startsWith('+')) additions++
      else if (line.startsWith('-')) removals++
    }
  }

  if (additions === 0 && removals === 0 && hunks.length === 0) {
    // Timed-out diff with no hunks — count lines manually so the header
    // still makes sense. Approximation: max(0, newLines - oldLines) added,
    // and max(0, oldLines - newLines) removed. Not accurate for a pure
    // replace, but honest given we couldn't compute a real diff.
    const oldLines = countLines(oldContent)
    const newLines = countLines(newContent)
    additions = Math.max(0, newLines - oldLines)
    removals = Math.max(0, oldLines - newLines)
  }

  return { filePath, hunks, additions, removals, isCreate: false }
}

function toHunk(h: {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}): EditDiffHunk {
  return {
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines,
  }
}

/** Count visible lines, treating a single trailing `\n` as a terminator
 *  (matches how editors number lines: a 3-line file is 3 lines whether or
 *  not it ends in a newline). */
function countLines(s: string): number {
  if (s.length === 0) return 0
  const parts = s.split('\n')
  return s.endsWith('\n') ? parts.length - 1 : parts.length
}

const MODEL_DIFF_MAX_LINES = 30

/** Format a diff payload as a short textual snippet for the MODEL'S
 *  tool-result string. Distinct from the UI diff: this lands in
 *  state.messages and rides along on every subsequent turn, so it must
 *  be tight. We show a unified-style header per hunk and cap the total
 *  at MODEL_DIFF_MAX_LINES — past that the model can re-read the file
 *  if it needs more context. Returns '' when there's nothing useful
 *  (no-op edit, payload was null upstream). */
export function formatDiffForModel(payload: EditDiffPayload | null): string {
  if (!payload) return ''
  if (payload.isCreate) {
    if (!payload.content) return `(${payload.additions} lines)`
    const lines = payload.content.split('\n')
    const preview = lines.slice(0, 10)
    const truncated = lines.length > 10 ? `\n... (+${lines.length - 10} more)` : ''
    return `Created with ${payload.additions} lines:\n${preview.map((l) => `  ${l}`).join('\n')}${truncated}`
  }

  const out: string[] = [`Diff (+${payload.additions} -${payload.removals}):`]
  let usedLines = 0
  let truncated = false
  for (const hunk of payload.hunks) {
    if (usedLines >= MODEL_DIFF_MAX_LINES) {
      truncated = true
      break
    }
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    usedLines++
    for (const line of hunk.lines) {
      if (usedLines >= MODEL_DIFF_MAX_LINES) {
        truncated = true
        break
      }
      out.push(line)
      usedLines++
    }
  }
  if (truncated) {
    out.push(`... (diff truncated at ${MODEL_DIFF_MAX_LINES} lines; readFile to see full result)`)
  }
  return out.join('\n')
}
