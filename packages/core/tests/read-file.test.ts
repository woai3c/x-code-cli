import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { readFile } from '../src/tools/read-file.js'

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
