// Tests for glob tool

import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { glob } from '../src/tools/glob.js'

describe('glob tool', () => {
  it('has correct metadata', () => {
    expect(glob.description).toContain('glob')
    expect(glob.inputSchema).toBeDefined()
    expect(glob.execute).toBeDefined()
  })

  it('finds files matching a pattern', async () => {
    // Use a temp directory with known files
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-test-'))
    await fs.writeFile(path.join(tmpDir, 'a.ts'), 'const a = 1')
    await fs.writeFile(path.join(tmpDir, 'b.ts'), 'const b = 2')
    await fs.writeFile(path.join(tmpDir, 'c.js'), 'const c = 3')

    const result = await glob.execute!({ pattern: '*.ts', cwd: tmpDir }, { toolCallId: 'test', messages: [], abortSignal: undefined as any })
    expect(result).toContain('a.ts')
    expect(result).toContain('b.ts')
    expect(result).not.toContain('c.js')

    // Cleanup
    await fs.rm(tmpDir, { recursive: true })
  })

  it('returns message when no files match', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-test-'))

    const result = await glob.execute!({ pattern: '*.xyz', cwd: tmpDir }, { toolCallId: 'test', messages: [], abortSignal: undefined as any })
    expect(result).toContain('No files found')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('finds files with ** pattern', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-test-'))
    await fs.mkdir(path.join(tmpDir, 'sub'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'sub', 'deep.ts'), 'export {}')

    const result = await glob.execute!({ pattern: '**/*.ts', cwd: tmpDir }, { toolCallId: 'test', messages: [], abortSignal: undefined as any })
    expect(result).toContain('deep.ts')

    await fs.rm(tmpDir, { recursive: true })
  })
})
