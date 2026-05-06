// @x-code-cli/core — readFile tool
//
// Text files are returned as numbered-line strings (the format agents have
// been trained against). Binary files (images, PDFs) are returned as an
// AI-SDK `content` tool result so providers that accept inline media
// receive proper `image-data` / `file-data` parts instead of a base64 blob
// stuffed inside a text string.
//
// The tool itself does NOT branch on provider capability — that would
// couple the tool layer to the currently-active model. Instead, every
// binary result goes out as content parts and the provider-compat layer
// strips them (falling back to OCR'd text) before they reach a provider
// that can't handle them.
import fs from 'node:fs/promises'
import path from 'node:path'

import { tool } from 'ai'

import { z } from 'zod'

import { classifyFile } from '../agent/file-ingest.js'
import { mediaTypeFor } from '../utils/media-type.js'
import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

/** Default cap on lines returned by a no-args readFile call. Aligned with
 *  Claude Code's MAX_LINES_TO_READ — picked empirically: 2000 lines is a
 *  realistic ceiling for "skim the whole thing", anything bigger is almost
 *  always used with grep first. Was 500 originally, bumped after observing
 *  that 500 forced too many round-trips for legitimate "read this whole
 *  module" cases (4× more calls than CC for the same coverage). */
const LARGE_FILE_LINE_THRESHOLD = 2000

/** Byte cap on a single tool-result payload. Mirrors the @-attach ingest cap
 *  in file-ingest.ts and Claude Code's Read-tool 25K-token default (~100 KB
 *  English / ~75 KB CJK; 256 KB gives headroom). Applies to BOTH the
 *  default head case AND the explicit offset/limit case — without this,
 *  a model that asks for `limit: 90000` on a multi-MB file gets the entire
 *  thing dumped into context and the next turn fails with
 *  context_length_exceeded. CC enforces the same invariant via
 *  `validateContentTokens`. */
const MAX_READ_BYTES = 256 * 1024

async function readTextResult(filePath: string, offset?: number, limit?: number): Promise<string> {
  const content = await fs.readFile(filePath, 'utf-8')
  const lines = content.split('\n')
  const totalLines = lines.length

  const userSpecifiedRange = offset != null || limit != null

  // Decide which slice the caller asked for; head-truncation is its own
  // mode so the trailing hint can say "showing first N" vs "byte cap hit".
  let start: number
  let end: number
  let isHeadTruncation = false
  if (userSpecifiedRange) {
    start = (offset ?? 1) - 1
    end = limit ? start + limit : lines.length
  } else if (totalLines > LARGE_FILE_LINE_THRESHOLD) {
    start = 0
    end = LARGE_FILE_LINE_THRESHOLD
    isHeadTruncation = true
  } else {
    start = 0
    end = lines.length
  }
  const sliced = lines.slice(start, end)

  // Build the numbered-line output line-by-line, stopping as soon as adding
  // the next line would push past MAX_READ_BYTES. Per-line byte counting
  // is necessary for CJK / wide-char content where line.length lies about
  // the on-the-wire size.
  const formatted: string[] = []
  let bytes = 0
  for (let i = 0; i < sliced.length; i++) {
    const numbered = `${start + i + 1}\t${sliced[i]}`
    const addedBytes = Buffer.byteLength(numbered, 'utf-8') + (formatted.length > 0 ? 1 : 0)
    if (bytes + addedBytes > MAX_READ_BYTES && formatted.length > 0) break
    formatted.push(numbered)
    bytes += addedBytes
  }
  const includedLines = formatted.length
  const body = formatted.join('\n')

  // Trailing hint — same shape as Claude Code's MaxFileReadTokenExceededError
  // message: tells the model exactly which next call will work, so it can
  // self-recover instead of giving up or repeating the same call.
  if (isHeadTruncation) {
    const note = includedLines < sliced.length ? ` (further capped at ${MAX_READ_BYTES / 1024} KB)` : ''
    return (
      body +
      `\n\n[readFile: showing first ${includedLines}/${totalLines} lines${note}. ` +
      `Call readFile again with offset/limit to view other ranges, or use grep to find specific symbols. ` +
      `For whole-file analysis of very large files, consider delegating to a sub-agent via the task tool — ` +
      `each sub-agent reads in isolated context and returns only a summary.]`
    )
  }
  if (includedLines < sliced.length) {
    const nextOffset = start + includedLines + 1
    return (
      body +
      `\n\n[readFile: output capped at ${MAX_READ_BYTES / 1024} KB; ` +
      `returned ${includedLines}/${sliced.length} requested lines (lines ${start + 1}-${start + includedLines}). ` +
      `Call readFile again with offset=${nextOffset} for the next chunk, or narrow the range.]`
    )
  }
  return body
}

export const readFile = tool({
  description: `Read a file from the local filesystem. Assume this tool can read all files on the machine.

Usage:
- The filePath parameter must be an absolute path, not a relative path.
- You can optionally specify offset and limit (especially handy for long files), but it's recommended to read the whole file first.
- Results are returned with line numbers starting at 1.
- This tool can read images (PNG, JPG, etc.) and PDFs — their content is presented inline.
- This tool can only read files, not directories. To list a directory, use listDir or shell with ls.
- If a file path is provided by the user, assume it is valid.`,
  inputSchema: z.object({
    filePath: z.string().describe('Absolute path to the file'),
    offset: z.number().optional().describe('Start line (1-based, text files only)'),
    limit: z.number().optional().describe('Max lines to read (text files only)'),
  }),
  execute: async ({ filePath, offset, limit }, { toolCallId }) => {
    try {
      reportProgress(toolCallId, `Reading ${filePath}`)
      const kind = await classifyFile(filePath).catch(() => 'text' as const)

      if (kind === 'image') {
        const buffer = await fs.readFile(filePath)
        // Content tool result: the provider-compat sanitizer decides whether
        // this image survives to the model (multimodal) or gets replaced
        // with an OCR text block (DeepSeek etc.). We attach both an
        // `image-data` part (for providers that can see it) and a trailing
        // text part with the file path (so the model always has a textual
        // anchor to reference).
        return {
          type: 'content',
          value: [
            { type: 'text', text: `Loaded image: ${filePath}` },
            {
              type: 'image-data',
              data: buffer.toString('base64'),
              mediaType: mediaTypeFor(filePath),
            },
          ],
        }
      }

      if (kind === 'pdf') {
        const buffer = await fs.readFile(filePath)
        return {
          type: 'content',
          value: [
            { type: 'text', text: `Loaded PDF: ${filePath}` },
            {
              type: 'file-data',
              data: buffer.toString('base64'),
              mediaType: 'application/pdf',
              filename: path.basename(filePath),
            },
          ],
        }
      }

      // Text / Office / unknown → read as text.
      // (Office files are handled up-front by buildUserContent when the user
      // attaches them via @path; if a model calls readFile on a .docx anyway,
      // we fall through to a UTF-8 read which returns gibberish — a follow-up
      // could route Office here too, but it's a rare path worth keeping
      // simple for now.)
      return await readTextResult(filePath, offset, limit)
    } catch (err) {
      return formatToolError('reading file', err)
    }
  },
})
