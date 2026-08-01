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
// either keeps it in the tool result, reattaches it as a user image, or
// replaces it with OCR for a text-only model.
import fs from 'node:fs/promises'
import path from 'node:path'

import { tool } from 'ai'

import { z } from 'zod'

import { classifyFile } from '../agent/file-ingest.js'
import { ATTACH_BYTE_BUDGET, compressImage } from '../utils/image-compress.js'
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

/** Per-file fingerprint used by the read de-dup cache. */
export interface ReadFileCacheEntry {
  mtimeMs: number
  size: number
}
/** Session-scoped map of absolute path → last-read fingerprint. Lives on
 *  LoopState so each agent (including sub-agents, which get a fresh
 *  LoopState) has its own isolated cache and one agent's reads never make
 *  another agent's reads return a stub for a file it never saw. */
export type ReadFileCache = Map<string, ReadFileCacheEntry>

async function readTextResult(
  filePath: string,
  offset?: number,
  limit?: number,
): Promise<{ text: string; complete: boolean }> {
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
    return {
      text:
        body +
        `\n\n[readFile: showing first ${includedLines}/${totalLines} lines${note}. ` +
        `Call readFile again with offset/limit to view other ranges, or use grep to find specific symbols. ` +
        `For whole-file analysis of very large files, consider delegating to a sub-agent via the task tool — ` +
        `each sub-agent reads in isolated context and returns only a summary.]`,
      // Head-truncated: the whole file is NOT in context, so the caller must
      // not cache this read (a re-read would otherwise return a misleading
      // "already in the conversation above" stub).
      complete: false,
    }
  }
  if (includedLines < sliced.length) {
    const nextOffset = start + includedLines + 1
    return {
      text:
        body +
        `\n\n[readFile: output capped at ${MAX_READ_BYTES / 1024} KB; ` +
        `returned ${includedLines}/${sliced.length} requested lines (lines ${start + 1}-${start + includedLines}). ` +
        `Call readFile again with offset=${nextOffset} for the next chunk, or narrow the range.]`,
      complete: false,
    }
  }
  // Whole requested slice returned untruncated. It's "complete" (the entire
  // file is now in context) only for a whole-file read — an explicit range
  // leaves the rest of the file unseen, so it must not seed the de-dup cache.
  return { text: body, complete: !userSpecifiedRange }
}

// ── Read de-dup ──
// Re-reading a file the model already read this session — and that hasn't
// changed since — wastes context: the content is still in the conversation
// above. Returning a short stub instead can save thousands of tokens on the
// common "let me re-read that file" pattern. Only whole-file reads de-dup; an
// explicit offset/limit always re-reads (the model wants a specific range),
// and binary (image/pdf) reads are never de-duped (re-reading an image is
// usually a deliberate "look again"). An edit/write bumps the file's mtime,
// so the next read naturally misses the cache and returns fresh content.
type ReadCacheVerdict = { hit: true; stub: string } | { hit: false; entry: ReadFileCacheEntry } | null

async function checkReadCache(
  cache: ReadFileCache | undefined,
  filePath: string,
  isRangeRead: boolean,
): Promise<ReadCacheVerdict> {
  if (!cache || isRangeRead) return null
  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat) return null // let the normal read path surface the error
  const prev = cache.get(filePath)
  if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
    return {
      hit: true,
      stub:
        `[readFile: ${filePath} is unchanged since you last read it this session ` +
        `(same mtime and size); its full content is already in the conversation above. ` +
        `Re-read with an explicit offset/limit to revisit a specific range, or use grep to search within it.]`,
    }
  }
  return { hit: false, entry: { mtimeMs: stat.mtimeMs, size: stat.size } }
}

// ── Jupyter notebook rendering ──
// A .ipynb file is JSON; reading it raw dumps base64 image outputs and
// metadata noise that burns context for no benefit. We parse it and render
// each cell as source + text outputs, omitting binary (image/*) outputs.
interface NotebookOutput {
  output_type?: string
  text?: string | string[]
  data?: Record<string, unknown>
  ename?: string
  evalue?: string
  traceback?: string[]
}
interface NotebookCell {
  cell_type?: string
  source?: string | string[]
  execution_count?: number | null
  outputs?: NotebookOutput[]
}

/** Notebook source/text fields are either a string or an array of line
 *  strings (nbformat allows both). Normalize to a single string. */
function joinNotebookSource(src: string | string[] | undefined): string {
  if (Array.isArray(src)) return src.join('')
  if (typeof src === 'string') return src
  return ''
}

// Built via `new RegExp` (not a literal) to dodge eslint's no-control-regex
// on the ESC byte. Strips SGR color codes from error tracebacks.
const ANSI_ESCAPE = new RegExp('\\u001b\\[[0-9;]*m', 'g')

function renderNotebookOutput(o: NotebookOutput): string {
  switch (o.output_type) {
    case 'stream':
      return joinNotebookSource(o.text).trimEnd()
    case 'error': {
      const trace = Array.isArray(o.traceback) ? o.traceback.join('\n') : ''
      const head = [o.ename, o.evalue].filter(Boolean).join(': ')
      return (trace || head).replace(ANSI_ESCAPE, '').trimEnd()
    }
    case 'execute_result':
    case 'display_data': {
      const data = o.data ?? {}
      const parts: string[] = []
      const plain = data['text/plain']
      if (plain !== undefined) parts.push(joinNotebookSource(plain as string | string[]).trimEnd())
      // Binary / rich outputs (image/png, application/json, …) are noise to a
      // text model — note their presence but don't dump the payload.
      for (const mime of Object.keys(data)) {
        if (mime !== 'text/plain') parts.push(`[${mime} output omitted]`)
      }
      return parts.join('\n')
    }
    default:
      return ''
  }
}

async function readNotebookResult(filePath: string): Promise<{ text: string; complete: boolean }> {
  const raw = await fs.readFile(filePath, 'utf-8')
  let parsed: { cells?: NotebookCell[] }
  try {
    parsed = JSON.parse(raw) as { cells?: NotebookCell[] }
  } catch {
    // Malformed JSON — fall back to raw text so the model still sees content.
    return { text: raw, complete: true }
  }
  const cells = Array.isArray(parsed.cells) ? parsed.cells : []
  const out: string[] = [`# Jupyter Notebook: ${filePath} (${cells.length} cell${cells.length === 1 ? '' : 's'})`]

  cells.forEach((cell, i) => {
    const type = cell.cell_type ?? 'unknown'
    const execCount = type === 'code' && cell.execution_count != null ? ` (exec ${cell.execution_count})` : ''
    out.push('', `## Cell ${i + 1} [${type}]${execCount}`)
    const source = joinNotebookSource(cell.source).trimEnd()
    if (source) out.push(source)
    const outputs = Array.isArray(cell.outputs) ? cell.outputs : []
    for (const o of outputs) {
      const rendered = renderNotebookOutput(o)
      if (rendered) out.push('### Output:', rendered)
    }
  })

  let body = out.join('\n')
  // Same 256 KB ceiling as text reads — a notebook with huge text outputs
  // shouldn't blow the next request's context.
  const buf = Buffer.from(body, 'utf-8')
  if (buf.byteLength > MAX_READ_BYTES) {
    body =
      buf.subarray(0, MAX_READ_BYTES).toString('utf-8') +
      `\n\n[readFile: notebook output truncated at ${MAX_READ_BYTES / 1024} KB. Use grep on the .ipynb to find specific cells/symbols.]`
    return { text: body, complete: false }
  }
  return { text: body, complete: true }
}

/** Build the readFile tool. The optional `cache` enables session-scoped
 *  read de-dup (see checkReadCache). buildTools injects the per-session
 *  cache from LoopState; the bare `readFile` export below passes none, so
 *  it behaves exactly as before (no de-dup) for any caller that imports it
 *  directly (tests, etc.). */
export function createReadFileTool(cache?: ReadFileCache) {
  return tool({
    description: `Read a file from the local filesystem. Assume this tool can read all files on the machine.

Usage:
- The filePath parameter must be an absolute path, not a relative path.
- You can optionally specify offset and limit (especially handy for long files), but it's recommended to read the whole file first.
- Results are returned with line numbers starting at 1.
- This tool can read images (PNG, JPG, etc.) and PDFs — their content is presented inline.
- This tool renders Jupyter notebooks (.ipynb) as readable cells (source + text outputs), skipping binary image outputs.
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
        const isRangeRead = offset != null || limit != null

        // Jupyter notebooks are JSON — render cells instead of dumping raw
        // base64-laden JSON. Checked before classifyFile, which would otherwise
        // treat .ipynb as plain text.
        if (filePath.toLowerCase().endsWith('.ipynb')) {
          const verdict = await checkReadCache(cache, filePath, false)
          if (verdict && verdict.hit) return verdict.stub
          const { text, complete } = await readNotebookResult(filePath)
          if (verdict && !verdict.hit && complete) cache?.set(filePath, verdict.entry)
          return text
        }

        const kind = await classifyFile(filePath).catch(() => 'text' as const)

        if (kind === 'image') {
          const buffer = await fs.readFile(filePath)
          const mime = mediaTypeFor(filePath)
          // Compress with a smaller byte budget than user-attached images:
          // each tool-read image persists in the conversation and accumulates
          // on every subsequent turn, so per-image size matters more here.
          const compressed = await compressImage(buffer, mime, { byteBudget: ATTACH_BYTE_BUDGET })
          const finalMime = compressed.changed ? compressed.mimeType : mime
          const header = compressed.changed
            ? `Loaded image: ${filePath} (compressed from ${buffer.length} to ${compressed.data.length} bytes)`
            : `Loaded image: ${filePath}`
          return {
            type: 'content',
            value: [
              { type: 'text', text: header },
              {
                type: 'image-data',
                data: compressed.data.toString('base64'),
                mediaType: finalMime,
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
        const verdict = await checkReadCache(cache, filePath, isRangeRead)
        if (verdict && verdict.hit) return verdict.stub
        const { text, complete } = await readTextResult(filePath, offset, limit)
        if (verdict && !verdict.hit && complete) cache?.set(filePath, verdict.entry)
        return text
      } catch (err) {
        return formatToolError('reading file', err)
      }
    },
  })
}

/** Default, cache-less readFile (used by the static registry export and any
 *  direct importer). buildTools overrides this with a cache-backed instance. */
export const readFile = createReadFileTool()
