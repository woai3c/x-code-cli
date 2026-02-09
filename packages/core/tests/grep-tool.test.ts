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
  it('has correct metadata', () => {
    expect(grep.description).toContain('regex')
    expect(grep.inputSchema).toBeDefined()
    expect(grep.execute).toBeDefined()
  })

  it.skipIf(!hasRg)('finds matching content in files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-grep-test-'))
    await fs.writeFile(path.join(tmpDir, 'hello.ts'), 'const greeting = "hello world"\nconst farewell = "goodbye"')
    await fs.writeFile(path.join(tmpDir, 'other.ts'), 'const x = 42')

    const result = await grep.execute!(
      { pattern: 'hello', path: tmpDir },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )
    expect(result).toContain('hello')
    expect(result).toContain('hello.ts')

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

  it('handles errors gracefully when rg is not available', async () => {
    if (hasRg) return // Only test this when rg is NOT available
    const result = await grep.execute!(
      { pattern: 'test', path: '/tmp' },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )
    expect(result).toContain('Error')
  })
})
