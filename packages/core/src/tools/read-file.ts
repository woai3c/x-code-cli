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
import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

function mediaTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.bmp') return 'image/bmp'
  return 'image/png'
}

/** Threshold above which a no-args readFile call returns a partial head plus a
 *  hint to re-read specific ranges. Picked empirically: 500 lines of code is
 *  a realistic ceiling for "skim the whole thing", and anything bigger is
 *  almost always used with grep first. */
const LARGE_FILE_LINE_THRESHOLD = 500

async function readTextResult(filePath: string, offset?: number, limit?: number): Promise<string> {
  const content = await fs.readFile(filePath, 'utf-8')
  const lines = content.split('\n')
  const totalLines = lines.length

  // When the caller passes neither offset nor limit and the file is large,
  // return only the head and tell the model how to request the rest. Without
  // this guard, models happily read 2000-line files "just to see what's in
  // there" and the full content rides along on every subsequent turn. The
  // downstream truncator (tool-result-sanitize) would eventually clip this,
  // but doing it at the tool level preserves intent — the model sees
  // explicitly that the file was large and that it should narrow the range.
  const userSpecifiedRange = offset != null || limit != null
  if (!userSpecifiedRange && totalLines > LARGE_FILE_LINE_THRESHOLD) {
    const head = lines.slice(0, LARGE_FILE_LINE_THRESHOLD)
    const body = head.map((line, i) => `${i + 1}\t${line}`).join('\n')
    return (
      body +
      `\n\n[readFile: showing first ${LARGE_FILE_LINE_THRESHOLD}/${totalLines} lines. ` +
      `Call readFile again with offset/limit to view other ranges, or use grep to find specific symbols.]`
    )
  }

  const start = (offset ?? 1) - 1
  const end = limit ? start + limit : lines.length
  const sliced = lines.slice(start, end)
  return sliced.map((line, i) => `${start + i + 1}\t${line}`).join('\n')
}

export const readFile = tool({
  description: 'Read the contents of a file at the given path. Returns line-numbered text for code/docs, and inline media for images/PDFs so the model can inspect them directly.',
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

