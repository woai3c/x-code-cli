import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  buildUserContent,
  classifyFile,
  extractFileReferences,
  ingestFile,
} from '../src/agent/file-ingest.js'

let tmpDir: string
let textFile: string
let jsonFile: string
let unknownFile: string

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcc-ingest-'))
  textFile = path.join(tmpDir, 'hello.md')
  jsonFile = path.join(tmpDir, 'data.json')
  unknownFile = path.join(tmpDir, 'no-extension')
  await fs.writeFile(textFile, '# Hello\nLine 2')
  await fs.writeFile(jsonFile, '{"ok":true}')
  await fs.writeFile(unknownFile, 'plain body')
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

  it('ignores tokens without path separators', () => {
    const refs = extractFileReferences('call fs.readFile then foo.bar.baz')
    expect(refs).toHaveLength(0)
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

  it('recognizes extensions without a dot fallback', async () => {
    expect(await classifyFile(unknownFile)).toBe('text')
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
