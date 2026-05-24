import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  MAX_INGEST_BYTES,
  buildUserContent,
  classifyFile,
  extractFileReferences,
  ingestFile,
} from '../src/agent/file-ingest.js'
import { captionImage, pickVisionProvider } from '../src/agent/vision-fallback.js'

// Mock vision-fallback so the image-path test can prove the onNotice plumbing
// fires with the right provider id WITHOUT making a real Gemini/GLM API call.
// pickVisionProvider defaults to null (matches the "no key configured"
// scenario the existing tests rely on); individual tests opt in to a
// non-null sub-agent via mockReturnValue.
vi.mock('../src/agent/vision-fallback.js', () => ({
  pickVisionProvider: vi.fn(() => null),
  captionImage: vi.fn(),
}))

// Mock tesseract so the OCR fallback path doesn't spawn a real worker
// thread on test images. Without this, when the sub-agent test forces
// captionImage to reject, ingestFile falls through to ocrImage() which
// crashes the worker on any non-decodable input and leaks an unhandled
// exception into the test runner. Returning a deterministic stub keeps
// the assertion focused on the notice + plumbing behavior.
vi.mock('tesseract.js', () => ({
  createWorker: vi.fn(async () => ({
    recognize: vi.fn(async () => ({ data: { text: '' } })),
    terminate: vi.fn(async () => {}),
  })),
}))

let tmpDir: string
let textFile: string
let jsonFile: string
let imageFile: string

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcc-ingest-'))
  textFile = path.join(tmpDir, 'hello.md')
  jsonFile = path.join(tmpDir, 'data.json')
  imageFile = path.join(tmpDir, 'fake.png')
  await fs.writeFile(textFile, '# Hello\nLine 2')
  await fs.writeFile(jsonFile, '{"ok":true}')
  // Empty file is fine — classifyFile picks .png by extension and the
  // mocked captionImage never reads the bytes. ingestFile only reads the
  // buffer for the multimodal-provider path, which we don't exercise here.
  await fs.writeFile(imageFile, '')
})

afterAll(async () => {
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

  it('recognizes .png as image by extension', async () => {
    // Doesn't need the file to exist — extension-only check.
    expect(await classifyFile('/does/not/exist.png')).toBe('image')
  })

  it('recognizes .pdf as pdf by extension', async () => {
    expect(await classifyFile('/does/not/exist.pdf')).toBe('pdf')
  })

  it('recognizes .docx as office by extension', async () => {
    expect(await classifyFile('/does/not/exist.docx')).toBe('office')
  })
})

describe('ingestFile', () => {
  const multimodalCaps = { image: true, pdf: true, filesApi: true }
  const textOnlyCaps = { image: false, pdf: false, filesApi: false }

  it('inlines text files for any provider', async () => {
    const parts = await ingestFile({ raw: `@${textFile}`, absolutePath: textFile }, textOnlyCaps)
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe('text')
    if (parts[0]?.type === 'text') {
      expect(parts[0].text).toContain('Hello')
      expect(parts[0].text).toContain(textFile)
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
})

describe('buildUserContent', () => {
  it('keeps the string fast path when no references appear', async () => {
    const result = await buildUserContent('hello world', {
      image: true,
      pdf: true,
      filesApi: true,
    })
    expect(result).toBe('hello world')
  })

  it('splices ingested parts after the original user text', async () => {
    const input = `please read @${textFile}`
    const result = await buildUserContent(input, {
      image: true,
      pdf: true,
      filesApi: true,
    })
    expect(Array.isArray(result)).toBe(true)
    if (!Array.isArray(result)) return
    expect(result[0]).toEqual({ type: 'text', text: input })
    expect(result.length).toBeGreaterThan(1)
  })
})

describe('ingestFile image path with mocked vision sub-agent', () => {
  const textOnlyCaps = { image: false, pdf: false, filesApi: false }

  beforeEach(() => {
    vi.mocked(pickVisionProvider).mockReset()
    vi.mocked(captionImage).mockReset()
  })

  it('fires onNotice with the chosen sub-agent id and inlines the caption', async () => {
    // Simulate a user with DeepSeek (text-only) AND a Google key in the env —
    // the picker returns Gemini, captionImage produces a description, and the
    // resulting TextPart should both surface a notice to the UI and embed the
    // caption text + provider attribution into the part the model will see.
    vi.mocked(pickVisionProvider).mockReturnValue({
      provider: 'google',
      modelId: 'google:gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
    })
    vi.mocked(captionImage).mockResolvedValue('A red Submit button on a white card')

    const notices: string[] = []
    const parts = await ingestFile({ raw: `@${imageFile}`, absolutePath: imageFile }, textOnlyCaps, (msg) =>
      notices.push(msg),
    )

    expect(notices).toEqual(['Captioned image via google:gemini-2.5-flash'])
    expect(captionImage).toHaveBeenCalledTimes(1)
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe('text')
    if (parts[0]?.type === 'text') {
      expect(parts[0].text).toContain('A red Submit button on a white card')
      expect(parts[0].text).toContain('via="google:gemini-2.5-flash"')
      expect(parts[0].text).toContain('kind="image-caption"')
    }
  })

  it('falls back when the sub-agent throws and the notice surfaces the failure', async () => {
    // When captionImage rejects (rate limit / network / bad key),
    // ingestFile must (a) emit a "failed, falling back to OCR" notice so
    // the user sees what happened, and (b) NOT silently swallow the
    // attempt by returning the multimodal-image path. We then short-circuit
    // before OCR by asserting on the notice, since exercising real OCR on
    // an empty file destabilises the worker thread.
    vi.mocked(pickVisionProvider).mockReturnValue({
      provider: 'zhipu',
      modelId: 'zhipu:glm-4v-flash',
      label: 'GLM-4V Flash',
    })
    vi.mocked(captionImage).mockRejectedValue(new Error('rate limit exceeded'))

    const notices: string[] = []
    await ingestFile({ raw: `@${imageFile}`, absolutePath: imageFile }, textOnlyCaps, (msg) => notices.push(msg))

    expect(captionImage).toHaveBeenCalledTimes(1)
    // Two things must hold: the failure was reported AND it included the
    // chosen sub-agent's label so the user knows what tried and lost.
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('GLM-4V Flash')
    expect(notices[0]).toContain('rate limit exceeded')
    expect(notices[0]).toContain('falling back to OCR')
  })
})
