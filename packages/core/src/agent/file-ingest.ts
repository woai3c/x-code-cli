// @x-code-cli/core — Attach-file-to-message pipeline
//
// Given a raw user prompt that references files (via `@path` or bare
// absolute paths), resolve each reference into an AI-SDK content part:
//
//   text / code  → TextPart with file body
//   PDF          → TextPart with extracted text (local, no tokens wasted on binary)
//   docx/xlsx/pptx → TextPart via bounded format-specific parsers
//   image        → ImagePart for multimodal providers; OCR'd TextPart for DeepSeek
//
// PDF is deliberately NOT sent as a FilePart even to multimodal providers
// when we can extract text locally — a 100-page text PDF becomes a few KB
// of prompt instead of tens of thousands of tokens of rendered pages.
import fs from 'node:fs/promises'
import path from 'node:path'

import type { FilePart, ImagePart, TextPart } from 'ai'

import type { ProviderCapabilities } from '../providers/capabilities.js'
import {
  buildUnsupportedImageNotice,
  isModelAcceptedImageMime,
  normalizeImageMime,
  sniffImageMime,
} from '../providers/capabilities.js'
import { debugLog, errorMessage, truncateUtf8, userXcodeDir } from '../utils.js'
import {
  ATTACH_BYTE_BUDGET,
  MAX_EDGE_PX,
  buildCompressionCaption,
  compressImage,
  formatBytes,
} from '../utils/image-compress.js'
import { mediaTypeFor } from '../utils/media-type.js'
import { formatTranscription, transcribeAudio } from './audio-transcribe.js'
import { captionImage, pickVisionProvider } from './vision-fallback.js'
import type { VisionUsageEvent } from './vision-fallback.js'

/** Where tesseract.js caches its language model weights (`eng.traineddata`,
 *  `chi_sim.traineddata`, ~7.6 MB total). Without this the worker writes
 *  them into process.cwd() — which means each project the user runs `xc` in
 *  re-downloads the same files, and untracked binaries leak into git status.
 *  Centralizing under `~/.x-code/tessdata/` makes the download a one-time
 *  cost shared across every project on the machine. */
async function tesseractCacheDir(): Promise<string> {
  const dir = path.join(userXcodeDir(), 'tessdata')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** A content part resolved from a file reference. Same types the AI SDK
 *  accepts in user message `content` arrays, so callers can splice these
 *  directly into a UserModelMessage. */
export type IngestedPart = TextPart | ImagePart | FilePart

export type FileKind = 'text' | 'image' | 'pdf' | 'office' | 'audio' | 'unknown'

/** Paths the user pointed at, either via `@file` or a bare absolute path. */
export interface FileReference {
  /** Original token from the user's input (for echoing/UI). */
  raw: string
  /** Resolved absolute path. */
  absolutePath: string
}

/** Extensions we treat as inline text without inspection. Order doesn't
 *  matter; this is just a membership check. */
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.mdx',
  '.rst',
  '.log',
  '.csv',
  '.tsv',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.env',
  '.cfg',
  '.conf',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.h',
  '.cpp',
  '.cc',
  '.hpp',
  '.cs',
  '.php',
  '.pl',
  '.lua',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.sql',
  '.graphql',
  '.gql',
  '.proto',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.vue',
  '.svelte',
  '.xml',
  '.svg',
  '.dockerfile',
  '.makefile',
  '.gitignore',
  '.editorconfig',
])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.m4a',
  '.ogg',
  '.flac',
  '.aac',
  '.aiff',
  '.aif',
  '.wma',
  '.webm',
  '.opus',
])
const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp'])

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
export const MAX_INGEST_BYTES = 256 * 1024
export const MAX_OFFICE_SOURCE_BYTES = 20 * 1024 * 1024
export const MAX_PDF_SOURCE_BYTES = 20 * 1024 * 1024
export const MAX_IMAGE_SOURCE_BYTES = 25 * 1024 * 1024
const MAX_PDF_TEXT_PAGES = 200
const MAX_PDF_OCR_PAGES = 20
const MAX_SPREADSHEET_SHEETS = 32
const MAX_SPREADSHEET_ROWS = 10_000
const MAX_SPREADSHEET_CELLS = 100_000
const MAX_OFFICE_ARCHIVE_ENTRIES = 1_000
const MAX_OFFICE_UNCOMPRESSED_BYTES = 32 * 1024 * 1024

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

/** Classify a file by extension first, falling back to magic-byte detection
 *  when the extension is missing or unrecognized. */
export async function classifyFile(filePath: string): Promise<FileKind> {
  const ext = path.extname(filePath).toLowerCase()
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (OFFICE_EXTENSIONS.has(ext)) return 'office'
  if (ext === '.pdf') return 'pdf'

  // Unknown extension — peek magic bytes.
  try {
    const { fileTypeFromFile } = await import('file-type')
    const detected = await fileTypeFromFile(filePath)
    if (!detected) return 'text' // Empty signature → assume plain text.
    if (detected.mime.startsWith('image/')) return 'image'
    if (detected.mime.startsWith('audio/')) return 'audio'
    if (detected.mime === 'application/pdf') return 'pdf'
    if (detected.mime.includes('officedocument') || detected.mime.includes('opendocument')) return 'office'
    if (detected.mime.startsWith('text/')) return 'text'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Extract plain-text references from a user prompt. Two syntaxes are
 * recognized:
 *
 *   1. `@path` — the `@` prefix marks an explicit attachment. Stops at
 *      whitespace. Honors Windows (`D:\foo\bar`) and POSIX (`/etc/foo`)
 *      absolute paths.
 *
 *   2. Bare absolute paths — any token that looks like `C:\…`, `D:\…`, or
 *      starts with `/` and contains at least one path separator, with an
 *      extension. Less aggressive than @-mention: only fires on tokens that
 *      clearly look like paths, to avoid hijacking regex/SQL/etc.
 *
 * Duplicates are de-duplicated by absolute path so a file referenced twice
 * only gets ingested once.
 */
export function extractFileReferences(input: string): FileReference[] {
  const refs = new Map<string, FileReference>()

  // @path — one token, stops at whitespace. `@` must be at line start or
  // preceded by whitespace so we don't eat `@user@host` email-ish tokens.
  const atRegex = /(?:^|\s)@((?:[A-Za-z]:[\\/]|[\\/])[^\s]+|[^\s@][^\s]*)/g
  for (const m of input.matchAll(atRegex)) {
    const raw = m[1] ?? ''
    if (!raw) continue
    const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(raw)
    refs.set(abs, { raw: `@${raw}`, absolutePath: abs })
  }

  // Bare absolute paths. Require a separator + extension so code snippets
  // like `fs.readFile` don't match. Windows drive letters + POSIX roots only.
  const bareRegex = /(?:^|\s)((?:[A-Za-z]:[\\/]|\/)[^\s]*\.[A-Za-z0-9]{1,8})/g
  for (const m of input.matchAll(bareRegex)) {
    const raw = m[1] ?? ''
    if (!raw) continue
    const abs = path.normalize(raw)
    if (!refs.has(abs)) refs.set(abs, { raw, absolutePath: abs })
  }

  return [...refs.values()]
}

/** Read a file as a numbered text block — the same format the read-file
 *  tool produces, so the model sees a consistent representation whether
 *  the file was inlined up-front or fetched on demand. */
async function readTextFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, 'utf-8')
  const lines = content.split('\n')
  return lines.map((line, i) => `${i + 1}\t${line}`).join('\n')
}

/** Extract plain text from a PDF. Uses pdf-parse's class-based v2 API
 *  (PDFParse.getText). Returns an empty string on failure; the caller
 *  decides whether to fall back to OCR. */
async function extractPdfText(filePath: string, abortSignal?: AbortSignal): Promise<string> {
  try {
    abortSignal?.throwIfAborted()
    const { PDFParse } = await import('pdf-parse')
    const buffer = await fs.readFile(filePath, { signal: abortSignal })
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    try {
      const result = await parser.getText({ first: MAX_PDF_TEXT_PAGES })
      const suffix =
        result.total > MAX_PDF_TEXT_PAGES ? `\n\n[PDF text limited to first ${MAX_PDF_TEXT_PAGES} pages.]` : ''
      return (result.text ?? '') + suffix
    } finally {
      await parser.destroy().catch(() => {})
    }
  } catch {
    abortSignal?.throwIfAborted()
    return ''
  }
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

async function extractZippedOfficeText(filePath: string, ext: string, abortSignal?: AbortSignal): Promise<string> {
  const { strFromU8, unzip } = await import('fflate')
  const archive = await fs.readFile(filePath, { signal: abortSignal })
  let entryCount = 0
  let uncompressedBytes = 0
  const wanted = (name: string): boolean =>
    ext === '.pptx' ? /^ppt\/slides\/slide\d+\.xml$/i.test(name) : name === 'content.xml'
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
      ext === '.pptx' ? `--- Slide ${Number(/slide(\d+)\.xml$/i.exec(name)?.[1] ?? parts.length + 1)} ---\n` : ''
    const available = MAX_INGEST_BYTES - outputBytes - Buffer.byteLength(prefix, 'utf8')
    if (available <= 0) break
    const bounded = truncateUtf8(text, available)
    parts.push(prefix + bounded)
    outputBytes += Buffer.byteLength(prefix + bounded, 'utf8')
  }
  return parts.join('\n\n')
}

/** Extract text from an Office document with bounded, format-specific parsers. */
export async function extractOfficeText(filePath: string, abortSignal?: AbortSignal): Promise<string> {
  const ext = path.extname(filePath).toLowerCase()
  try {
    abortSignal?.throwIfAborted()
    const stats = await fs.stat(filePath)
    if (stats.size > MAX_OFFICE_SOURCE_BYTES) {
      return `[Office file is too large to parse safely: ${formatBytes(stats.size)} (cap ${formatBytes(MAX_OFFICE_SOURCE_BYTES)}).]`
    }
    if (ext === '.docx') {
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ path: filePath })
      return result.value
    }
    if (ext === '.xlsx') {
      const { default: readExcelFile } = await import('read-excel-file/node')
      const sheets = await readExcelFile(filePath)
      const parts: string[] = []
      let outputBytes = 0
      let rowCount = 0
      let cellCount = 0
      let truncated = false
      const csvCell = (value: unknown): string => {
        const text = value instanceof Date ? value.toISOString() : value == null ? '' : String(value)
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
      }
      for (const sheet of sheets.slice(0, MAX_SPREADSHEET_SHEETS)) {
        const header = `--- Sheet: ${sheet.sheet} ---\n`
        const headerBytes = Buffer.byteLength(header, 'utf-8')
        if (outputBytes + headerBytes > MAX_INGEST_BYTES) {
          truncated = true
          break
        }
        const lines: string[] = [header.trimEnd()]
        outputBytes += headerBytes
        for (const row of sheet.data) {
          rowCount++
          cellCount += row.length
          if (rowCount > MAX_SPREADSHEET_ROWS || cellCount > MAX_SPREADSHEET_CELLS) {
            truncated = true
            break
          }
          const line = row.map(csvCell).join(',') + '\n'
          const lineBytes = Buffer.byteLength(line, 'utf-8')
          if (outputBytes + lineBytes > MAX_INGEST_BYTES) {
            truncated = true
            break
          }
          lines.push(line.trimEnd())
          outputBytes += lineBytes
        }
        parts.push(lines.join('\n'))
        if (truncated) break
      }
      if (sheets.length > MAX_SPREADSHEET_SHEETS) truncated = true
      if (truncated) parts.push('[Spreadsheet extraction truncated at configured sheet, row, cell, or byte limit.]')
      return parts.join('\n\n')
    }
    return extractZippedOfficeText(filePath, ext, abortSignal)
  } catch (err) {
    abortSignal?.throwIfAborted()
    const msg = errorMessage(err)
    return `[Failed to extract text from ${path.basename(filePath)}: ${msg}]`
  }
}

// ── Shared tesseract.js worker pool ──
// A single worker is reused across ocrImage / ocrPdf calls within a session.
// Auto-terminates after WORKER_IDLE_MS of inactivity to avoid holding WASM
// memory indefinitely. The worker accepts both file paths and Buffers, so
// callers never need to write temp files.

const WORKER_IDLE_MS = 30_000
let sharedWorker: Awaited<ReturnType<(typeof import('tesseract.js'))['createWorker']>> | null = null
let workerIdleTimer: ReturnType<typeof setTimeout> | null = null

async function getOcrWorker() {
  if (sharedWorker) {
    if (workerIdleTimer) clearTimeout(workerIdleTimer)
    workerIdleTimer = setTimeout(terminateWorker, WORKER_IDLE_MS)
    return sharedWorker
  }
  const { createWorker } = await import('tesseract.js')
  sharedWorker = await createWorker(['eng', 'chi_sim'], 1, {
    cachePath: await tesseractCacheDir(),
  })
  workerIdleTimer = setTimeout(terminateWorker, WORKER_IDLE_MS)
  return sharedWorker
}

function terminateWorker() {
  if (sharedWorker) {
    void sharedWorker.terminate().catch(() => {})
    sharedWorker = null
  }
  if (workerIdleTimer) {
    clearTimeout(workerIdleTimer)
    workerIdleTimer = null
  }
}

/** OCR an image via tesseract.js. Accepts a file path OR an in-memory Buffer.
 *  Uses a shared worker that auto-terminates after 30 s idle. Loads Chinese +
 *  English language packs on first call. Accuracy is limited, especially for
 *  handwriting or stylized text — intended as a text-extraction fallback for
 *  providers that can't natively see images. */
export async function ocrImage(input: string | Buffer): Promise<string> {
  try {
    const worker = await getOcrWorker()
    const { data } = await worker.recognize(input)
    return data.text ?? ''
  } catch (err) {
    const msg = errorMessage(err)
    return `[OCR failed: ${msg}]`
  }
}

/** OCR every page of a PDF by rasterizing first. Used for scanned PDFs when
 *  pdf-parse's text extraction returns little/no text. Rasterization uses
 *  pdf-parse's own getScreenshot (pdfjs under the hood), so we don't need
 *  a separate pdf-to-img dependency. */
async function ocrPdf(filePath: string, abortSignal?: AbortSignal): Promise<string> {
  try {
    abortSignal?.throwIfAborted()
    const { PDFParse } = await import('pdf-parse')
    const buffer = await fs.readFile(filePath, { signal: abortSignal })
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    let screenshots: { pages: Array<{ pageNumber: number; data?: Uint8Array }>; total: number }
    try {
      screenshots = (await parser.getScreenshot({
        first: MAX_PDF_OCR_PAGES,
        scale: 1.5,
        imageDataUrl: false,
        imageBuffer: true,
      })) as typeof screenshots
    } finally {
      await parser.destroy().catch(() => {})
    }

    const out: string[] = []
    let outputBytes = 0
    for (const page of screenshots.pages) {
      abortSignal?.throwIfAborted()
      if (!page.data) continue
      const text = await ocrImage(Buffer.from(page.data))
      const block = `--- Page ${page.pageNumber} ---\n${text}`
      outputBytes += Buffer.byteLength(block, 'utf-8')
      if (outputBytes > MAX_INGEST_BYTES) {
        out.push('[PDF OCR output truncated at attachment byte limit.]')
        break
      }
      out.push(block)
    }
    if (screenshots.total > MAX_PDF_OCR_PAGES) out.push(`[PDF OCR limited to first ${MAX_PDF_OCR_PAGES} pages.]`)
    return out.join('\n\n')
  } catch (err) {
    abortSignal?.throwIfAborted()
    const msg = errorMessage(err)
    return `[PDF OCR failed: ${msg}]`
  }
}

/**
 * Resolve a single file reference into one or more content parts, taking
 * the active provider's multi-modal capabilities into account.
 *
 * Contract:
 *  - Text, Office, and text-bearing PDFs always collapse to a single
 *    TextPart — cheapest path, works for every provider.
 *  - Images: ImagePart if the provider can see images; otherwise OCR'd
 *    TextPart annotated as a fallback.
 *  - Scanned PDFs (pdf-parse yields near-empty text): FilePart for providers
 *    with PDF support; OCR'd TextPart otherwise.
 *  - Missing/unreadable files return a TextPart carrying the error so the
 *    model can acknowledge the failure rather than silently ignore it.
 */
export async function ingestFile(
  ref: FileReference,
  caps: ProviderCapabilities,
  onNotice?: (msg: string) => void,
  abortSignal?: AbortSignal,
  onVisionUsage?: (event: VisionUsageEvent) => void,
): Promise<IngestedPart[]> {
  if (abortSignal?.aborted) {
    return [{ type: 'text', text: `[File ingest cancelled: ${ref.raw}]` }]
  }

  let kind: FileKind
  let stats: Awaited<ReturnType<typeof fs.stat>>
  try {
    stats = await fs.stat(ref.absolutePath)
    kind = await classifyFile(ref.absolutePath)
  } catch (err) {
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

  if (kind === 'text' || kind === 'unknown') {
    // For text files, on-disk byte size is a tight upper bound on the
    // inlined text size (numbered-line wrapper adds <1% overhead). Check
    // before reading so we don't pull a multi-MB file into memory just to
    // discard it.
    if (stats.size > MAX_INGEST_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, stats.size) }]
    }
    try {
      const body = await readTextFile(ref.absolutePath)
      return [{ type: 'text', text: `<<file path="${ref.absolutePath}">>\n${body}\n<</file>>` }]
    } catch (err) {
      const msg = errorMessage(err)
      return [{ type: 'text', text: `[Failed to read ${ref.raw}: ${msg}]` }]
    }
  }

  if (kind === 'office') {
    const text = await extractOfficeText(ref.absolutePath, abortSignal)
    // Office binaries are usually much larger than their extracted text
    // (compression + media), so check post-extraction. A book-length .docx
    // can still exceed the cap.
    const textBytes = Buffer.byteLength(text, 'utf-8')
    if (textBytes > MAX_INGEST_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, textBytes) }]
    }
    return [{ type: 'text', text: `<<file path="${ref.absolutePath}" kind="office">>\n${text}\n<</file>>` }]
  }

  if (kind === 'pdf') {
    const extracted = await extractPdfText(ref.absolutePath, abortSignal)
    // Heuristic: a "real" text PDF yields at least a couple hundred chars.
    // Scanned PDFs typically yield empty strings or a few stray ligatures.
    if (extracted.trim().length > 200) {
      const textBytes = Buffer.byteLength(extracted, 'utf-8')
      if (textBytes > MAX_INGEST_BYTES) {
        return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, textBytes) }]
      }
      return [{ type: 'text', text: `<<file path="${ref.absolutePath}" kind="pdf-text">>\n${extracted}\n<</file>>` }]
    }
    // Scanned / image-based PDF.
    if (caps.pdf) {
      try {
        const buffer = await fs.readFile(ref.absolutePath, { signal: abortSignal })
        // base64 string, not the Buffer: this part is persisted to the session
        // jsonl via JSON.stringify, and a Buffer round-trips as
        // {"type":"Buffer","data":[...]} — which fails the SDK's ModelMessage
        // schema on resume.
        return [
          {
            type: 'file',
            data: buffer.toString('base64'),
            mediaType: 'application/pdf',
            filename: path.basename(ref.absolutePath),
          },
        ]
      } catch (err) {
        const msg = errorMessage(err)
        return [{ type: 'text', text: `[Failed to attach PDF ${ref.raw}: ${msg}]` }]
      }
    }
    // DeepSeek + scanned PDF: OCR locally.
    const ocr = await ocrPdf(ref.absolutePath, abortSignal)
    const ocrBytes = Buffer.byteLength(ocr, 'utf-8')
    if (ocrBytes > MAX_INGEST_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, ocrBytes) }]
    }
    return [
      {
        type: 'text',
        text: `<<file path="${ref.absolutePath}" kind="pdf-ocr">>\n${ocr}\n<</file>>\n[Note: this PDF was OCR'd locally because the current model does not support PDF input; accuracy is limited.]`,
      },
    ]
  }

  // Audio — two strategies depending on provider capabilities:
  //  1. Provider supports audio input (OpenAI, Google) → send the raw audio
  //     as a FilePart so the model handles speech recognition natively.
  //     This is higher quality: captures pauses, tone, speaker identity, etc.
  //  2. Provider does NOT support audio → transcribe locally via whisper.cpp
  //     and send only the timestamped text. Still useful, just lower fidelity.
  if (kind === 'audio') {
    if (caps.audio) {
      if (stats.size > MAX_INGEST_BYTES) {
        return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, stats.size) }]
      }
      try {
        const buffer = await fs.readFile(ref.absolutePath, { signal: abortSignal })
        const mime = (await import('../utils/media-type.js')).mediaTypeFor(ref.absolutePath)
        return [
          { type: 'text', text: `<<file path="${ref.absolutePath}" kind="audio">>` },
          {
            type: 'file',
            data: buffer.toString('base64'),
            mediaType: mime,
            filename: path.basename(ref.absolutePath),
          },
        ]
      } catch (err) {
        const msg = errorMessage(err)
        return [{ type: 'text', text: `[Failed to attach audio ${ref.raw}: ${msg}]` }]
      }
    }

    // Provider doesn't support audio input — fall back to local whisper transcription.
    // onNotice appends a new UI line each call, so only forward key milestones
    // (first-time download notice, "transcribing…", "done"). Download
    // percentage ticks go to debugLog only.
    let lastNotice = ''
    const throttledNotice = onNotice
      ? (msg: string) => {
          if (msg === lastNotice) return
          const isPercentageTick = /^Downloading whisper model: \d/.test(msg)
          if (isPercentageTick) {
            debugLog('audio-transcribe', msg)
            return
          }
          lastNotice = msg
          onNotice(msg)
        }
      : undefined
    const result = await transcribeAudio(ref.absolutePath, { abortSignal, onNotice: throttledNotice })
    if (typeof result === 'string') {
      return [{ type: 'text', text: result }]
    }
    const formatted = formatTranscription(result, ref.absolutePath)
    const textBytes = Buffer.byteLength(formatted, 'utf-8')
    if (textBytes > MAX_INGEST_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, textBytes) }]
    }
    return [
      {
        type: 'text',
        text:
          `<<file path="${ref.absolutePath}" kind="audio-transcription">>\n${formatted}\n<</file>>\n` +
          `[Note: this audio was transcribed locally via whisper.cpp because the current model does not support audio input. ` +
          `Only the timestamped text is visible; pauses, tone, and speaker identity are not captured.]`,
      },
    ]
  }

  // Image.
  if (caps.image) {
    try {
      const buffer = await fs.readFile(ref.absolutePath, { signal: abortSignal })
      // Gate on the sniffed bytes, not the extension: an unsupported format
      // (AVIF, BMP, TIFF, HEIC) or a mislabeled file would be rejected by the
      // provider with a 400 — and since the message persists in the session,
      // every later request would fail too (session poisoning).
      const sniffed = await sniffImageMime(buffer)
      const effectiveMime = sniffed ?? mediaTypeFor(ref.absolutePath)
      if (!isModelAcceptedImageMime(effectiveMime)) {
        return [{ type: 'text', text: buildUnsupportedImageNotice(effectiveMime, ref.absolutePath) }]
      }

      // Compress oversized images to fit pixel + byte budget.
      const compressed = await compressImage(buffer, effectiveMime, { byteBudget: ATTACH_BYTE_BUDGET })
      if (
        compressed.data.length > ATTACH_BYTE_BUDGET ||
        compressed.width > MAX_EDGE_PX ||
        compressed.height > MAX_EDGE_PX
      ) {
        return [
          {
            type: 'text',
            text: `[Image ${ref.absolutePath} could not be reduced to provider limits (${formatBytes(compressed.data.length)}, ${compressed.width}x${compressed.height}).]`,
          },
        ]
      }
      const finalMime = normalizeImageMime(compressed.changed ? compressed.mimeType : effectiveMime)

      const parts: IngestedPart[] = [
        { type: 'text', text: `<<file path="${ref.absolutePath}" kind="image">>` },
        { type: 'image', image: compressed.data.toString('base64'), mediaType: finalMime },
      ]
      if (compressed.changed) {
        parts.push({ type: 'text', text: buildCompressionCaption(compressed) })
        onNotice?.(`Compressed image: ${formatBytes(buffer.length)} → ${formatBytes(compressed.data.length)}`)
      }
      return parts
    } catch (err) {
      const msg = errorMessage(err)
      return [{ type: 'text', text: `[Failed to attach image ${ref.raw}: ${msg}]` }]
    }
  }

  // Text-only provider (DeepSeek, custom). Prefer a vision sub-agent if any
  // other multimodal provider has a key configured — caption captures both
  // text and visual content, OCR only catches text. Falls through to OCR
  // when no sub-agent is available, or when the sub-agent call fails.
  const sub = pickVisionProvider()
  if (sub) {
    try {
      const caption = await captionImage(ref.absolutePath, sub, { abortSignal, onUsage: onVisionUsage })
      const captionBytes = Buffer.byteLength(caption, 'utf-8')
      if (captionBytes > MAX_INGEST_BYTES) {
        return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, captionBytes) }]
      }
      onNotice?.(`Captioned image via ${sub.modelId}`)
      return [
        {
          type: 'text',
          text: `<<file path="${ref.absolutePath}" kind="image-caption" via="${sub.modelId}">>\n${caption}\n<</file>>\n[Note: the current model cannot see images. The above description was generated by ${sub.label} (vision sub-agent), not the current model. For complex visual tasks, /model switch to a vision-capable model and ask follow-ups directly.]`,
        },
      ]
    } catch (err) {
      const msg = errorMessage(err)
      onNotice?.(`Vision sub-agent (${sub.label}) failed: ${msg} — falling back to OCR`)
      // fall through to OCR
    }
  }

  // DeepSeek + image, no sub-agent (or sub-agent failed): OCR. Warn the model
  // that this is not true image understanding so it doesn't confidently
  // describe colors/layout/etc.
  const ocr = await ocrImage(ref.absolutePath)
  const ocrBytes = Buffer.byteLength(ocr, 'utf-8')
  if (ocrBytes > MAX_INGEST_BYTES) {
    return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, ocrBytes) }]
  }
  return [
    {
      type: 'text',
      text: `<<file path="${ref.absolutePath}" kind="image-ocr">>\n${ocr}\n<</file>>\n[Note: the current model cannot natively see images. Only OCR text is available; visual content (layout, diagrams, photos) is NOT visible.]`,
    },
  ]
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
): Promise<string | Array<TextPart | ImagePart | FilePart>> {
  const refs = extractFileReferences(text)
  if (refs.length === 0) return text

  const parts: IngestedPart[] = [{ type: 'text', text }]
  for (const ref of refs) {
    if (abortSignal?.aborted) break
    const ingested = await ingestFile(ref, caps, onNotice, abortSignal, onVisionUsage)
    parts.push(...ingested)
  }
  return parts
}
