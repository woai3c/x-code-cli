import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { type ReadFileCache, createReadFileTool, readFile } from '../src/tools/read-file.js'

const exec = (input: Record<string, unknown>) =>
  readFile.execute!(input as any, { toolCallId: 'test', messages: [], abortSignal: undefined as any })

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
    expect(result).toContain('2500')
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

  it('returns error for non-existent file', async () => {
    const result = (await exec({ filePath: '/tmp/nonexistent-xc-test-file.ts' })) as string
    expect(result).toContain('Error')
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
})

describe('readFile — read de-dup cache', () => {
  const execWith = (tool: ReturnType<typeof createReadFileTool>, input: Record<string, unknown>) =>
    tool.execute!(input as any, { toolCallId: 'test', messages: [], abortSignal: undefined as any })

  it('returns a stub when re-reading an unchanged file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-dd-'))
    const filePath = path.join(tmpDir, 'a.txt')
    await fs.writeFile(filePath, 'line one\nline two\n')
    const cache: ReadFileCache = new Map()
    const tool = createReadFileTool(cache)

    const first = (await execWith(tool, { filePath })) as string
    expect(first).toContain('line one')

    const second = (await execWith(tool, { filePath })) as string
    expect(second).toContain('unchanged since you last read it')
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
