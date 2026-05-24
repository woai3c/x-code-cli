// @x-code-cli/core — Attach-file-to-message pipeline
//
// Given a raw user prompt that references files (via `@path` or bare
// absolute paths), resolve each reference into an AI-SDK content part:
//
//   text / code  → TextPart with file body
//   PDF          → TextPart with extracted text (local, no tokens wasted on binary)
//   docx/xlsx/pptx → TextPart via officeparser/mammoth/xlsx
//   image        → ImagePart for multimodal providers; OCR'd TextPart for DeepSeek
//
// PDF is deliberately NOT sent as a FilePart even to multimodal providers
// when we can extract text locally — a 100-page text PDF becomes a few KB
// of prompt instead of tens of thousands of tokens of rendered pages.
import fs from 'node:fs/promises'
import path from 'node:path'

import type { FilePart, ImagePart, TextPart } from 'ai'

import type { ProviderCapabilities } from '../providers/capabilities.js'
import { USER_XCODE_DIR } from '../utils.js'
import { mediaTypeFor } from '../utils/media-type.js'
import { captionImage, pickVisionProvider } from './vision-fallback.js'

/** Where tesseract.js caches its language model weights (`eng.traineddata`,
 *  `chi_sim.traineddata`, ~7.6 MB total). Without this the worker writes
 *  them into process.cwd() — which means each project the user runs `xc` in
 *  re-downloads the same files, and untracked binaries leak into git status.
 *  Centralizing under `~/.x-code/tessdata/` makes the download a one-time
 *  cost shared across every project on the machine. */
async function tesseractCacheDir(): Promise<string> {
  const dir = path.join(USER_XCODE_DIR, 'tessdata')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** A content part resolved from a file reference. Same types the AI SDK
 *  accepts in user message `content` arrays, so callers can splice these
 *  directly into a UserModelMessage. */
export type IngestedPart = TextPart | ImagePart | FilePart

export type FileKind = 'text' | 'image' | 'pdf' | 'office' | 'unknown'

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** The human/model-facing message we substitute when an attachment is too
 *  large to inline. Mirrors Claude Code's `MaxFileReadTokenExceededError`
 *  message but adds the sub-agent escape hatch — for "summarize this whole
 *  novel" / "review this entire log" requests, chunk-by-chunk readFile
 *  iteration burns the parent context fast (each tool_result sticks around).
 *  Delegating to a sub-agent keeps only the summary in the parent. */
function tooLargeMessage(filePath: string, sizeBytes: number): string {
  return (
    `[File ${filePath} is too large to inline (${formatBytes(sizeBytes)}, ` +
    `cap ${formatBytes(MAX_INGEST_BYTES)}). ` +
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
  if (OFFICE_EXTENSIONS.has(ext)) return 'office'
  if (ext === '.pdf') return 'pdf'

  // Unknown extension — peek magic bytes.
  try {
    const { fileTypeFromFile } = await import('file-type')
    const detected = await fileTypeFromFile(filePath)
    if (!detected) return 'text' // Empty signature → assume plain text.
    if (detected.mime.startsWith('image/')) return 'image'
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
async function extractPdfText(filePath: string): Promise<string> {
  try {
    const { PDFParse } = await import('pdf-parse')
    const buffer = await fs.readFile(filePath)
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    try {
      const result = await parser.getText()
      return result.text ?? ''
    } finally {
      await parser.destroy().catch(() => {})
    }
  } catch {
    return ''
  }
}

/** Extract text from an Office document. Routes .docx through mammoth
 *  (best-in-class semantic extraction), .xlsx through SheetJS (CSV per
 *  sheet), everything else through officeparser. */
async function extractOfficeText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase()
  try {
    if (ext === '.docx') {
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ path: filePath })
      return result.value
    }
    if (ext === '.xlsx') {
      const XLSX = await import('xlsx')
      const wb = XLSX.readFile(filePath)
      const parts: string[] = []
      for (const sheetName of wb.SheetNames) {
        const sheet = wb.Sheets[sheetName]
        if (!sheet) continue
        parts.push(`--- Sheet: ${sheetName} ---\n${XLSX.utils.sheet_to_csv(sheet)}`)
      }
      return parts.join('\n\n')
    }
    // .pptx, .odt, .ods, .odp — officeparser handles these.
    const { OfficeParser } = await import('officeparser')
    const ast = await OfficeParser.parseOffice(filePath)
    return ast.toText()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `[Failed to extract text from ${path.basename(filePath)}: ${msg}]`
  }
}

/** OCR an image via tesseract.js. Loads Chinese + English language packs on
 *  first call (cached in-memory afterwards). Accuracy is limited, especially
 *  for handwriting or stylized text — intended as a text-extraction fallback
 *  for providers that can't natively see images. */
export async function ocrImage(filePath: string): Promise<string> {
  try {
    const { createWorker } = await import('tesseract.js')
    const worker = await createWorker(['eng', 'chi_sim'], 1, {
      cachePath: await tesseractCacheDir(),
    })
    try {
      const { data } = await worker.recognize(filePath)
      return data.text ?? ''
    } finally {
      await worker.terminate()
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `[OCR failed: ${msg}]`
  }
}

/** OCR every page of a PDF by rasterizing first. Used for scanned PDFs when
 *  pdf-parse's text extraction returns little/no text. Rasterization uses
 *  pdf-parse's own getScreenshot (pdfjs under the hood), so we don't need
 *  a separate pdf-to-img dependency. */
async function ocrPdf(filePath: string): Promise<string> {
  try {
    const { PDFParse } = await import('pdf-parse')
    const buffer = await fs.readFile(filePath)
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    let screenshots: { pages: Array<{ pageNumber: number; data?: Uint8Array }> }
    try {
      screenshots = (await parser.getScreenshot({ scale: 2, imageBuffer: true })) as typeof screenshots
    } finally {
      await parser.destroy().catch(() => {})
    }

    const { createWorker } = await import('tesseract.js')
    const worker = await createWorker(['eng', 'chi_sim'], 1, {
      cachePath: await tesseractCacheDir(),
    })
    try {
      const out: string[] = []
      for (const page of screenshots.pages) {
        if (!page.data) continue
        const { data } = await worker.recognize(Buffer.from(page.data))
        out.push(`--- Page ${page.pageNumber} ---\n${data.text ?? ''}`)
      }
      return out.join('\n\n')
    } finally {
      await worker.terminate()
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
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
): Promise<IngestedPart[]> {
  let kind: FileKind
  let stats: Awaited<ReturnType<typeof fs.stat>>
  try {
    stats = await fs.stat(ref.absolutePath)
    kind = await classifyFile(ref.absolutePath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [{ type: 'text', text: `[Cannot read ${ref.raw}: ${msg}]` }]
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
      const msg = err instanceof Error ? err.message : String(err)
      return [{ type: 'text', text: `[Failed to read ${ref.raw}: ${msg}]` }]
    }
  }

  if (kind === 'office') {
    const text = await extractOfficeText(ref.absolutePath)
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
    const extracted = await extractPdfText(ref.absolutePath)
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
        const buffer = await fs.readFile(ref.absolutePath)
        return [{ type: 'file', data: buffer, mediaType: 'application/pdf', filename: path.basename(ref.absolutePath) }]
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return [{ type: 'text', text: `[Failed to attach PDF ${ref.raw}: ${msg}]` }]
      }
    }
    // DeepSeek + scanned PDF: OCR locally.
    const ocr = await ocrPdf(ref.absolutePath)
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

  // Image.
  if (caps.image) {
    try {
      const buffer = await fs.readFile(ref.absolutePath)
      return [
        { type: 'text', text: `<<file path="${ref.absolutePath}" kind="image">>` },
        { type: 'image', image: buffer, mediaType: mediaTypeFor(ref.absolutePath) },
      ]
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
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
      const caption = await captionImage(ref.absolutePath, sub)
      onNotice?.(`Captioned image via ${sub.modelId}`)
      return [
        {
          type: 'text',
          text: `<<file path="${ref.absolutePath}" kind="image-caption" via="${sub.modelId}">>\n${caption}\n<</file>>\n[Note: the current model cannot see images. The above description was generated by ${sub.label} (vision sub-agent), not the current model. For complex visual tasks, /model switch to a vision-capable model and ask follow-ups directly.]`,
        },
      ]
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onNotice?.(`Vision sub-agent (${sub.label}) failed: ${msg} — falling back to OCR`)
      // fall through to OCR
    }
  }

  // DeepSeek + image, no sub-agent (or sub-agent failed): OCR. Warn the model
  // that this is not true image understanding so it doesn't confidently
  // describe colors/layout/etc.
  const ocr = await ocrImage(ref.absolutePath)
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
): Promise<string | Array<TextPart | ImagePart | FilePart>> {
  const refs = extractFileReferences(text)
  if (refs.length === 0) return text

  const parts: IngestedPart[] = [{ type: 'text', text }]
  for (const ref of refs) {
    const ingested = await ingestFile(ref, caps, onNotice)
    parts.push(...ingested)
  }
  return parts
}
