import { describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { MAX_NOTEBOOK_SOURCE_BYTES, renderNotebookFile } from '../src/agent/notebook-render.js'
import { type ReadFileCache, createReadFileTool, parsePdfPageRange, readFile } from '../src/tools/read-file.js'

vi.mock('../src/agent/image-ocr.js', () => ({
  ocrImage: vi.fn(async () => 'mock readFile OCR'),
}))

const exec = (input: Record<string, unknown>) =>
  readFile.execute!(input as any, { toolCallId: 'test', messages: [], abortSignal: undefined } as any)

describe('readFile tool', () => {
  it('reads a text file with line numbers', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-rf-'))
    const filePath = path.join(tmpDir, 'hello.ts')
    await fs.writeFile(filePath, 'const a = 1\nconst b = 2\nconst c = 3\n')

    const result = (await exec({ filePath })) as string
    expect(result).toContain('1\tconst a = 1')
    expect(result).toContain('2\tconst b = 2')
    expect(result).toContain('3\tconst c = 3')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('decodes UTF-16LE and UTF-16BE BOM text with line numbers', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-rf-utf16-'))
    const littlePath = path.join(tmpDir, 'little.txt')
    const bigPath = path.join(tmpDir, 'big.txt')
    const littleBody = Buffer.from('你好\nsecond', 'utf16le')
    const bigBody = Buffer.from(littleBody)
    for (let index = 0; index < bigBody.length; index += 2) {
      const first = bigBody[index]!
      bigBody[index] = bigBody[index + 1]!
      bigBody[index + 1] = first
    }
    await fs.writeFile(littlePath, Buffer.concat([Buffer.from([0xff, 0xfe]), littleBody]))
    await fs.writeFile(bigPath, Buffer.concat([Buffer.from([0xfe, 0xff]), bigBody]))

    expect(await exec({ filePath: littlePath })).toContain('1\t你好\n2\tsecond')
    expect(await exec({ filePath: bigPath })).toContain('1\t你好\n2\tsecond')
    await fs.rm(tmpDir, { recursive: true })
  })

  it('supports offset and limit', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-rf-'))
    const filePath = path.join(tmpDir, 'lines.txt')
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
    await fs.writeFile(filePath, lines.join('\n'))

    const result = (await exec({ filePath, offset: 3, limit: 2 })) as string
    expect(result).toContain('3\tline 3')
    expect(result).toContain('4\tline 4')
    expect(result).not.toContain('2\tline 2')
    expect(result).not.toContain('5\tline 5')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('truncates large files and hints at ranges', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-rf-'))
    const filePath = path.join(tmpDir, 'big.ts')
    // Threshold is 2000 lines (bumped from 500 to align with Claude Code).
    const lines = Array.from({ length: 2500 }, (_, i) => `// line ${i + 1}`)
    await fs.writeFile(filePath, lines.join('\n'))

    const result = (await exec({ filePath })) as string
    expect(result).toContain('showing first 2000')
    expect(result).toContain('file contains more content')
    expect(result).not.toContain('2001\t')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('does NOT head-truncate when offset/limit is specified', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-rf-'))
    const filePath = path.join(tmpDir, 'big2.ts')
    // 2500 lines × ~12 bytes/line ≈ 30 KB — well under the 256 KB byte cap,
    // so the whole requested range comes back without further trimming.
    const lines = Array.from({ length: 2500 }, (_, i) => `// line ${i + 1}`)
    await fs.writeFile(filePath, lines.join('\n'))

    const result = (await exec({ filePath, offset: 1, limit: 2500 })) as string
    expect(result).not.toContain('showing first')
    expect(result).toContain('2500\t')

    await fs.rm(tmpDir, { recursive: true })
  })

  // Regression: a model that asked for a giant explicit range used to dump
  // the entire slice into context and blow past the model's context window
  // on the next turn. Now we hard-cap at MAX_READ_BYTES (256 KB) and tell
  // the model exactly where to resume.
  it('caps explicit-range reads at 256 KB and points at the next offset', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-rf-'))
    const filePath = path.join(tmpDir, 'huge.txt')
    // 4000 lines × ~100 bytes/line ≈ 400 KB > 256 KB cap.
    const lines = Array.from({ length: 4000 }, (_, i) => `${i + 1}: ${'x'.repeat(95)}`)
    await fs.writeFile(filePath, lines.join('\n'))

    const result = (await exec({ filePath, offset: 1, limit: 4000 })) as string
    expect(result).toContain('output capped at 256 KB')
    expect(result).toMatch(/Call readFile again with offset=\d+/)
    // Sanity: byte cap actually enforced — output well under 300 KB even
    // with the trailing hint.
    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThan(300 * 1024)

    await fs.rm(tmpDir, { recursive: true })
  })

  it('bounds memory and output for a single very long line', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-rf-'))
    const filePath = path.join(tmpDir, 'minified.js')
    await fs.writeFile(filePath, 'x'.repeat(2 * 1024 * 1024))

    const result = (await exec({ filePath })) as string
    expect(result).toContain('output capped at 256 KB')
    expect(result).toContain('line itself exceeds the cap')
    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThan(257 * 1024)

    await fs.rm(tmpDir, { recursive: true })
  })

  it('honors an already-aborted read', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = (await readFile.execute!({ filePath: '/tmp/never-read.txt' }, {
      toolCallId: 'test',
      messages: [],
      abortSignal: controller.signal,
    } as any)) as string
    expect(result).toMatch(/abort/i)
  })

  it('returns error for non-existent file', async () => {
    const result = (await exec({ filePath: '/tmp/nonexistent-xc-test-file.ts' })) as string
    expect(result).toContain('Error')
  })

  it('fails closed for an unknown binary instead of decoding it as UTF-8', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-rf-bin-'))
    const filePath = path.join(tmpDir, 'archive.txt')
    await fs.writeFile(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))
    const result = (await exec({ filePath })) as string
    expect(result).toContain('Unsupported binary file')
    await fs.rm(tmpDir, { recursive: true })
  })

  it('fails closed when streamed text contains invalid bytes beyond the classification sample', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-rf-binary-tail-'))
    const filePath = path.join(tmpDir, 'binary-tail.txt')
    await fs.writeFile(filePath, Buffer.concat([Buffer.alloc(40 * 1024, 0x61), Buffer.from([0, 0xff])]))

    const result = String(await exec({ filePath }))

    expect(result).toMatch(/Error|binary control|encoded data/i)
    expect(result).not.toContain('�')
    expect(result).not.toContain('aaaaaa')
    await fs.rm(tmpDir, { recursive: true })
  })

  it('normalizes BMP tool output to a tagged PNG FilePart', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-rf-image-'))
    const filePath = path.join(tmpDir, 'disguised.png')
    const { Jimp } = await import('jimp')
    await fs.writeFile(filePath, await new Jimp({ width: 3, height: 2, color: 0xffffffff }).getBuffer('image/bmp'))
    const result = await exec({ filePath })
    expect(result).toMatchObject({
      type: 'content',
      value: expect.arrayContaining([expect.objectContaining({ type: 'file', mediaType: 'image/png' })]),
    })
    await fs.rm(tmpDir, { recursive: true })
  })

  it('does not return GIF image-data to an xAI model', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-rf-xai-image-'))
    const filePath = path.join(tmpDir, 'unsupported.gif')
    const { Jimp } = await import('jimp')
    await fs.writeFile(filePath, await new Jimp({ width: 2, height: 2, color: 0xffffffff }).getBuffer('image/gif'))
    const tool = createReadFileTool(undefined, { modelId: 'xai:grok-4.3' })

    const result = await tool.execute!({ filePath }, {
      toolCallId: 'xai-gif-test',
      messages: [],
      abortSignal: undefined,
    } as never)

    expect(result).toContain('accepts only PNG, JPEG')
    expect(JSON.stringify(result)).not.toContain('image-data')
    await fs.rm(tmpDir, { recursive: true })
  })

  it('does not return animated GIF image-data to an OpenAI model', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-rf-openai-gif-'))
    const filePath = path.join(tmpDir, 'animated.gif')
    const { Jimp } = await import('jimp')
    const singleFrame = await new Jimp({ width: 2, height: 2, color: 0xffffffff }).getBuffer('image/gif')
    const frameStart = singleFrame.indexOf(0x2c)
    const trailer = singleFrame.lastIndexOf(0x3b)
    await fs.writeFile(
      filePath,
      Buffer.concat([
        singleFrame.subarray(0, trailer),
        singleFrame.subarray(frameStart, trailer),
        singleFrame.subarray(trailer),
      ]),
    )
    const tool = createReadFileTool(undefined, { modelId: 'openai:gpt-5.6-sol' })

    const result = await tool.execute!({ filePath }, {
      toolCallId: 'openai-animated-gif-test',
      messages: [],
      abortSignal: undefined,
    } as never)

    expect(String(result)).toMatch(/animated image\/gif|non-animated/i)
    expect(JSON.stringify(result)).not.toContain('image-data')
    await fs.rm(tmpDir, { recursive: true })
  })

  it('returns local OCR directly for a text-only model instead of persisting image-data', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-rf-image-ocr-'))
    const filePath = path.join(tmpDir, 'image.png')
    const { Jimp } = await import('jimp')
    await fs.writeFile(filePath, await new Jimp({ width: 3, height: 2, color: 0xffffffff }).getBuffer('image/png'))
    const tool = createReadFileTool(undefined, { modelId: 'deepseek:deepseek-v4-flash' })
    const result = await tool.execute!({ filePath }, {
      toolCallId: 'image-ocr-test',
      messages: [],
      abortSignal: undefined,
    } as never)

    expect(result).toContain('mock readFile OCR')
    expect(JSON.stringify(result)).not.toContain('image-data')
    await fs.rm(tmpDir, { recursive: true })
  })
})

describe('parsePdfPageRange', () => {
  it('accepts a page or inclusive range up to 20 pages', () => {
    expect(parsePdfPageRange('3')).toEqual({ first: 3, last: 3 })
    expect(parsePdfPageRange(' 1-20 ')).toEqual({ first: 1, last: 20 })
  })

  it('rejects malformed, reverse, zero and over-limit ranges', () => {
    for (const value of ['x', '3-', '4-2', '0', '1-21']) expect(parsePdfPageRange(value), value).toBeNull()
  })
})

describe('readFile — Jupyter notebooks', () => {
  it('renders cells with text outputs and omits binary outputs', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-nb-'))
    const filePath = path.join(tmpDir, 'nb.ipynb')
    const nb = {
      cells: [
        { cell_type: 'markdown', source: ['# Title\n', 'intro line'] },
        {
          cell_type: 'code',
          execution_count: 1,
          source: 'print("hi")',
          outputs: [
            { output_type: 'stream', text: ['hi\n'] },
            { output_type: 'display_data', data: { 'text/plain': '<Figure>', 'image/png': 'BASE64DATA' } },
          ],
        },
      ],
      nbformat: 4,
    }
    await fs.writeFile(filePath, JSON.stringify(nb))

    const result = (await exec({ filePath })) as string
    expect(result).toContain('# Title')
    expect(result).toContain('Cell 1 [markdown]')
    expect(result).toContain('Cell 2 [code] (exec 1)')
    expect(result).toContain('print("hi")')
    expect(result).toContain('<Figure>')
    expect(result).toContain('[image/png output omitted]')
    // The base64 image payload must NOT reach the model.
    expect(result).not.toContain('BASE64DATA')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('falls back to raw text for a malformed .ipynb', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-nb-'))
    const filePath = path.join(tmpDir, 'broken.ipynb')
    await fs.writeFile(filePath, 'not json {')
    const result = (await exec({ filePath })) as string
    expect(result).toContain('not json {')
    await fs.rm(tmpDir, { recursive: true })
  })

  it('still bounds malformed notebook output', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-nb-'))
    const filePath = path.join(tmpDir, 'huge-broken.ipynb')
    await fs.writeFile(filePath, `not-json ${'x'.repeat(300 * 1024)}`)
    const result = (await exec({ filePath })) as string
    expect(result).toContain('Notebook output truncated at 256 KB')
    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThan(257 * 1024)
    await fs.rm(tmpDir, { recursive: true })
  })

  it('stops the notebook source read at its byte limit', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-nb-'))
    const filePath = path.join(tmpDir, 'oversized.ipynb')
    await fs.writeFile(filePath, '{}')
    await fs.truncate(filePath, MAX_NOTEBOOK_SOURCE_BYTES + 1)

    await expect(renderNotebookFile(filePath)).rejects.toMatchObject({ name: 'FileSizeLimitError' })
    await fs.rm(tmpDir, { recursive: true })
  })
})

describe('readFile — read de-dup cache', () => {
  const execWith = (tool: ReturnType<typeof createReadFileTool>, input: Record<string, unknown>) =>
    tool.execute!(input as any, { toolCallId: 'test', messages: [], abortSignal: undefined } as any)

  it('returns a stub when re-reading an unchanged file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-dd-'))
    const filePath = path.join(tmpDir, 'a.txt')
    await fs.writeFile(filePath, 'line one\nline two\n')
    const cache: ReadFileCache = new Map()
    const tool = createReadFileTool(cache)

    const first = (await execWith(tool, { filePath })) as string
    expect(first).toContain('line one')

    const second = (await execWith(tool, { filePath })) as string
    expect(second).toContain('unchanged since its full content was added')
    expect(second).not.toContain('line two')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('does NOT cache a head-truncated read (large file stays re-readable)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-dd-'))
    const filePath = path.join(tmpDir, 'big.txt')
    // 2500 lines triggers head-truncation: the full content is NOT in context,
    // so a second read must return content again, not a misleading stub.
    await fs.writeFile(filePath, Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join('\n'))
    const cache: ReadFileCache = new Map()
    const tool = createReadFileTool(cache)

    const first = (await execWith(tool, { filePath })) as string
    expect(first).toContain('showing first 2000')

    const second = (await execWith(tool, { filePath })) as string
    expect(second).toContain('showing first 2000')
    expect(second).not.toContain('unchanged since')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('does not cache a failed Office extraction as complete', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-dd-office-'))
    const filePath = path.join(tmpDir, 'broken.docx')
    await fs.writeFile(filePath, Buffer.from('PK\u0003\u0004broken archive'))
    const cache: ReadFileCache = new Map()
    const tool = createReadFileTool(cache)

    const first = (await execWith(tool, { filePath })) as string
    const second = (await execWith(tool, { filePath })) as string

    expect(first).toContain('Failed to extract text')
    expect(second).toContain('Failed to extract text')
    expect(second).not.toContain('unchanged since')
    expect(cache.has(filePath)).toBe(false)

    await fs.rm(tmpDir, { recursive: true })
  })

  it('re-reads in full after the file changes', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-dd-'))
    const filePath = path.join(tmpDir, 'a.txt')
    await fs.writeFile(filePath, 'line one\nline two\n')
    const cache: ReadFileCache = new Map()
    const tool = createReadFileTool(cache)

    await execWith(tool, { filePath })
    await fs.writeFile(filePath, 'changed\n')
    const out = (await execWith(tool, { filePath })) as string
    expect(out).toContain('changed')
    expect(out).not.toContain('unchanged since')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('an explicit offset/limit read bypasses de-dup', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-dd-'))
    const filePath = path.join(tmpDir, 'a.txt')
    await fs.writeFile(filePath, 'l1\nl2\nl3\n')
    const cache: ReadFileCache = new Map()
    const tool = createReadFileTool(cache)

    await execWith(tool, { filePath }) // whole-file read populates the cache
    const ranged = (await execWith(tool, { filePath, offset: 1, limit: 1 })) as string
    expect(ranged).toContain('l1')
    expect(ranged).not.toContain('unchanged since')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('does not de-dup without a cache (default readFile export)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-dd-'))
    const filePath = path.join(tmpDir, 'a.txt')
    await fs.writeFile(filePath, 'hello\n')
    const first = (await exec({ filePath })) as string
    const second = (await exec({ filePath })) as string
    expect(first).toContain('hello')
    expect(second).toContain('hello')
    expect(second).not.toContain('unchanged since')
    await fs.rm(tmpDir, { recursive: true })
  })
})
