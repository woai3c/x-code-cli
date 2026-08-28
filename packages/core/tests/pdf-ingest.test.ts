import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ingestFile } from '../src/agent/file-ingest.js'
import { MAX_PDF_SOURCE_BYTES, extractPdfTextWithFallback, processPdf } from '../src/agent/pdf-ingest.js'
import { createReadFileTool } from '../src/tools/read-file.js'
import { makePdfBuffer } from './helpers/pdf.js'

vi.mock('../src/agent/image-ocr.js', () => ({
  ocrImage: vi.fn(async () => 'mock local OCR'),
}))

const LONG_TEXT = 'This page contains selectable local PDF text. '.repeat(4)

let tempDir: string
let textPdf: string
let mixedPdf: string
let scanPdf: string

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-pdf-ingest-'))
  textPdf = path.join(tempDir, 'text pages.pdf')
  mixedPdf = path.join(tempDir, 'mixed.pdf')
  scanPdf = path.join(tempDir, 'scan.pdf')
  await Promise.all([
    fs.writeFile(textPdf, makePdfBuffer([{ text: LONG_TEXT }, { text: `${LONG_TEXT} second` }])),
    fs.writeFile(mixedPdf, makePdfBuffer([{ text: LONG_TEXT }, {}, { text: 'Short title' }])),
    fs.writeFile(scanPdf, makePdfBuffer([{}, {}, {}])),
  ])
})

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('processPdf', () => {
  it('stops a source read at the PDF byte limit', async () => {
    const oversized = path.join(tempDir, 'oversized-source.pdf')
    await fs.writeFile(oversized, makePdfBuffer([{ text: LONG_TEXT }]))
    await fs.truncate(oversized, MAX_PDF_SOURCE_BYTES + 1)

    await expect(processPdf(oversized, { vision: true })).resolves.toMatchObject({ type: 'error', code: 'too-large' })
  })

  it('extracts a text PDF locally with page labels and no binary file part', async () => {
    const result = await processPdf(textPdf, { vision: true })

    expect(result.type).toBe('content')
    if (result.type !== 'content') return
    expect(result.analysis.totalPages).toBe(2)
    expect(result.analysis.pages.map((page) => page.kind)).toEqual(['text', 'text'])
    expect(result.parts.every((part) => part.type === 'text')).toBe(true)
    expect(result.parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('PDF page 1 of 2') })
    expect(JSON.stringify(result)).not.toContain('application/pdf')
  })

  it('keeps mixed-page order and preserves short extracted text as both', async () => {
    const result = await processPdf(mixedPdf, { vision: true })

    expect(result.type).toBe('content')
    if (result.type !== 'content') return
    expect(result.analysis.pages.map((page) => page.kind)).toEqual(['text', 'visual', 'both'])
    const pageSources = result.parts.flatMap((part) =>
      part.type === 'image' && part.source?.page ? [part.source.page] : [],
    )
    expect(pageSources).toEqual([2, 3])
    const serialized = result.parts
      .map((part) => (part.type === 'text' ? part.text : `[image page ${part.source?.page}]`))
      .join('\n')
    expect(serialized.indexOf('PDF page 1')).toBeLessThan(serialized.indexOf('[image page 2]'))
    expect(serialized.indexOf('Short title')).toBeLessThan(serialized.indexOf('[image page 3]'))
  })

  it('uses local OCR rather than image parts when vision is unavailable', async () => {
    const result = await processPdf(scanPdf, { vision: false })

    expect(result.type).toBe('content')
    if (result.type !== 'content') return
    expect(result.parts.every((part) => part.type === 'text')).toBe(true)
    expect(result.parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n')).toContain('mock local OCR')
  })

  it('does not pass parent-only Node flags to the PDF worker', async () => {
    process.execArgv.push('--input-type=module')
    try {
      const result = await processPdf(scanPdf, { vision: true })
      expect(result.type).toBe('content')
      if (result.type === 'content') expect(result.parts.some((part) => part.type === 'image')).toBe(true)
    } finally {
      process.execArgv.splice(process.execArgv.lastIndexOf('--input-type=module'), 1)
    }
  })

  it('returns a reference before rendering too many visual pages', async () => {
    const largeScan = path.join(tempDir, 'eleven-pages.pdf')
    await fs.writeFile(largeScan, makePdfBuffer(Array.from({ length: 11 }, () => ({}))))

    const result = await processPdf(largeScan, { vision: true })

    expect(result).toMatchObject({
      type: 'reference',
      reason: 'too-many-visual-pages',
      totalPages: 11,
      processedPages: [],
      remainingPages: ['1-11'],
      suggestedPages: '1-5',
    })
  })

  it('processes only an explicit page range and validates bounds', async () => {
    const selected = await processPdf(mixedPdf, {
      vision: true,
      pageRange: { first: 2, last: 3 },
    })
    expect(selected.type).toBe('content')
    if (selected.type === 'content') expect(selected.analysis.pages.map((page) => page.pageNumber)).toEqual([2, 3])

    const invalid = await processPdf(mixedPdf, {
      vision: true,
      pageRange: { first: 2, last: 4 },
    })
    expect(invalid).toMatchObject({ type: 'error', code: 'invalid-range' })
  })

  it('forces page rendering in visual mode and returns an atomic continuation at the byte budget', async () => {
    const result = await processPdf(textPdf, {
      vision: true,
      mode: 'visual',
      maxRenderedBytes: 1,
    })

    expect(result.type).toBe('content')
    if (result.type !== 'content') return
    expect(result.parts).toEqual([])
    expect(result.continuation).toMatchObject({
      reason: 'rendered-byte-budget',
      processedPages: [],
      remainingPages: ['1-2'],
    })
  })

  it('truncates an individually oversized page instead of returning the same page as a continuation', async () => {
    const oversizedPage = path.join(tempDir, 'oversized-page.pdf')
    await fs.writeFile(oversizedPage, makePdfBuffer([{ text: Array.from({ length: 10 }, () => LONG_TEXT).join('\n') }]))

    const result = await processPdf(oversizedPage, {
      vision: true,
      pageRange: { first: 1, last: 1 },
      maxTextBytes: 256,
    })

    expect(result.type).toBe('content')
    if (result.type !== 'content') return
    expect(result.continuation).toBeUndefined()
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('text truncated') })
    if (result.parts[0]?.type === 'text') {
      expect(Buffer.byteLength(result.parts[0].text, 'utf-8')).toBeLessThanOrEqual(256)
    }
  })

  it('fails closed for a corrupt PDF instead of decoding it as text', async () => {
    const corrupt = path.join(tempDir, 'corrupt.pdf')
    await fs.writeFile(corrupt, '%PDF-1.4\nnot a real document')
    const result = await processPdf(corrupt, { vision: true })
    expect(result).toMatchObject({ type: 'error', code: 'corrupted' })
  })

  it('rejects an extreme page aspect ratio before allocating a Canvas', async () => {
    const extreme = path.join(tempDir, 'extreme-page.pdf')
    await fs.writeFile(extreme, makePdfBuffer([{ width: 1, height: 100_000 }]))
    const result = await processPdf(extreme, { vision: true, mode: 'visual' })
    expect(result.type).toBe('content')
    if (result.type !== 'content') return
    expect(result.parts.some((part) => part.type === 'image')).toBe(false)
    expect(JSON.stringify(result.parts)).toContain('exceeds render pixel limit')
  })

  it('honors an already-aborted operation without returning partial content', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(processPdf(textPdf, { vision: true, abortSignal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})

describe('extractPdfTextWithFallback', () => {
  it('isolates page-level text failures so visual processing can continue', async () => {
    const getText = vi.fn(async (pages: number[]) => {
      if (pages.length > 1 || pages[0] === 2) throw new Error('broken text layer')
      return [{ num: pages[0]!, text: `page ${pages[0]}` }]
    })

    const extracted = await extractPdfTextWithFallback([1, 2, 3], getText, new AbortController().signal)

    expect(extracted).toEqual([
      { num: 1, text: 'page 1' },
      { num: 2, text: '' },
      { num: 3, text: 'page 3' },
    ])
    expect(getText).toHaveBeenCalledTimes(4)
  })
})

describe('readFile PDF integration', () => {
  it('uses the shared local pipeline and accepts a page range', async () => {
    const tool = createReadFileTool(undefined, { modelId: 'openai:gpt-5.6-sol' })
    const result = await tool.execute!({ filePath: textPdf, pages: '2' }, {
      toolCallId: 'pdf-test',
      messages: [],
      abortSignal: undefined,
    } as never)

    expect(result).toMatchObject({ type: 'content' })
    expect(JSON.stringify(result)).toContain('PDF page 2 of 2')
    expect(JSON.stringify(result)).not.toContain('file-data')
    expect(JSON.stringify(result)).not.toContain('application/pdf')
  })
})

describe('ingestFile PDF detection', () => {
  it('never emits a BOM-prefixed PDF as ordinary attachment text', async () => {
    const disguised = path.join(tempDir, 'bom-pdf.txt')
    await fs.writeFile(disguised, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('%PDF-1.4\n')]))

    const parts = await ingestFile(
      { raw: `@${disguised}`, absolutePath: disguised },
      { image: true, pdf: true, audio: true, filesApi: true, toolImageTransport: 'tool-result' },
    )

    expect(JSON.stringify(parts)).not.toContain('%PDF-1.4')
    expect(parts.every((part) => part.type === 'text')).toBe(true)
  }, 15_000)
})
