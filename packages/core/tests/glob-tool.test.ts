// Tests for glob tool
import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { glob } from '../src/tools/glob.js'

describe('glob tool', () => {
  it('finds files matching a pattern', async () => {
    // Use a temp directory with known files
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-test-'))
    await fs.writeFile(path.join(tmpDir, 'a.ts'), 'const a = 1')
    await fs.writeFile(path.join(tmpDir, 'b.ts'), 'const b = 2')
    await fs.writeFile(path.join(tmpDir, 'c.js'), 'const c = 3')

    const result = await glob.execute!(
      { pattern: '*.ts', cwd: tmpDir },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )
    expect(result).toContain('a.ts')
    expect(result).toContain('b.ts')
    expect(result).not.toContain('c.js')

    // Cleanup
    await fs.rm(tmpDir, { recursive: true })
  })

  it('returns message when no files match', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-test-'))

    const result = await glob.execute!(
      { pattern: '*.xyz', cwd: tmpDir },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )
    expect(result).toContain('No files found')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('finds files with ** pattern', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-test-'))
    await fs.mkdir(path.join(tmpDir, 'sub'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'sub', 'deep.ts'), 'export {}')

    const result = await glob.execute!(
      { pattern: '**/*.ts', cwd: tmpDir },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )
    expect(result).toContain('deep.ts')

    await fs.rm(tmpDir, { recursive: true })
  })

  // Regression: tool description has always promised "sorted by
  // modification time" but the implementation just returned globby's
  // filesystem order. Now actually sorted, newest first.
  it('returns results sorted by modification time, newest first', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-mtime-'))
    // Create three files with explicit, ordered mtimes so the test
    // doesn't depend on filesystem-resolution-clock luck.
    await fs.writeFile(path.join(tmpDir, 'oldest.ts'), '')
    await fs.utimes(path.join(tmpDir, 'oldest.ts'), new Date(2020, 0, 1), new Date(2020, 0, 1))
    await fs.writeFile(path.join(tmpDir, 'middle.ts'), '')
    await fs.utimes(path.join(tmpDir, 'middle.ts'), new Date(2022, 0, 1), new Date(2022, 0, 1))
    await fs.writeFile(path.join(tmpDir, 'newest.ts'), '')
    await fs.utimes(path.join(tmpDir, 'newest.ts'), new Date(2024, 0, 1), new Date(2024, 0, 1))

    const result = (await glob.execute!(
      { pattern: '*.ts', cwd: tmpDir },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )) as string
    const lines = result.split('\n').filter((l) => l.includes('.ts'))
    // Newest must come first, oldest last.
    const newestIdx = lines.findIndex((l) => l.includes('newest.ts'))
    const middleIdx = lines.findIndex((l) => l.includes('middle.ts'))
    const oldestIdx = lines.findIndex((l) => l.includes('oldest.ts'))
    expect(newestIdx).toBe(0)
    expect(middleIdx).toBe(1)
    expect(oldestIdx).toBe(2)

    await fs.rm(tmpDir, { recursive: true })
  })

  it('truncates results when exceeding the cap (200)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-cap-'))
    const count = 210
    for (let i = 0; i < count; i++) {
      await fs.writeFile(path.join(tmpDir, `file-${String(i).padStart(4, '0')}.ts`), '')
    }

    const result = (await glob.execute!(
      { pattern: '*.ts', cwd: tmpDir },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )) as string
    expect(result).toContain('more files not shown')
    expect(result).toContain('capped at 200')
    const lines = result.split('\n').filter((l) => l.includes('.ts') && !l.includes('...'))
    expect(lines.length).toBeLessThanOrEqual(200)

    await fs.rm(tmpDir, { recursive: true })
  })
})
