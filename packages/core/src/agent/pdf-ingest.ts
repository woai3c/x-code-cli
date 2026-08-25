import path from 'node:path'
import { Worker } from 'node:worker_threads'

import { isModelAcceptedImageMime, normalizeImageMime } from '../providers/capabilities.js'
import { errorMessage, truncateUtf8 } from '../utils.js'
import { FileSizeLimitError, readFileWithinLimit } from '../utils/bounded-read.js'
import { ATTACH_BYTE_BUDGET, MAX_EDGE_PX, compressImage } from '../utils/image-compress.js'
import { ocrImage } from './image-ocr.js'
import { openMediaTag } from './local-media.js'
import type { ProcessedLocalPart, StandardImageMediaType } from './local-media.js'
import type { PdfRenderRequest, PdfRenderResponse, PdfRenderResult } from './pdf-render-protocol.js'

export const MAX_PDF_SOURCE_BYTES = 20 * 1024 * 1024
export const PDF_TEXT_PAGE_MIN_CHARS = 80
export const PDF_TEXT_PAGE_MAX_REPLACEMENT_RATIO = 0.1
export const PDF_RENDER_WIDTH = 1600
export const PDF_RENDER_MAX_PIXELS = 16_000_000
export const PDF_AUTO_MAX_RENDERED_PAGES = 10
export const PDF_READ_MAX_PAGES = 20
export const PDF_MAX_RENDERED_BYTES = 15 * 1024 * 1024
export const PDF_MAX_TEXT_BYTES = 256 * 1024
export const PDF_ANALYSIS_PAGE_LIMIT = 200
export const PDF_MAX_DECLARED_PAGES = 2_000
const PDF_PROCESS_TIMEOUT_MS = 120_000
const PDF_WORKER_OPERATION_TIMEOUT_MS = 30_000

export type PdfMode = 'auto' | 'text-only' | 'visual'
export type PdfPageKind = 'text' | 'visual' | 'both'

export interface PdfPageAnalysis {
  pageNumber: number
  text: string
  normalizedChars: number
  replacementRatio: number
  hasExtractedText: boolean
  hasUsableText: boolean
  needsVisual: boolean
  kind: PdfPageKind
}

export interface PdfAnalysis {
  filePath: string
  size: number
  totalPages: number
  analyzedPages: number
  pages: PdfPageAnalysis[]
  truncated: boolean
}

export interface PdfPageRange {
  first: number
  last: number
}

export interface ProcessPdfOptions {
  pageRange?: PdfPageRange
  vision: boolean
  mode?: PdfMode
  maxTextBytes?: number
  maxRenderedPages?: number
  maxRenderedBytes?: number
  abortSignal?: AbortSignal
  onNotice?: (message: string) => void
}

export interface PdfReference {
  type: 'reference'
  filePath: string
  size: number
  totalPages: number
  reason: 'too-many-visual-pages' | 'text-budget' | 'analysis-page-limit' | 'rendered-byte-budget'
  processedPages: number[]
  remainingPages: string[]
  suggestedPages: string
}

export type ProcessPdfResult =
  | {
      type: 'content'
      analysis: PdfAnalysis
      parts: ProcessedLocalPart[]
      continuation?: PdfReference
    }
  | PdfReference
  | {
      type: 'error'
      code: 'empty' | 'too-large' | 'password-protected' | 'corrupted' | 'invalid-range' | 'render-failed'
      message: string
    }

interface PendingRequest {
  resolve: (result: PdfRenderResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class PdfWorkerFailure extends Error {
  override readonly name = 'PdfWorkerFailure'
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError')
}

function pdfWorkerUrl(): URL {
  const current = new URL(import.meta.url)
  if (current.pathname.endsWith('/src/agent/pdf-ingest.ts')) {
    return new URL('../../dist/agent/pdf-render-worker.js', current)
  }
  if (current.pathname.includes('/chunks/')) return new URL('../pdf-render-worker.js', current)
  return new URL('./pdf-render-worker.js', current)
}

class PdfWorkerClient {
  private readonly worker: Worker
  private readonly pending = new Map<number, PendingRequest>()
  private readonly abortSignal?: AbortSignal
  private nextId = 1
  private terminated = false

  constructor(abortSignal?: AbortSignal) {
    this.abortSignal = abortSignal
    this.worker = new Worker(pdfWorkerUrl(), {
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 512, stackSizeMb: 8 },
    })
    this.worker.on('message', (response: PdfRenderResponse) => this.handleResponse(response))
    this.worker.on('error', (error) => {
      this.failAll(new PdfWorkerFailure(`PDF render worker failed: ${error.message}`))
      void this.terminate()
    })
    this.worker.on('exit', (code) => {
      const expected = this.terminated
      this.terminated = true
      if (!expected) this.failAll(new PdfWorkerFailure(`PDF render worker exited unexpectedly with code ${code}`))
    })
    abortSignal?.addEventListener('abort', this.handleAbort, { once: true })
    if (abortSignal?.aborted) this.handleAbort()
  }

  private readonly handleAbort = (): void => {
    const error = abortError(this.abortSignal)
    this.failAll(error)
    void this.terminate()
  }

  private handleResponse(response: PdfRenderResponse): void {
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    clearTimeout(pending.timer)
    if (response.ok) pending.resolve(response.result)
    else pending.reject(new Error(response.error))
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private request(request: PdfRenderRequest, transfer: ArrayBuffer[] = []): Promise<PdfRenderResult> {
    this.abortSignal?.throwIfAborted()
    if (this.terminated) return Promise.reject(new PdfWorkerFailure('PDF render worker is terminated'))
    return new Promise<PdfRenderResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        const error = new PdfWorkerFailure(`PDF worker operation timed out after ${PDF_WORKER_OPERATION_TIMEOUT_MS} ms`)
        reject(error)
        this.failAll(error)
        void this.terminate()
      }, PDF_WORKER_OPERATION_TIMEOUT_MS)
      this.pending.set(request.id, { resolve, reject, timer })
      try {
        this.worker.postMessage(request, transfer)
      } catch (error) {
        this.pending.delete(request.id)
        clearTimeout(timer)
        reject(new PdfWorkerFailure(`Failed to send request to PDF render worker: ${errorMessage(error)}`))
      }
    })
  }

  async init(buffer: Buffer): Promise<number> {
    const bytes = Uint8Array.from(buffer)
    const result = await this.request({ id: this.nextId++, type: 'init', data: bytes.buffer }, [bytes.buffer])
    if (result.type !== 'init') throw new Error('Unexpected PDF worker initialization response')
    return result.totalPages
  }

  async getText(pageNumbers: number[]): Promise<Array<{ num: number; text: string }>> {
    const result = await this.request({ id: this.nextId++, type: 'get-text', pageNumbers })
    if (result.type !== 'get-text') throw new Error('Unexpected PDF worker text response')
    return result.pages
  }

  async render(pageNumber: number): Promise<{ pageNumber: number; width: number; height: number; data: Buffer }> {
    const result = await this.request({
      id: this.nextId++,
      type: 'render',
      pageNumber,
      desiredWidth: PDF_RENDER_WIDTH,
      maxPixels: PDF_RENDER_MAX_PIXELS,
    })
    if (result.type !== 'render') throw new Error('Unexpected PDF worker render response')
    return { ...result, data: Buffer.from(result.data) }
  }

  async dispose(): Promise<void> {
    this.abortSignal?.removeEventListener('abort', this.handleAbort)
    if (this.terminated) return
    try {
      await this.request({ id: this.nextId++, type: 'destroy' })
    } catch {
      // worker termination below is the final cleanup path
    }
    await this.terminate()
  }

  private async terminate(): Promise<void> {
    if (this.terminated) return
    this.terminated = true
    await this.worker.terminate().catch(() => {})
  }
}

interface ExtractedPdfPage {
  num: number
  text: string
}

export async function extractPdfTextWithFallback(
  pageNumbers: number[],
  getText: (pageNumbers: number[]) => Promise<ExtractedPdfPage[]>,
  signal: AbortSignal,
  onNotice?: (message: string) => void,
): Promise<ExtractedPdfPage[]> {
  try {
    return await getText(pageNumbers)
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof PdfWorkerFailure) throw error
    onNotice?.('Batch PDF text extraction failed; retrying page by page before visual fallback.')
  }

  const extracted: ExtractedPdfPage[] = []
  for (const pageNumber of pageNumbers) {
    signal.throwIfAborted()
    try {
      const pages = await getText([pageNumber])
      extracted.push(pages.find((page) => page.num === pageNumber) ?? { num: pageNumber, text: '' })
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof PdfWorkerFailure) throw error
      onNotice?.(`PDF page ${pageNumber} text extraction failed; using visual fallback.`)
      extracted.push({ num: pageNumber, text: '' })
    }
  }
  return extracted
}

function normalizePageText(text: string): Omit<PdfPageAnalysis, 'pageNumber' | 'needsVisual' | 'kind'> {
  const normalized = text
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trimEnd()
  let normalizedChars = 0
  let damagedChars = 0
  for (const char of normalized) {
    if (/\s/u.test(char)) continue
    normalizedChars++
    const code = char.codePointAt(0) ?? 0
    if (char === '\ufffd' || (code >= 0xe000 && code <= 0xf8ff)) damagedChars++
  }
  const replacementRatio = normalizedChars === 0 ? 0 : damagedChars / normalizedChars
  const hasExtractedText = normalizedChars > 0 && replacementRatio <= PDF_TEXT_PAGE_MAX_REPLACEMENT_RATIO
  const hasUsableText =
    normalizedChars >= PDF_TEXT_PAGE_MIN_CHARS && replacementRatio <= PDF_TEXT_PAGE_MAX_REPLACEMENT_RATIO
  return { text: normalized, normalizedChars, replacementRatio, hasExtractedText, hasUsableText }
}

function pageAnalysis(pageNumber: number, text: string, mode: PdfMode): PdfPageAnalysis {
  const normalized = normalizePageText(text)
  const needsVisual = mode === 'visual' || !normalized.hasUsableText
  return {
    pageNumber,
    ...normalized,
    needsVisual,
    kind: normalized.hasExtractedText && needsVisual ? 'both' : needsVisual ? 'visual' : 'text',
  }
}

function pagesToRanges(pages: number[]): string[] {
  if (pages.length === 0) return []
  const ranges: string[] = []
  let first = pages[0]!
  let last = first
  for (const page of pages.slice(1)) {
    if (page === last + 1) {
      last = page
      continue
    }
    ranges.push(first === last ? String(first) : `${first}-${last}`)
    first = page
    last = page
  }
  ranges.push(first === last ? String(first) : `${first}-${last}`)
  return ranges
}

function suggestedRange(pages: number[]): string {
  if (pages.length === 0) return '1'
  const first = pages[0]!
  let last = first
  for (const page of pages.slice(1, 5)) {
    if (page !== last + 1) break
    last = page
  }
  return first === last ? String(first) : `${first}-${last}`
}

function makeReference(
  filePath: string,
  size: number,
  totalPages: number,
  reason: PdfReference['reason'],
  processedPages: number[],
  remainingPageNumbers: number[],
): PdfReference {
  return {
    type: 'reference',
    filePath,
    size,
    totalPages,
    reason,
    processedPages,
    remainingPages: pagesToRanges(remainingPageNumbers),
    suggestedPages: suggestedRange(remainingPageNumbers),
  }
}

export function formatPdfReference(reference: PdfReference): string {
  return [
    openMediaTag('pdf-reference', { path: reference.filePath }),
    `Pages: ${reference.totalPages}`,
    `Reason: ${reference.reason}`,
    reference.processedPages.length > 0 ? `Processed pages: ${pagesToRanges(reference.processedPages).join(', ')}` : '',
    reference.remainingPages.length > 0 ? `Remaining pages: ${reference.remainingPages.join(', ')}` : '',
    `Use readFile with pages: "${reference.suggestedPages}". Maximum ${PDF_READ_MAX_PAGES} pages per call.`,
    '<</pdf-reference>>',
  ]
    .filter(Boolean)
    .join('\n')
}

function pageTextBlock(page: PdfPageAnalysis, totalPages: number, filename: string): string {
  return `--- PDF page ${page.pageNumber} of ${totalPages}: ${filename} ---\n${page.text}`
}

function pageVisualLabel(pageNumber: number, totalPages: number, filename: string): string {
  return `--- PDF page ${pageNumber} of ${totalPages}: ${filename} ---\nThe following image is the rendered page.`
}

function safeDisplayName(filePath: string): string {
  return path.basename(filePath).replace(/[\u0000-\u001f\u007f]+/g, ' ')
}

function boundPageText(
  parts: ProcessedLocalPart[],
  maxTextBytes: number,
  pageNumber: number,
): { parts: ProcessedLocalPart[]; textBytes: number } {
  const text = parts
    .filter((part): part is Extract<ProcessedLocalPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
  const textBytes = Buffer.byteLength(text, 'utf-8')
  if (textBytes <= maxTextBytes) return { parts, textBytes }

  const notice = `[PDF page ${pageNumber} text truncated at the per-call ${maxTextBytes}-byte budget.]`
  const noticeBytes = Buffer.byteLength(notice, 'utf-8')
  const body = truncateUtf8(text, Math.max(0, maxTextBytes - noticeBytes - 1))
  const suffix = truncateUtf8(`${body ? '\n' : ''}${notice}`, maxTextBytes - Buffer.byteLength(body, 'utf-8'))
  const boundedText = body + suffix
  const images = parts.filter((part) => part.type === 'image')
  return {
    parts: [...(boundedText ? [{ type: 'text' as const, text: boundedText }] : []), ...images],
    textBytes: Buffer.byteLength(boundedText, 'utf-8'),
  }
}

function classifyPdfError(error: unknown): ProcessPdfResult {
  const message = errorMessage(error)
  if (/password|encrypted/i.test(message)) {
    return { type: 'error', code: 'password-protected', message: 'This PDF is password-protected.' }
  }
  if (error instanceof PdfWorkerFailure || /image compression timed out/i.test(message)) {
    return { type: 'error', code: 'render-failed', message: `PDF processing worker failed: ${message}` }
  }
  return { type: 'error', code: 'corrupted', message: `Failed to process PDF: ${message}` }
}

export async function processPdf(filePath: string, options: ProcessPdfOptions): Promise<ProcessPdfResult> {
  const mode = options.mode ?? 'auto'
  const maxTextBytes = options.maxTextBytes ?? PDF_MAX_TEXT_BYTES
  const maxRenderedPages = options.maxRenderedPages ?? PDF_AUTO_MAX_RENDERED_PAGES
  const maxRenderedBytes = options.maxRenderedBytes ?? PDF_MAX_RENDERED_BYTES
  const timeoutSignal = AbortSignal.timeout(PDF_PROCESS_TIMEOUT_MS)
  const signal = options.abortSignal ? AbortSignal.any([options.abortSignal, timeoutSignal]) : timeoutSignal
  let client: PdfWorkerClient | undefined
  try {
    signal.throwIfAborted()
    const buffer = await readFileWithinLimit(filePath, MAX_PDF_SOURCE_BYTES, signal)
    if (buffer.length === 0) return { type: 'error', code: 'empty', message: 'PDF is empty.' }
    if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
      return { type: 'error', code: 'corrupted', message: 'File does not contain a valid PDF header.' }
    }

    client = new PdfWorkerClient(signal)
    const totalPages = await client.init(buffer)
    if (totalPages <= 0) return { type: 'error', code: 'empty', message: 'PDF contains no pages.' }
    if (totalPages > PDF_MAX_DECLARED_PAGES) {
      return {
        type: 'error',
        code: 'too-large',
        message: `PDF declares ${totalPages} pages, exceeding the safe limit of ${PDF_MAX_DECLARED_PAGES}.`,
      }
    }

    const range = options.pageRange
    if (
      range &&
      (range.first < 1 ||
        range.last < range.first ||
        range.last > totalPages ||
        range.last - range.first + 1 > PDF_READ_MAX_PAGES)
    ) {
      return { type: 'error', code: 'invalid-range', message: `Invalid PDF page range ${range.first}-${range.last}.` }
    }
    if (!range && totalPages > PDF_ANALYSIS_PAGE_LIMIT) {
      return makeReference(
        filePath,
        buffer.length,
        totalPages,
        'analysis-page-limit',
        [],
        Array.from({ length: totalPages }, (_, index) => index + 1),
      )
    }

    const first = range?.first ?? 1
    const last = range?.last ?? totalPages
    const pageNumbers = Array.from({ length: last - first + 1 }, (_, index) => first + index)
    options.onNotice?.(`Extracting PDF text (${first}-${last}/${totalPages})`)
    const extractedPages = await extractPdfTextWithFallback(
      pageNumbers,
      (requestedPages) => client!.getText(requestedPages),
      signal,
      options.onNotice,
    )
    const textByPage = new Map(extractedPages.map((page) => [page.num, page.text]))
    const pages = pageNumbers.map((pageNumber) => pageAnalysis(pageNumber, textByPage.get(pageNumber) ?? '', mode))
    const analysis: PdfAnalysis = {
      filePath,
      size: buffer.length,
      totalPages,
      analyzedPages: pages.length,
      pages,
      truncated: pages.length < totalPages,
    }

    const visualPages = pages.filter((page) => page.needsVisual)
    if (!range && visualPages.length > maxRenderedPages) {
      return makeReference(filePath, buffer.length, totalPages, 'too-many-visual-pages', [], pageNumbers)
    }
    const filename = safeDisplayName(filePath)
    const estimatedTextBytes = pages.reduce(
      (total, page) =>
        total + (page.hasExtractedText ? Buffer.byteLength(pageTextBlock(page, totalPages, filename)) : 0),
      0,
    )
    if (!range && estimatedTextBytes > maxTextBytes) {
      return makeReference(filePath, buffer.length, totalPages, 'text-budget', [], pageNumbers)
    }

    const parts: ProcessedLocalPart[] = []
    const processedPages: number[] = []
    let outputTextBytes = 0
    let outputImageBytes = 0
    let renderedPages = 0
    let continuation: PdfReference | undefined

    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      signal.throwIfAborted()
      const page = pages[pageIndex]!
      let pageParts: ProcessedLocalPart[] = []
      let pageTextBytes = 0
      let pageImageBytes = 0
      if (page.hasExtractedText) {
        const block = pageTextBlock(page, totalPages, filename)
        pageParts.push({ type: 'text', text: block })
        pageTextBytes += Buffer.byteLength(block)
      }

      if (page.needsVisual) {
        if (renderedPages >= maxRenderedPages) {
          continuation = makeReference(
            filePath,
            buffer.length,
            totalPages,
            'too-many-visual-pages',
            processedPages,
            pages.slice(pageIndex).map((remaining) => remaining.pageNumber),
          )
          break
        }
        renderedPages++
        options.onNotice?.(`Rendering PDF page ${page.pageNumber}/${totalPages}`)
        try {
          const rendered = await client.render(page.pageNumber)
          const compressed = await compressImage(rendered.data, 'image/png', {
            byteBudget: ATTACH_BYTE_BUDGET,
            abortSignal: signal,
          })
          const mediaType = normalizeImageMime(compressed.mimeType)
          if (
            compressed.failureReason ||
            !isModelAcceptedImageMime(mediaType) ||
            compressed.data.length > ATTACH_BYTE_BUDGET ||
            compressed.width > MAX_EDGE_PX ||
            compressed.height > MAX_EDGE_PX
          ) {
            throw new Error('Rendered PDF page could not be reduced to image limits')
          }
          if (options.vision && mode !== 'text-only') {
            const label = pageVisualLabel(page.pageNumber, totalPages, filename)
            const extension = mediaType === 'image/jpeg' ? 'jpg' : 'png'
            pageParts.push({ type: 'text', text: label })
            pageParts.push({
              type: 'image',
              data: compressed.data,
              mediaType: mediaType as StandardImageMediaType,
              filename: `${filename}-page-${page.pageNumber}.${extension}`,
              source: { filePath, page: page.pageNumber },
            })
            pageTextBytes += Buffer.byteLength(label)
            pageImageBytes += compressed.data.length
          } else {
            options.onNotice?.(`OCR PDF page ${page.pageNumber}/${totalPages}`)
            const ocr = await ocrImage(compressed.data, { abortSignal: signal })
            const block = `--- PDF page ${page.pageNumber} of ${totalPages}: ${filename} (local OCR) ---\n${ocr}`
            pageParts.push({ type: 'text', text: block })
            pageTextBytes += Buffer.byteLength(block)
          }
        } catch (error) {
          signal.throwIfAborted()
          if (error instanceof PdfWorkerFailure) throw error
          const block = `[PDF page ${page.pageNumber} could not be rendered locally: ${errorMessage(error)}]`
          pageParts.push({ type: 'text', text: block })
          pageTextBytes += Buffer.byteLength(block)
        }
      }

      const bounded = boundPageText(pageParts, maxTextBytes, page.pageNumber)
      pageParts = bounded.parts
      pageTextBytes = bounded.textBytes

      if (outputTextBytes + pageTextBytes > maxTextBytes || outputImageBytes + pageImageBytes > maxRenderedBytes) {
        continuation = makeReference(
          filePath,
          buffer.length,
          totalPages,
          outputTextBytes + pageTextBytes > maxTextBytes ? 'text-budget' : 'rendered-byte-budget',
          processedPages,
          pages.slice(pageIndex).map((remaining) => remaining.pageNumber),
        )
        break
      }
      parts.push(...pageParts)
      outputTextBytes += pageTextBytes
      outputImageBytes += pageImageBytes
      processedPages.push(page.pageNumber)
    }

    if (parts.length === 0 && !continuation) {
      return { type: 'error', code: 'empty', message: 'PDF contains no extractable text or renderable pages.' }
    }
    return { type: 'content', analysis, parts, continuation }
  } catch (error) {
    options.abortSignal?.throwIfAborted()
    if (error instanceof FileSizeLimitError) {
      return {
        type: 'error',
        code: 'too-large',
        message: `PDF is too large to process safely (${error.observedBytes} bytes, cap ${error.limitBytes} bytes).`,
      }
    }
    if (timeoutSignal.aborted) {
      return { type: 'error', code: 'render-failed', message: 'PDF processing timed out.' }
    }
    return classifyPdfError(error)
  } finally {
    await client?.dispose()
  }
}
