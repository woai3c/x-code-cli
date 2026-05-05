// Tests for grep tool (ripgrep-based content search)
// Note: Execution tests require ripgrep binary — skipped if not available
import { describe, expect, it } from 'vitest'

import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { grep } from '../src/tools/grep.js'

function isRipgrepAvailable(): boolean {
  // Check @vscode/ripgrep first (same as the grep tool does)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rg = require('@vscode/ripgrep') as { rgPath: string }
    execFileSync(rg.rgPath, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    /* fall through */
  }
  // Fallback to system rg
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const hasRg = isRipgrepAvailable()

describe('grep tool', () => {
  it.skipIf(!hasRg)('default output mode returns matching file paths only', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-grep-test-'))
    await fs.writeFile(path.join(tmpDir, 'hello.ts'), 'const greeting = "hello world"\nconst farewell = "goodbye"')
    await fs.writeFile(path.join(tmpDir, 'other.ts'), 'const x = 42')

    const result = (await grep.execute!(
      { pattern: 'hello', path: tmpDir },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )) as string
    // Default is files_with_matches: file paths but NOT the content
    // lines around the match (no "greeting" / "farewell").
    expect(result).toContain('hello.ts')
    expect(result).not.toContain('greeting')
    expect(result).not.toContain('farewell')

    await fs.rm(tmpDir, { recursive: true })
  })

  it.skipIf(!hasRg)('content output mode returns matching lines with line numbers', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-grep-content-'))
    await fs.writeFile(path.join(tmpDir, 'hello.ts'), 'const greeting = "hello world"\nconst farewell = "goodbye"')

    const result = (await grep.execute!(
      { pattern: 'hello', path: tmpDir, outputMode: 'content' },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )) as string
    expect(result).toContain('greeting')
    expect(result).toMatch(/:1:/)

    await fs.rm(tmpDir, { recursive: true })
  })

  it.skipIf(!hasRg)('count output mode returns per-file match counts', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-grep-count-'))
    await fs.writeFile(path.join(tmpDir, 'hello.ts'), 'foo\nfoo\nfoo\nbar')
    await fs.writeFile(path.join(tmpDir, 'other.ts'), 'foo\nbar')

    const result = (await grep.execute!(
      { pattern: 'foo', path: tmpDir, outputMode: 'count' },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )) as string
    // Format: <file>:<count>, no content lines.
    expect(result).toMatch(/hello\.ts:3/)
    expect(result).toMatch(/other\.ts:1/)
    expect(result).not.toContain('bar')

    await fs.rm(tmpDir, { recursive: true })
  })

  it.skipIf(!hasRg)('content mode supports context lines around matches', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-grep-ctx-'))
    await fs.writeFile(path.join(tmpDir, 'a.ts'), 'before-line\nMATCH\nafter-line\n')

    const result = (await grep.execute!(
      { pattern: 'MATCH', path: tmpDir, outputMode: 'content', context: 1 },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )) as string
    expect(result).toContain('before-line')
    expect(result).toContain('MATCH')
    expect(result).toContain('after-line')

    await fs.rm(tmpDir, { recursive: true })
  })

  it.skipIf(!hasRg)('caseInsensitive matches without regex flags', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-grep-i-'))
    await fs.writeFile(path.join(tmpDir, 'a.ts'), 'HELLO world')

    const result = (await grep.execute!(
      { pattern: 'hello', path: tmpDir, outputMode: 'content', caseInsensitive: true },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )) as string
    expect(result).toContain('HELLO')

    await fs.rm(tmpDir, { recursive: true })
  })

  it.skipIf(!hasRg)('returns no matches message when nothing found', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-grep-test-'))
    await fs.writeFile(path.join(tmpDir, 'empty.ts'), 'const x = 1')

    const result = await grep.execute!(
      { pattern: 'nonexistent_pattern_xyz', path: tmpDir },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )
    expect(result).toContain('No matches found')

    await fs.rm(tmpDir, { recursive: true })
  })

  it.skipIf(!hasRg)('supports glob filter', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-grep-test-'))
    await fs.writeFile(path.join(tmpDir, 'code.ts'), 'hello world')
    await fs.writeFile(path.join(tmpDir, 'code.js'), 'hello world')

    const result = await grep.execute!(
      { pattern: 'hello', path: tmpDir, glob: '*.ts' },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )
    expect(result).toContain('code.ts')
    expect(result).not.toContain('code.js')

    await fs.rm(tmpDir, { recursive: true })
  })

  it.skipIf(!hasRg)('truncates results when exceeding headLimit and offers offset for next page', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-grep-limit-'))
    const lines: string[] = []
    for (let i = 0; i < 30; i++) {
      lines.push(`match_target line ${i}`)
    }
    await fs.writeFile(path.join(tmpDir, 'big.txt'), lines.join('\n'))

    const result = (await grep.execute!(
      { pattern: 'match_target', path: tmpDir, outputMode: 'content', headLimit: 5 },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )) as string
    expect(result).toContain('more not shown')
    // The hint should tell the model exactly which offset to ask for next.
    expect(result).toMatch(/offset=5/)
    const matchLines = result.split('\n').filter((l) => l.includes('match_target') && !l.includes('...'))
    expect(matchLines.length).toBeLessThanOrEqual(5)

    await fs.rm(tmpDir, { recursive: true })
  })

  it.skipIf(!hasRg)('offset paginates past the previous page', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-grep-offset-'))
    const lines: string[] = []
    for (let i = 0; i < 30; i++) {
      lines.push(`pageline ${i}`)
    }
    await fs.writeFile(path.join(tmpDir, 'p.txt'), lines.join('\n'))

    const result = (await grep.execute!(
      { pattern: 'pageline', path: tmpDir, outputMode: 'content', headLimit: 5, offset: 10 },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )) as string
    // Should contain lines 10-14 (the slice), not 0-4.
    expect(result).toMatch(/pageline 10/)
    expect(result).not.toMatch(/pageline 0\b/)

    await fs.rm(tmpDir, { recursive: true })
  })
})
