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
    const lines = Array.from({ length: 600 }, (_, i) => `// line ${i + 1}`)
    await fs.writeFile(filePath, lines.join('\n'))

    const result = (await exec({ filePath })) as string
    expect(result).toContain('showing first 500')
    expect(result).toContain('600')
    expect(result).not.toContain('501\t')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('does NOT truncate when offset/limit is specified', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-rf-'))
    const filePath = path.join(tmpDir, 'big2.ts')
    const lines = Array.from({ length: 600 }, (_, i) => `// line ${i + 1}`)
    await fs.writeFile(filePath, lines.join('\n'))

    const result = (await exec({ filePath, offset: 1, limit: 600 })) as string
    expect(result).not.toContain('showing first')
    expect(result).toContain('600\t')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('returns error for non-existent file', async () => {
    const result = (await exec({ filePath: '/tmp/nonexistent-xc-test-file.ts' })) as string
    expect(result).toContain('Error')
  })
})
