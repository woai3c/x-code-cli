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

  // Regression: the description string promises "sorted by modification
  // time, most recent first". Earlier the implementation used globby with
  // no explicit sort and resolved to alphabetical order — description and
  // behavior diverged. Now glob delegates to `rg --sortr=modified`, so
  // most-recent files must appear first.
  it('returns files sorted by modification time, most recent first', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-sort-'))
    // Create files in alphabetical order, but stamp their mtimes in the
    // opposite order so alphabetical sort != mtime sort.
    const files = ['a.ts', 'b.ts', 'c.ts']
    for (const f of files) {
      await fs.writeFile(path.join(tmpDir, f), '')
    }
    // a.ts oldest, c.ts newest
    const baseTime = Date.now()
    await fs.utimes(path.join(tmpDir, 'a.ts'), new Date(baseTime - 3000), new Date(baseTime - 3000))
    await fs.utimes(path.join(tmpDir, 'b.ts'), new Date(baseTime - 2000), new Date(baseTime - 2000))
    await fs.utimes(path.join(tmpDir, 'c.ts'), new Date(baseTime - 1000), new Date(baseTime - 1000))

    const result = (await glob.execute!(
      { pattern: '*.ts', cwd: tmpDir },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )) as string

    const lines = result.split('\n').filter((l) => l.endsWith('.ts'))
    // Newest (c.ts) must precede older files in the result.
    const cIdx = lines.findIndex((l) => l.endsWith('c.ts'))
    const bIdx = lines.findIndex((l) => l.endsWith('b.ts'))
    const aIdx = lines.findIndex((l) => l.endsWith('a.ts'))
    expect(cIdx).toBeGreaterThanOrEqual(0)
    expect(cIdx).toBeLessThan(bIdx)
    expect(bIdx).toBeLessThan(aIdx)

    await fs.rm(tmpDir, { recursive: true })
  })

  // Regression: ripgrep's `--glob "**/*"` is treated as a whitelist that
  // overrides .gitignore, so feeding the model's catch-all pattern through
  // verbatim returns tens of thousands of node_modules / .git files. The
  // tool detects catch-all patterns and drops --glob so ripgrep's default
  // walk (which honors .gitignore) takes over.
  it('catch-all pattern (**/*) honors .gitignore', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-catchall-'))
    // Create a fake .gitignore that excludes "junk/"
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'junk/\n')
    await fs.writeFile(path.join(tmpDir, 'keep.ts'), '')
    await fs.mkdir(path.join(tmpDir, 'junk'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'junk', 'noise.ts'), '')
    // Need a .git folder for ripgrep to recognize the dir as a git tree
    // and pick up the local .gitignore.
    await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true })

    const result = (await glob.execute!(
      { pattern: '**/*', cwd: tmpDir },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )) as string

    expect(result).toContain('keep.ts')
    // The junk/ directory must be excluded by .gitignore — if --glob
    // "**/*" leaks the whitelist override, junk/noise.ts shows up.
    expect(result).not.toContain('noise.ts')

    await fs.rm(tmpDir, { recursive: true })
  })

  // Regression: --hidden walks into .git/ because .gitignore typically
  // doesn't list it (git manages .git/ itself). Without an explicit
  // `--glob '!.git'` the result would include .git/objects/<hash> files,
  // .git/HEAD, .git/config, etc. — thousands of internal-state files
  // that the model has no business seeing.
  it('excludes .git/ directory contents', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-gitdir-'))
    await fs.writeFile(path.join(tmpDir, 'real.ts'), '')
    await fs.mkdir(path.join(tmpDir, '.git', 'objects'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await fs.writeFile(path.join(tmpDir, '.git', 'config'), '[core]\n')
    await fs.writeFile(path.join(tmpDir, '.git', 'objects', 'abc123'), 'binary')

    const result = (await glob.execute!(
      { pattern: '**/*', cwd: tmpDir },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )) as string

    expect(result).toContain('real.ts')
    // None of the .git internal files should leak through.
    expect(result).not.toContain('HEAD')
    expect(result).not.toContain('abc123')
    // Config might match a separate config token — assert on the path
    // segment rather than the bare word.
    expect(result).not.toContain(`.git${path.sep}config`)

    await fs.rm(tmpDir, { recursive: true })
  })
})
