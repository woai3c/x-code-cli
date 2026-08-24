import { strToU8, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { crc32 } from 'node:zlib'

import {
  MAX_ATTACHMENT_TEXT_BYTES,
  MAX_IMAGE_SOURCE_BYTES,
  MAX_INGEST_BYTES,
  MAX_OFFICE_SOURCE_BYTES,
  buildUserContent,
  classifyFile,
  extractFileReferences,
  extractOfficeText,
  ingestFile,
} from '../src/agent/file-ingest.js'
import { disposeOcrWorker } from '../src/agent/image-ocr.js'

// Mock tesseract so the OCR fallback path doesn't spawn a real worker
// thread on test images. Without this, when the sub-agent test forces
// captionImage to reject, ingestFile falls through to ocrImage() which
// crashes the worker on any non-decodable input and leaks an unhandled
// exception into the test runner. Returning a deterministic stub keeps
// the assertion focused on the notice + plumbing behavior.
vi.mock('tesseract.js', () => ({
  createWorker: vi.fn(async () => ({
    recognize: vi.fn(async () => ({ data: { text: 'mock local OCR result' } })),
    terminate: vi.fn(async () => {}),
  })),
}))

let tmpDir: string
let textFile: string
let jsonFile: string
let imageFile: string
let pdfFile: string
let officeFile: string

function addPngAncillaryChunk(png: Buffer, dataBytes: number): Buffer {
  const iendOffset = png.lastIndexOf(Buffer.from('IEND')) - 4
  const type = Buffer.from('rAND')
  const data = Buffer.alloc(dataBytes, 0x61)
  const chunk = Buffer.allocUnsafe(data.length + 12)
  chunk.writeUInt32BE(data.length, 0)
  type.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(data, crc32(type)), data.length + 8)
  return Buffer.concat([png.subarray(0, iendOffset), chunk, png.subarray(iendOffset)])
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcc-ingest-'))
  textFile = path.join(tmpDir, 'hello.md')
  jsonFile = path.join(tmpDir, 'data.json')
  imageFile = path.join(tmpDir, 'real-image.bin')
  pdfFile = path.join(tmpDir, 'renamed-pdf.bin')
  officeFile = path.join(tmpDir, 'document.docx')
  await fs.writeFile(textFile, '# Hello\nLine 2')
  await fs.writeFile(jsonFile, '{"ok":true}')
  const { Jimp } = await import('jimp')
  const image = new Jimp({ width: 4, height: 3, color: 0xff0000ff })
  await fs.writeFile(imageFile, await image.getBuffer('image/png'))
  await fs.writeFile(pdfFile, '%PDF-1.4\n')
  await fs.writeFile(officeFile, Buffer.from(zipSync({ '[Content_Types].xml': strToU8('<Types/>') })))
})

afterAll(async () => {
  await disposeOcrWorker()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('extractFileReferences', () => {
  it('captures an @-mention of a POSIX absolute path', () => {
    const refs = extractFileReferences('check @/tmp/report.md please')
    expect(refs).toHaveLength(1)
    expect(refs[0]?.raw).toBe('@/tmp/report.md')
  })

  it('captures an @-mention of a Windows absolute path', () => {
    const refs = extractFileReferences('看看 @D:\\res\\x-code-cli\\CHANGELOG.md')
    expect(refs).toHaveLength(1)
    expect(refs[0]?.raw).toBe('@D:\\res\\x-code-cli\\CHANGELOG.md')
  })

  it('captures a bare absolute path with an extension', () => {
    const refs = extractFileReferences('summarize /home/me/report.pdf today')
    expect(refs).toHaveLength(1)
  })

  it('de-duplicates repeated references', () => {
    const refs = extractFileReferences('@/a/b.md vs @/a/b.md')
    expect(refs).toHaveLength(1)
  })
})

describe('classifyFile', () => {
  it('recognizes markdown as text', async () => {
    expect(await classifyFile(textFile)).toBe('text')
  })

  it('recognizes json as text', async () => {
    expect(await classifyFile(jsonFile)).toBe('text')
  })

  it('recognizes image magic even when the extension is .bin', async () => {
    expect(await classifyFile(imageFile)).toBe('image')
  })

  it('recognizes PDF magic even when the extension is .bin', async () => {
    expect(await classifyFile(pdfFile)).toBe('pdf')
  })

  it('requires an Office ZIP rather than trusting the extension alone', async () => {
    expect(await classifyFile(officeFile)).toBe('office')
    const fake = path.join(tmpDir, 'fake.docx')
    await fs.writeFile(fake, 'plain text')
    expect(await classifyFile(fake)).toBe('office')
  })
})

describe('extractOfficeText', () => {
  it('bounds the source read before Office decompression', async () => {
    const archive = path.join(tmpDir, 'oversized-source.docx')
    await fs.writeFile(archive, Buffer.from(zipSync({ 'word/document.xml': strToU8('<w:document/>') })))
    await fs.truncate(archive, MAX_OFFICE_SOURCE_BYTES + 1)

    expect(await extractOfficeText(archive)).toContain('too large to parse safely')
  })

  it('rejects a DOCX whose declared uncompressed content exceeds the archive budget', async () => {
    const archive = path.join(tmpDir, 'oversized-content.docx')
    await fs.writeFile(archive, Buffer.from(zipSync({ 'word/document.xml': new Uint8Array(32 * 1024 * 1024 + 1) })))

    const text = await extractOfficeText(archive)

    expect(text).toContain('safe decompression limit')
  })

  it('reads xlsx sheets without the vulnerable SheetJS runtime', async () => {
    const workbook = path.join(tmpDir, 'sample.xlsx')
    const files = {
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      ),
      '_rels/.rels': strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ),
      'xl/workbook.xml': strToU8(
        '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>alpha</t></is></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>',
      ),
    }
    await fs.writeFile(workbook, Buffer.from(zipSync(files)))

    const text = await extractOfficeText(workbook)

    expect(text).toContain('--- Sheet: Data ---')
    expect(text).toContain('Name,Value')
    expect(text).toContain('alpha,42')

    const renamed = path.join(tmpDir, 'renamed-workbook.bin')
    const misleading = path.join(tmpDir, 'misleading-workbook.docx')
    await fs.copyFile(workbook, renamed)
    await fs.copyFile(workbook, misleading)
    expect(await extractOfficeText(renamed)).toContain('alpha,42')
    expect(await extractOfficeText(misleading)).toContain('alpha,42')
  })

  it('reads pptx slide text with bounded ZIP extraction', async () => {
    const presentation = path.join(tmpDir, 'sample.pptx')
    await fs.writeFile(
      presentation,
      Buffer.from(
        zipSync({
          'ppt/slides/slide2.xml': strToU8('<p:sld><a:p><a:r><a:t>Second &amp; final</a:t></a:r></a:p></p:sld>'),
          'ppt/slides/slide1.xml': strToU8('<p:sld><a:p><a:r><a:t>Hello</a:t></a:r></a:p></p:sld>'),
        }),
      ),
    )

    const text = await extractOfficeText(presentation)

    expect(text).toContain('--- Slide 1 ---\nHello')
    expect(text).toContain('--- Slide 2 ---\nSecond & final')
    expect(text.indexOf('Slide 1')).toBeLessThan(text.indexOf('Slide 2'))
  })
})

describe('ingestFile', () => {
  const multimodalCaps = {
    image: true,
    pdf: true,
    audio: true,
    filesApi: true,
    toolImageTransport: 'tool-result' as const,
  }
  const textOnlyCaps = {
    image: false,
    pdf: false,
    audio: false,
    filesApi: false,
    toolImageTransport: 'unsupported' as const,
  }

  it('inlines text files for any provider', async () => {
    const parts = await ingestFile({ raw: `@${textFile}`, absolutePath: textFile }, textOnlyCaps)
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe('text')
    if (parts[0]?.type === 'text') {
      expect(parts[0].text).toContain('Hello')
      expect(parts[0].text).toContain(textFile)
    }
  })

  it('uses the shared notebook renderer and omits binary cell output', async () => {
    const notebook = path.join(tmpDir, 'analysis.ipynb')
    await fs.writeFile(
      notebook,
      JSON.stringify({
        nbformat: 4,
        cells: [
          {
            cell_type: 'code',
            execution_count: 1,
            source: ['print("hello")'],
            outputs: [{ output_type: 'display_data', data: { 'text/plain': 'figure', 'image/png': 'SECRETBASE64' } }],
          },
        ],
      }),
    )

    const parts = await ingestFile({ raw: `@${notebook}`, absolutePath: notebook }, textOnlyCaps)
    expect(JSON.stringify(parts)).toContain('Cell 1 [code] (exec 1)')
    expect(JSON.stringify(parts)).toContain('[image/png output omitted]')
    expect(JSON.stringify(parts)).not.toContain('SECRETBASE64')
  })

  it('attaches images as base64 strings, not Buffers (session-jsonl-safe)', async () => {
    // Regression: the image part used to carry the raw Buffer, which
    // JSON.stringify persists as {"type":"Buffer","data":[...]} — a shape the
    // SDK's ModelMessage schema rejects, so resuming any session with an
    // image attachment failed every subsequent request.
    const source = await fs.readFile(imageFile)
    const parts = await ingestFile({ raw: `@${imageFile}`, absolutePath: imageFile }, multimodalCaps)
    const imagePart = parts.find((part) => part.type === 'file')
    expect(imagePart).toBeDefined()
    if (imagePart?.type === 'file') {
      expect(imagePart.mediaType).toBe('image/png')
      expect(imagePart.data).toEqual({ type: 'data', data: source.toString('base64') })
      expect(JSON.parse(JSON.stringify(imagePart))).toEqual(imagePart)
    }
  })

  it('rejects GIF before session insertion for an xAI model', async () => {
    const gif = path.join(tmpDir, 'xai-unsupported.gif')
    const { Jimp } = await import('jimp')
    await fs.writeFile(gif, await new Jimp({ width: 2, height: 2, color: 0xff0000ff }).getBuffer('image/gif'))

    const parts = await ingestFile(
      { raw: `@${gif}`, absolutePath: gif },
      multimodalCaps,
      undefined,
      undefined,
      undefined,
      'xai:grok-4.3',
    )

    expect(parts.every((part) => part.type === 'text')).toBe(true)
    expect(JSON.stringify(parts)).toContain('accepts only PNG, JPEG')

    const textOnlyParts = await ingestFile(
      { raw: `@${gif}`, absolutePath: gif },
      textOnlyCaps,
      undefined,
      undefined,
      undefined,
      'xai:text-only',
    )
    expect(JSON.stringify(textOnlyParts)).toContain('mock local OCR result')
  })

  it('normalizes a decodable BMP disguised as PNG before provider delivery', async () => {
    const bmp = path.join(tmpDir, 'disguised-bmp.png')
    const { Jimp } = await import('jimp')
    const image = new Jimp({ width: 4, height: 3, color: 0x00ff00ff })
    await fs.writeFile(bmp, await image.getBuffer('image/bmp'))
    try {
      const parts = await ingestFile({ raw: `@${bmp}`, absolutePath: bmp }, multimodalCaps)
      const imagePart = parts.find((part) => part.type === 'file')
      expect(imagePart).toMatchObject({ type: 'file', mediaType: 'image/png' })
      expect(parts.some((part) => part.type === 'text' && part.text.includes('compressed'))).toBe(true)
    } finally {
      await fs.rm(bmp, { force: true })
    }
  })

  it('returns an error text part for missing files', async () => {
    const missing = path.join(tmpDir, 'missing.md')
    const parts = await ingestFile({ raw: `@${missing}`, absolutePath: missing }, multimodalCaps)
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe('text')
    if (parts[0]?.type === 'text') {
      expect(parts[0].text).toMatch(/Cannot read/i)
    }
  })

  it('rejects oversized image sources before reading them into memory', async () => {
    const oversized = path.join(tmpDir, 'oversized.png')
    await fs.copyFile(imageFile, oversized)
    await fs.truncate(oversized, MAX_IMAGE_SOURCE_BYTES + 1)

    const parts = await ingestFile({ raw: `@${oversized}`, absolutePath: oversized }, multimodalCaps)

    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe('text')
    if (parts[0]?.type === 'text') expect(parts[0].text).toMatch(/too large to inline/i)
  })

  it('rechecks image size on the opened file after the initial path stat', async () => {
    const oversized = path.join(tmpDir, 'raced-image.png')
    await fs.copyFile(imageFile, oversized)
    await fs.truncate(oversized, MAX_IMAGE_SOURCE_BYTES + 1)
    const actual = await fs.stat(oversized)
    const statSpy = vi
      .spyOn(fs, 'stat')
      .mockResolvedValueOnce({ ...actual, size: 1 } as Awaited<ReturnType<typeof fs.stat>>)

    try {
      const parts = await ingestFile({ raw: `@${oversized}`, absolutePath: oversized }, multimodalCaps)
      expect(parts).toEqual([
        expect.objectContaining({ type: 'text', text: expect.stringMatching(/too large to inline/i) }),
      ])
    } finally {
      statSpy.mockRestore()
      await fs.rm(oversized, { force: true })
    }
  })

  it('never emits a BOM-prefixed PDF as ordinary attachment text', async () => {
    const disguised = path.join(tmpDir, 'bom-pdf.txt')
    await fs.writeFile(disguised, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('%PDF-1.4\n')]))

    const parts = await ingestFile({ raw: `@${disguised}`, absolutePath: disguised }, multimodalCaps)

    expect(JSON.stringify(parts)).not.toContain('%PDF-1.4')
    expect(parts.every((part) => part.type === 'text')).toBe(true)
  })

  // Regression: a multi-MB @path attachment used to be inlined verbatim,
  // pushing the user message past the model's context window before the
  // first turn could even start. Now we substitute a short hint that
  // points the model at the readFile tool with offset/limit.
  it('replaces oversized text files with a hint to use readFile', async () => {
    const big = path.join(tmpDir, 'big.txt')
    await fs.writeFile(big, 'x'.repeat(MAX_INGEST_BYTES + 1))
    try {
      const parts = await ingestFile({ raw: `@${big}`, absolutePath: big }, multimodalCaps)
      expect(parts).toHaveLength(1)
      expect(parts[0]?.type).toBe('text')
      if (parts[0]?.type === 'text') {
        expect(parts[0].text).toMatch(/too large to inline/i)
        expect(parts[0].text).toMatch(/readFile/)
        expect(parts[0].text).not.toContain('xxxxxxxxxx')
      }
    } finally {
      await fs.rm(big, { force: true })
    }
  })

  it('checks the formatted text size after adding line numbers and wrappers', async () => {
    const newlineHeavy = path.join(tmpDir, 'newline-heavy.txt')
    await fs.writeFile(newlineHeavy, '\n'.repeat(100_000))

    const parts = await ingestFile({ raw: `@${newlineHeavy}`, absolutePath: newlineHeavy }, multimodalCaps)

    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/too large to inline/i) })
  })

  it('uses local OCR for a text-only model without forwarding to another provider', async () => {
    const notices: string[] = []
    const parts = await ingestFile({ raw: `@${imageFile}`, absolutePath: imageFile }, textOnlyCaps, (notice) =>
      notices.push(notice),
    )

    expect(notices).toEqual([])
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('mock local OCR result') })
    expect(JSON.stringify(parts)).toContain('current model cannot natively see images')
  })
})

describe('buildUserContent', () => {
  it('keeps the string fast path when no references appear', async () => {
    const result = await buildUserContent('hello world', {
      image: true,
      pdf: true,
      audio: true,
      filesApi: true,
      toolImageTransport: 'tool-result',
    })
    expect(result).toBe('hello world')
  })

  it('splices ingested parts after the original user text', async () => {
    const input = `please read @${textFile}`
    const result = await buildUserContent(input, {
      image: true,
      pdf: true,
      audio: true,
      filesApi: true,
      toolImageTransport: 'tool-result',
    })
    expect(Array.isArray(result)).toBe(true)
    if (!Array.isArray(result)) return
    expect(result[0]).toEqual({ type: 'text', text: input })
    expect(result.length).toBeGreaterThan(1)
  })

  it('enforces a cumulative post-formatting attachment text budget', async () => {
    const files = await Promise.all(
      Array.from({ length: 6 }, async (_, index) => {
        const file = path.join(tmpDir, `aggregate-${index + 1}.txt`)
        await fs.writeFile(file, `${index + 1}:` + 'x'.repeat(180 * 1024))
        return file
      }),
    )
    const input = `review ${files.map((file) => `@${file}`).join(' ')}`

    const result = await buildUserContent(input, {
      image: true,
      pdf: true,
      audio: true,
      filesApi: true,
      toolImageTransport: 'tool-result',
    })

    expect(Array.isArray(result)).toBe(true)
    if (!Array.isArray(result)) return
    const attachmentText = result
      .slice(1)
      .filter((part): part is Extract<(typeof result)[number], { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('')
    expect(Buffer.byteLength(attachmentText, 'utf-8')).toBeLessThanOrEqual(MAX_ATTACHMENT_TEXT_BYTES)
    expect(attachmentText).toContain('cumulative attachment budget exceeded')
  })

  it('limits the cumulative number of media parts', async () => {
    const images = await Promise.all(
      Array.from({ length: 11 }, async (_, index) => {
        const file = path.join(tmpDir, `aggregate-image-${index + 1}.png`)
        await fs.copyFile(imageFile, file)
        return file
      }),
    )

    const result = await buildUserContent(`compare ${images.map((file) => `@${file}`).join(' ')}`, {
      image: true,
      pdf: true,
      audio: true,
      filesApi: true,
      toolImageTransport: 'tool-result',
    })

    expect(Array.isArray(result)).toBe(true)
    if (!Array.isArray(result)) return
    expect(result.filter((part) => part.type === 'file')).toHaveLength(10)
    expect(JSON.stringify(result)).toContain('10-media-part limit')
  })

  it('counts Base64 expansion in the cumulative serialized attachment budget', async () => {
    const padded = addPngAncillaryChunk(await fs.readFile(imageFile), 3.5 * 1024 * 1024)
    const images = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const file = path.join(tmpDir, `wire-budget-${index + 1}.png`)
        await fs.writeFile(file, padded)
        return file
      }),
    )

    const result = await buildUserContent(`compare ${images.map((file) => `@${file}`).join(' ')}`, {
      image: true,
      pdf: true,
      audio: true,
      filesApi: true,
      toolImageTransport: 'tool-result',
    })

    expect(Array.isArray(result)).toBe(true)
    if (!Array.isArray(result)) return
    expect(result.filter((part) => part.type === 'file')).toHaveLength(4)
    expect(result.some((part) => part.type === 'text' && part.text.includes('serialized attachment limit'))).toBe(true)
  })
})
