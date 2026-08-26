// @x-code-cli/core — Attach-file-to-message pipeline
//
// Given a raw user prompt that references files (via `@path` or bare
// absolute paths), resolve each reference into an AI-SDK content part:
//
//   text / code  → TextPart with file body
//   PDF          → page-ordered local text and standard page images
//   docx/xlsx/pptx → TextPart via bounded format-specific parsers
//   image        → image FilePart for the active vision model; otherwise local OCR
//
// PDF, audio, Office, and unknown binary source bytes never leave the local
// processing pipeline.
import fs from 'node:fs/promises'
import path from 'node:path'

import type { FilePart, ImagePart, TextPart } from 'ai'

import type { ProviderCapabilities } from '../providers/capabilities.js'
import {
  buildUnsupportedImageNotice,
  isModelAcceptedImage,
  normalizeImageMime,
  sniffImageMime,
} from '../providers/capabilities.js'
import type { ReadFileCache } from '../tools/read-file.js'
import { errorMessage, truncateUtf8 } from '../utils.js'
import { FileSizeLimitError, readFileWithinLimit } from '../utils/bounded-read.js'
import {
  ATTACH_BYTE_BUDGET,
  MAX_EDGE_PX,
  MAX_IMAGE_SOURCE_BYTES,
  buildCompressionCaption,
  buildImageProcessingFailureNotice,
  compressImage,
  formatBytes,
} from '../utils/image-compress.js'
import { formatTranscription, transcribeAudio } from './audio-transcribe.js'
import { classifyFile, decodeTextBuffer, inspectFile, inspectFileBuffer } from './file-classifier.js'
import type { FileKind, InspectedFileKind } from './file-classifier.js'
import { MAX_INGEST_BYTES } from './file-ingest-limits.js'
import { ocrImage } from './image-ocr.js'
import {
  BUILT_IN_MEDIA_ANALYSIS_NOTE,
  escapeMediaAttribute,
  openMediaTag,
  toUserContentParts,
  wrapLocalText,
} from './local-media.js'
import { MAX_NOTEBOOK_SOURCE_BYTES, renderNotebookFile } from './notebook-render.js'
import {
  MAX_OFFICE_ARCHIVE_ENTRIES,
  MAX_OFFICE_SOURCE_BYTES,
  MAX_OFFICE_UNCOMPRESSED_BYTES,
  detectOfficeKindFromArchive,
} from './office-archive.js'
import type { OfficeKind } from './office-archive.js'
import { parseXlsxInWorker } from './office-xlsx.js'
import { MAX_PDF_SOURCE_BYTES, formatPdfReference, processPdf } from './pdf-ingest.js'
import type { VisionUsageEvent } from './vision-fallback.js'

/** A content part resolved from a file reference. Same types the AI SDK
 *  accepts in user message `content` arrays, so callers can splice these
 *  directly into a UserModelMessage. */
export type IngestedPart = TextPart | ImagePart | FilePart

export { classifyFile }
export type { FileKind }

/** Paths the user pointed at, either via `@file` or a bare absolute path. */
export interface FileReference {
  /** Original token from the user's input (for echoing/UI). */
  raw: string
  /** Resolved absolute path. */
  absolutePath: string
}

/** Max bytes a single inlined file can contribute to a user message before
 *  we replace its content with a help message. Picked at 256 KB to mirror
 *  Claude Code's Read-tool default — large enough for typical configs and
 *  source files, small enough that even a multi-file paste can't blow past
 *  a 1M context window.
 *
 *  Without this cap, `@really-large-file.txt` (or a bare absolute path like
 *  `D:\novels\book.txt`) silently shoves the entire file into the user
 *  message, since `buildUserContent` bypasses the readFile tool's per-call
 *  line guard. The model never gets a chance to react — the request just
 *  fails at the API with `context_length_exceeded`. With the cap, the model
 *  sees a short hint instead and can call readFile with offset/limit or
 *  grep to narrow down. */
export const MAX_ATTACHMENT_TEXT_BYTES = 1024 * 1024
export const MAX_ATTACHMENT_MEDIA_PARTS = 10
export const MAX_ATTACHMENT_WIRE_BYTES = 21 * 1024 * 1024

export { MAX_INGEST_BYTES, MAX_IMAGE_SOURCE_BYTES, MAX_OFFICE_SOURCE_BYTES, MAX_PDF_SOURCE_BYTES }

/** The human/model-facing message we substitute when an attachment is too
 *  large to inline. Mirrors Claude Code's `MaxFileReadTokenExceededError`
 *  message but adds the sub-agent escape hatch — for "summarize this whole
 *  novel" / "review this entire log" requests, chunk-by-chunk readFile
 *  iteration burns the parent context fast (each tool_result sticks around).
 *  Delegating to a sub-agent keeps only the summary in the parent. */
function tooLargeMessage(filePath: string, sizeBytes: number, cap: number = MAX_INGEST_BYTES): string {
  return (
    `[File ${filePath} is too large to inline (${formatBytes(sizeBytes)}, ` +
    `cap ${formatBytes(cap)}). ` +
    `Use the readFile tool with offset/limit to read specific portions, ` +
    `or grep to search for specific content. ` +
    `For whole-file analysis (summarization, full review), prefer delegating to ` +
    `a sub-agent via the task tool — each sub-agent reads in isolated context ` +
    `and returns only its conclusions, keeping the parent context lean.]`
  )
}

function checkedTextAttachment(filePath: string, text: string): IngestedPart[] {
  const outputBytes = Buffer.byteLength(text, 'utf-8')
  if (outputBytes > MAX_INGEST_BYTES) {
    return [{ type: 'text', text: tooLargeMessage(filePath, outputBytes) }]
  }
  return [{ type: 'text', text }]
}

interface AttachmentUsage {
  mediaParts: number
  textBytes: number
  wireBytes: number
}

function measureAttachment(parts: IngestedPart[]): AttachmentUsage {
  return {
    mediaParts: parts.filter((part) => part.type === 'file' || part.type === 'image').length,
    textBytes: parts.reduce(
      (total, part) => total + (part.type === 'text' ? Buffer.byteLength(part.text, 'utf-8') : 0),
      0,
    ),
    // This is the persisted/session representation and therefore includes
    // Base64 expansion, JSON escaping, filenames, and media-type metadata.
    wireBytes: Buffer.byteLength(JSON.stringify(parts), 'utf-8'),
  }
}

function attachmentBudgetReason(current: AttachmentUsage, added: AttachmentUsage): string | null {
  if (current.mediaParts + added.mediaParts > MAX_ATTACHMENT_MEDIA_PARTS) {
    return `${MAX_ATTACHMENT_MEDIA_PARTS}-media-part limit`
  }
  if (current.textBytes + added.textBytes > MAX_ATTACHMENT_TEXT_BYTES) {
    return `${formatBytes(MAX_ATTACHMENT_TEXT_BYTES)} cumulative text limit`
  }
  if (current.wireBytes + added.wireBytes > MAX_ATTACHMENT_WIRE_BYTES) {
    return `${formatBytes(MAX_ATTACHMENT_WIRE_BYTES)} serialized attachment limit`
  }
  return null
}

function addUsage(current: AttachmentUsage, added: AttachmentUsage): void {
  current.mediaParts += added.mediaParts
  current.textBytes += added.textBytes
  current.wireBytes += added.wireBytes
}

/**
 * Extract plain-text references from a user prompt. Two syntaxes are
 * recognized:
 *
 *   1. `@path` — the `@` prefix marks an explicit attachment. Paths with
 *      whitespace may be wrapped in single or double quotes. Honors Windows
 *      (`D:\foo\bar`) and POSIX (`/etc/foo`) absolute paths.
 *
 *   2. Bare absolute paths — a single non-whitespace token that looks like
 *      `C:\…`, `D:\…`, or starts with `/`, with an extension. Paths containing
 *      whitespace must be quoted. This keeps prose, routes, regex and SQL from
 *      being merged into false file references.
 *
 * Duplicates are de-duplicated by absolute path so a file referenced twice
 * only gets ingested once.
 */
function isWhitespace(value: string): boolean {
  return value === ' ' || value === '\t' || value === '\n' || value === '\r'
}

function isReferenceBoundary(input: string, index: number): boolean {
  return index === 0 || isWhitespace(input[index - 1] ?? '')
}

function isWindowsAbsolute(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function resolveReferencePath(value: string): string {
  if (isWindowsAbsolute(value)) return path.win32.normalize(value)
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(value)
}

function isBareAbsoluteFilePath(value: string): boolean {
  const absolute = isWindowsAbsolute(value) || value.startsWith('/')
  if (!absolute) return false
  const extension = (isWindowsAbsolute(value) ? path.win32 : path.posix).extname(value)
  return /^\.[A-Za-z0-9]{1,16}$/.test(extension)
}

function readQuotedPath(input: string, quoteIndex: number): { end: number; value: string } | null {
  const quote = input[quoteIndex]
  if (quote !== "'" && quote !== '"') return null
  let value = ''
  for (let index = quoteIndex + 1; index < input.length; index++) {
    const current = input[index] ?? ''
    if (current === quote) return { end: index + 1, value }
    if (current === '\\' && input[index + 1] === quote) {
      value += quote
      index++
    } else {
      value += current
    }
  }
  return null
}

export function extractFileReferences(input: string): FileReference[] {
  const refs = new Map<string, FileReference>()

  const addReference = (value: string, raw: string): void => {
    if (!value || value.startsWith('@')) return
    const absolutePath = resolveReferencePath(value)
    refs.set(absolutePath, { raw, absolutePath })
  }

  // Explicit mentions may quote a path containing whitespace. The boundary
  // rule keeps email addresses and package version specifiers out.
  for (let index = 0; index < input.length; index++) {
    if (input[index] !== '@' || !isReferenceBoundary(input, index)) continue
    const valueStart = index + 1
    const quoted = readQuotedPath(input, valueStart)
    if (quoted) {
      addReference(quoted.value, input.slice(index, quoted.end))
      index = quoted.end - 1
      continue
    }
    if (input[valueStart] === "'" || input[valueStart] === '"') continue
    let end = valueStart
    while (end < input.length && !isWhitespace(input[end] ?? '')) end++
    addReference(input.slice(valueStart, end), input.slice(index, end))
    index = Math.max(index, end - 1)
  }

  // Quoted bare paths are common when a shell copies a path containing
  // whitespace into the prompt.
  for (let index = 0; index < input.length; index++) {
    if (!isReferenceBoundary(input, index)) continue
    const quoted = readQuotedPath(input, index)
    if (!quoted) continue
    if (isBareAbsoluteFilePath(quoted.value)) addReference(quoted.value, input.slice(index, quoted.end))
    index = quoted.end - 1
  }

  // Scan each token once. Besides avoiding regex backtracking on route-heavy
  // prompts, this deliberately requires quotes for paths containing spaces.
  const trailingPunctuation = new Set(['.', ',', ':', ';', '!', '?', ')', ']', '}'])
  for (let start = 0; start < input.length; ) {
    while (start < input.length && isWhitespace(input[start] ?? '')) start++
    if (start >= input.length) break
    let end = start
    while (end < input.length && !isWhitespace(input[end] ?? '')) end++
    let candidateEnd = end
    while (candidateEnd > start && trailingPunctuation.has(input[candidateEnd - 1] ?? '')) candidateEnd--
    const raw = input.slice(start, candidateEnd)
    if (isBareAbsoluteFilePath(raw)) addReference(raw, raw)
    start = end
  }

  return [...refs.values()]
}

/** Read a file as a numbered text block — the same format the read-file
 *  tool produces, so the model sees a consistent representation whether
 *  the file was inlined up-front or fetched on demand. */
async function readTextFile(filePath: string, abortSignal?: AbortSignal): Promise<string> {
  const buffer = await readFileWithinLimit(filePath, MAX_INGEST_BYTES, abortSignal)
  const classification = await inspectFileBuffer(filePath, buffer, abortSignal)
  if (classification.kind !== 'text') {
    throw new Error('File content is not valid text')
  }
  const content = decodeTextBuffer(buffer, classification.textEncoding ?? 'utf-8')
  const lines = content.split('\n')
  return lines.map((line, i) => `${i + 1}\t${line}`).join('\n')
}

function decodeXmlText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-fA-F]{1,6});/g, (entity) => {
    if (entity === '&amp;') return '&'
    if (entity === '&lt;') return '<'
    if (entity === '&gt;') return '>'
    if (entity === '&quot;') return '"'
    if (entity === '&apos;') return "'"
    const hex = entity.startsWith('&#x')
    const value = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10)
    return Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ''
  })
}

function officeXmlToText(xml: string): string {
  const parts: string[] = []
  let outputChars = 0
  let cursor = 0
  while (cursor < xml.length && outputChars < MAX_INGEST_BYTES) {
    const tagStart = xml.indexOf('<', cursor)
    const end = tagStart < 0 ? xml.length : tagStart
    if (end > cursor) {
      const text = decodeXmlText(xml.slice(cursor, end))
      parts.push(text)
      outputChars += text.length
    }
    if (tagStart < 0) break
    const tagEnd = xml.indexOf('>', tagStart + 1)
    if (tagEnd < 0) break
    const tag = xml
      .slice(tagStart + 1, Math.min(tagEnd, tagStart + 128))
      .trimStart()
      .toLowerCase()
    if (
      tag.startsWith('/a:p') ||
      tag.startsWith('/text:p') ||
      tag.startsWith('/text:h') ||
      tag.startsWith('/table:table-row') ||
      tag.startsWith('a:br')
    ) {
      parts.push('\n')
    } else if (tag.startsWith('/table:table-cell') || tag.startsWith('text:tab')) {
      parts.push('\t')
    } else if (tag.startsWith('text:line-break')) {
      parts.push('\n')
    }
    cursor = tagEnd + 1
  }
  const normalized = parts
    .join('')
    .replace(/[ \f\r\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return truncateUtf8(normalized, MAX_INGEST_BYTES)
}

async function extractZippedOfficeText(archive: Buffer, kind: OfficeKind, abortSignal?: AbortSignal): Promise<string> {
  const { strFromU8, unzip } = await import('fflate')
  let entryCount = 0
  let uncompressedBytes = 0
  const wanted = (name: string): boolean =>
    kind === 'pptx' ? /^ppt\/slides\/slide\d+\.xml$/i.test(name) : name === 'content.xml'
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    let settled = false
    let terminate = (): void => {}
    const finish = (error?: Error | null, result?: Record<string, Uint8Array>): void => {
      if (settled) return
      settled = true
      abortSignal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(result ?? {})
    }
    const onAbort = (): void => {
      terminate()
      finish(abortSignal?.reason instanceof Error ? abortSignal.reason : new Error('Office extraction aborted'))
    }
    terminate = unzip(
      archive,
      {
        filter: (entry) => {
          entryCount++
          if (entryCount > MAX_OFFICE_ARCHIVE_ENTRIES) {
            throw new Error('Office archive exceeds the safe entry-count limit')
          }
          if (!wanted(entry.name)) return false
          uncompressedBytes += entry.originalSize
          if (uncompressedBytes > MAX_OFFICE_UNCOMPRESSED_BYTES) {
            throw new Error('Office archive exceeds the safe decompression limit')
          }
          return true
        },
      },
      (error, result) => finish(error, result),
    )
    if (!settled) {
      abortSignal?.addEventListener('abort', onAbort, { once: true })
      if (abortSignal?.aborted) onAbort()
    }
  })
  const names = Object.keys(files).sort((left, right) => {
    const a = Number(/slide(\d+)\.xml$/i.exec(left)?.[1] ?? 0)
    const b = Number(/slide(\d+)\.xml$/i.exec(right)?.[1] ?? 0)
    return a - b || left.localeCompare(right)
  })
  const parts: string[] = []
  let outputBytes = 0
  for (const name of names) {
    abortSignal?.throwIfAborted()
    const text = officeXmlToText(strFromU8(files[name]!))
    if (!text) continue
    const prefix =
      kind === 'pptx' ? `--- Slide ${Number(/slide(\d+)\.xml$/i.exec(name)?.[1] ?? parts.length + 1)} ---\n` : ''
    const available = MAX_INGEST_BYTES - outputBytes - Buffer.byteLength(prefix, 'utf8')
    if (available <= 0) break
    const bounded = truncateUtf8(text, available)
    parts.push(prefix + bounded)
    outputBytes += Buffer.byteLength(prefix + bounded, 'utf8')
  }
  return parts.join('\n\n')
}

export type OfficeExtractionResult = { ok: true; text: string } | { ok: false; text: string }

/** Extract text from an Office document with bounded, format-specific parsers. */
export async function extractOfficeTextResult(
  filePath: string,
  abortSignal?: AbortSignal,
  detectedMediaType?: string | null,
): Promise<OfficeExtractionResult> {
  try {
    abortSignal?.throwIfAborted()
    const archive = await readFileWithinLimit(filePath, MAX_OFFICE_SOURCE_BYTES, abortSignal)
    const kind = await detectOfficeKindFromArchive(archive, abortSignal)
    void detectedMediaType
    if (!kind) {
      return {
        ok: false,
        text: `[Failed to extract text from ${path.basename(filePath)}: unknown Office document type]`,
      }
    }
    if (kind === 'docx') {
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ buffer: archive })
      return { ok: true, text: result.value }
    }
    if (kind === 'xlsx') {
      return { ok: true, text: await parseXlsxInWorker(archive, abortSignal) }
    }
    return { ok: true, text: await extractZippedOfficeText(archive, kind, abortSignal) }
  } catch (err) {
    if (err instanceof FileSizeLimitError) {
      return {
        ok: false,
        text: `[Office file is too large to parse safely: ${formatBytes(err.observedBytes)} (cap ${formatBytes(err.limitBytes)}).]`,
      }
    }
    abortSignal?.throwIfAborted()
    const msg = errorMessage(err)
    return { ok: false, text: `[Failed to extract text from ${path.basename(filePath)}: ${msg}]` }
  }
}

export async function extractOfficeText(
  filePath: string,
  abortSignal?: AbortSignal,
  detectedMediaType?: string | null,
): Promise<string> {
  return (await extractOfficeTextResult(filePath, abortSignal, detectedMediaType)).text
}

/**
 * Resolve a single file reference into one or more content parts, taking
 * the active provider's multi-modal capabilities into account.
 *
 * Contract:
 *  - Text, Office, and text-bearing PDFs always collapse to a single
 *    TextPart — cheapest path, works for every provider.
 *  - Images: image-only FilePart if the provider can see images; otherwise
 *    OCR'd TextPart annotated as a fallback.
 *  - Scanned/visual PDF pages: standard images for the active vision model,
 *    local OCR otherwise.
 *  - Missing/unreadable files return a TextPart carrying the error so the
 *    model can acknowledge the failure rather than silently ignore it.
 */
export async function ingestFile(
  ref: FileReference,
  caps: ProviderCapabilities,
  onNotice?: (msg: string) => void,
  abortSignal?: AbortSignal,
  onVisionUsage?: (event: VisionUsageEvent) => void,
  modelId?: string,
): Promise<IngestedPart[]> {
  void onVisionUsage
  if (abortSignal?.aborted) {
    return [{ type: 'text', text: `[File ingest cancelled: ${ref.raw}]` }]
  }

  let kind: InspectedFileKind
  let mediaType: string | null
  let stats: Awaited<ReturnType<typeof fs.stat>>
  try {
    stats = await fs.stat(ref.absolutePath)
    const classification = await inspectFile(ref.absolutePath, abortSignal)
    kind = classification.kind
    mediaType = classification.mediaType
  } catch (err) {
    if (abortSignal?.aborted) return [{ type: 'text', text: `[File ingest cancelled: ${ref.raw}]` }]
    const msg = errorMessage(err)
    return [{ type: 'text', text: `[Cannot read ${ref.raw}: ${msg}]` }]
  }

  if (kind === 'office' && stats.size > MAX_OFFICE_SOURCE_BYTES) {
    return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, stats.size, MAX_OFFICE_SOURCE_BYTES) }]
  }
  if (kind === 'pdf' && stats.size > MAX_PDF_SOURCE_BYTES) {
    return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, stats.size, MAX_PDF_SOURCE_BYTES) }]
  }
  if (kind === 'image' && stats.size > MAX_IMAGE_SOURCE_BYTES) {
    return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, stats.size, MAX_IMAGE_SOURCE_BYTES) }]
  }

  if (kind === 'binary') {
    return [
      {
        type: 'text',
        text: `[Unsupported binary file: ${ref.absolutePath} (${mediaType ?? 'unknown media type'}, ${formatBytes(stats.size)}).]`,
      },
    ]
  }

  if (kind === 'notebook') {
    if (stats.size > MAX_NOTEBOOK_SOURCE_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, stats.size, MAX_NOTEBOOK_SOURCE_BYTES) }]
    }
    try {
      const { text } = await renderNotebookFile(ref.absolutePath, abortSignal)
      return checkedTextAttachment(
        ref.absolutePath,
        wrapLocalText('file', text, { kind: 'notebook', path: ref.absolutePath }),
      )
    } catch (err) {
      return [{ type: 'text', text: `[Failed to read ${ref.raw}: ${errorMessage(err)}]` }]
    }
  }

  if (kind === 'text') {
    // Source size is only a cheap precheck. Line numbers, UTF conversion and
    // the source wrapper are measured again before the result is admitted.
    if (stats.size > MAX_INGEST_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, stats.size) }]
    }
    try {
      const body = await readTextFile(ref.absolutePath, abortSignal)
      return checkedTextAttachment(ref.absolutePath, wrapLocalText('file', body, { path: ref.absolutePath }))
    } catch (err) {
      const msg = errorMessage(err)
      return [{ type: 'text', text: `[Failed to read ${ref.raw}: ${msg}]` }]
    }
  }

  if (kind === 'office') {
    const extraction = await extractOfficeTextResult(ref.absolutePath, abortSignal, mediaType)
    if (!extraction.ok) return [{ type: 'text', text: extraction.text }]
    const { text } = extraction
    // Office binaries are usually much larger than their extracted text
    // (compression + media), so check post-extraction. A book-length .docx
    // can still exceed the cap.
    const textBytes = Buffer.byteLength(text, 'utf-8')
    if (textBytes > MAX_INGEST_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, textBytes) }]
    }
    return checkedTextAttachment(
      ref.absolutePath,
      wrapLocalText('file', text, { kind: 'office', path: ref.absolutePath }),
    )
  }

  if (kind === 'pdf') {
    const result = await processPdf(ref.absolutePath, {
      vision: caps.image,
      mode: 'auto',
      maxTextBytes: MAX_INGEST_BYTES - 8 * 1024,
      abortSignal,
      onNotice,
    })
    if (result.type === 'error') return [{ type: 'text', text: `[PDF processing failed: ${result.message}]` }]
    if (result.type === 'reference') return [{ type: 'text', text: formatPdfReference(result) }]
    const parts = toUserContentParts(result.parts)
    if (result.continuation) parts.push({ type: 'text', text: formatPdfReference(result.continuation) })
    parts.push({ type: 'text', text: BUILT_IN_MEDIA_ANALYSIS_NOTE })
    const totalTextBytes = parts.reduce(
      (total, part) => total + (part.type === 'text' ? Buffer.byteLength(part.text, 'utf-8') : 0),
      0,
    )
    if (totalTextBytes > MAX_INGEST_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, totalTextBytes) }]
    }
    return parts
  }

  // Audio always stays local: only timestamped transcription text enters the
  // model message, regardless of provider wire capabilities.
  if (kind === 'audio') {
    // Keep repeated native notices out of the UI without discarding changing
    // download/transcription percentages. The CLI renders these notices in a
    // single live status line, so forwarding progress does not flood history.
    let lastNotice = ''
    const deduplicatedNotice = onNotice
      ? (msg: string) => {
          if (msg === lastNotice) return
          lastNotice = msg
          onNotice(msg)
        }
      : undefined
    const result = await transcribeAudio(ref.absolutePath, { abortSignal, onNotice: deduplicatedNotice })
    if (typeof result === 'string') {
      return [{ type: 'text', text: result }]
    }
    const formatted = formatTranscription(result, ref.absolutePath)
    const textBytes = Buffer.byteLength(formatted, 'utf-8')
    if (textBytes > MAX_INGEST_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, textBytes) }]
    }
    return checkedTextAttachment(
      ref.absolutePath,
      `${wrapLocalText('file', formatted, { kind: 'audio-transcription', path: ref.absolutePath })}\n` +
        `[Note: this audio was transcribed locally via whisper.cpp. ` +
        `Only the timestamped text is visible; pauses, tone, and speaker identity are not captured.]\n` +
        BUILT_IN_MEDIA_ANALYSIS_NOTE,
    )
  }

  // Image bytes are normalized before either model delivery or OCR. This is
  // the shared safety gate for disguised formats, decompression bombs and
  // provider-rejected BMP/TIFF payloads.
  try {
    const buffer = await readFileWithinLimit(ref.absolutePath, MAX_IMAGE_SOURCE_BYTES, abortSignal)
    const effectiveMime = (await sniffImageMime(buffer)) ?? mediaType ?? 'application/octet-stream'
    const compressed = await compressImage(buffer, effectiveMime, {
      byteBudget: ATTACH_BYTE_BUDGET,
      abortSignal,
    })
    const finalMime = normalizeImageMime(compressed.mimeType)
    if (caps.image && !isModelAcceptedImage(finalMime, { modelId, animated: compressed.animated })) {
      return [
        {
          type: 'text',
          text: buildUnsupportedImageNotice(finalMime, ref.absolutePath, modelId, compressed.animated),
        },
      ]
    }
    if (
      compressed.failureReason ||
      compressed.data.length > ATTACH_BYTE_BUDGET ||
      compressed.width > MAX_EDGE_PX ||
      compressed.height > MAX_EDGE_PX
    ) {
      return [{ type: 'text', text: buildImageProcessingFailureNotice(ref.absolutePath, compressed) }]
    }

    if (caps.image) {
      const extension = finalMime === 'image/jpeg' ? 'jpg' : finalMime.slice('image/'.length)
      const originalName = path.parse(ref.absolutePath).name
      const parts: IngestedPart[] = [
        { type: 'text', text: openMediaTag('file', { kind: 'image', path: ref.absolutePath }) },
        {
          type: 'file',
          data: { type: 'data', data: compressed.data.toString('base64') },
          mediaType: finalMime,
          filename: `${originalName}.${extension}`,
        },
      ]
      if (compressed.changed) {
        parts.push({ type: 'text', text: buildCompressionCaption(compressed) })
        onNotice?.(`Normalized image: ${formatBytes(buffer.length)} → ${formatBytes(compressed.data.length)}`)
      }
      return parts
    }

    // Text-only providers receive local OCR. The file is not forwarded to a
    // different configured provider without an explicit product-level opt-in.
    const ocr = await ocrImage(compressed.data, { abortSignal })
    const ocrBytes = Buffer.byteLength(ocr, 'utf-8')
    if (ocrBytes > MAX_INGEST_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, ocrBytes) }]
    }
    return checkedTextAttachment(
      ref.absolutePath,
      `${wrapLocalText('file', ocr, { kind: 'image-ocr', path: ref.absolutePath })}\n[Note: the current model cannot natively see images. Only OCR text is available; visual content (layout, diagrams, photos) is NOT visible.]`,
    )
  } catch (err) {
    if (err instanceof FileSizeLimitError) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, err.observedBytes, err.limitBytes) }]
    }
    abortSignal?.throwIfAborted()
    const msg = errorMessage(err)
    return [{ type: 'text', text: `[Failed to attach image ${ref.raw}: ${msg}]` }]
  }
}

/**
 * Compose the content parts for a user message: original text first, then
 * one or more parts per ingested file. Returns a plain string when no
 * files were referenced, so simple prompts stay on the string fast path
 * (keeps existing provider behavior / caching semantics unchanged).
 */
export async function buildUserContent(
  text: string,
  caps: ProviderCapabilities,
  onNotice?: (msg: string) => void,
  abortSignal?: AbortSignal,
  onVisionUsage?: (event: VisionUsageEvent) => void,
  modelId?: string,
  readFileCache?: ReadFileCache,
): Promise<string | IngestedPart[]> {
  const refs = extractFileReferences(text)
  if (refs.length === 0) return text

  const parts: IngestedPart[] = [{ type: 'text', text }]
  const usage: AttachmentUsage = { mediaParts: 0, textBytes: 0, wireBytes: 0 }
  for (const ref of refs) {
    if (abortSignal?.aborted) break
    const ingested = await ingestFile(ref, caps, onNotice, abortSignal, onVisionUsage, modelId)
    const added = measureAttachment(ingested)
    const reason = attachmentBudgetReason(usage, added)
    if (reason) {
      const notice: IngestedPart[] = [
        { type: 'text', text: `[Attachment ${ref.raw} omitted: cumulative attachment budget exceeded (${reason}).]` },
      ]
      const noticeUsage = measureAttachment(notice)
      if (!attachmentBudgetReason(usage, noticeUsage)) {
        parts.push(...notice)
        addUsage(usage, noticeUsage)
      }
      continue
    }
    parts.push(...ingested)
    addUsage(usage, added)
    await rememberCompleteAttachment(readFileCache, ref.absolutePath, ingested)
  }
  return parts
}

function hasCompleteLocalFile(parts: IngestedPart[], filePath: string): boolean {
  const pathAttribute = `path="${escapeMediaAttribute(filePath)}"`
  return parts.some((part) => {
    if (part.type !== 'text' || !part.text.startsWith('<<file ')) return false
    const openingEnd = part.text.indexOf('>>')
    if (openingEnd === -1 || !part.text.slice(0, openingEnd).includes(pathAttribute)) return false
    return part.text.indexOf('<</file>>', openingEnd + 2) !== -1
  })
}

async function rememberCompleteAttachment(
  cache: ReadFileCache | undefined,
  filePath: string,
  parts: IngestedPart[],
): Promise<void> {
  if (!cache || !hasCompleteLocalFile(parts, filePath)) return
  const stats = await fs.stat(filePath).catch(() => null)
  if (stats) cache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size })
}
