import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { listDir } from '../src/tools/list-dir.js'

const exec = (input: Record<string, unknown>) =>
  listDir.execute!(input as any, { toolCallId: 'test', messages: [], abortSignal: undefined as any })

describe('listDir tool', () => {
  it('lists files and directories', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-ld-'))
    await fs.writeFile(path.join(tmpDir, 'file.ts'), 'content')
    await fs.mkdir(path.join(tmpDir, 'subdir'))

    const result = (await exec({ dirPath: tmpDir })) as string
    expect(result).toContain('file.ts')
    expect(result).toContain('subdir/')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('shows "/" suffix for directories only', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-ld-'))
    await fs.writeFile(path.join(tmpDir, 'readme.md'), '')
    await fs.mkdir(path.join(tmpDir, 'src'))

    const result = (await exec({ dirPath: tmpDir })) as string
    const lines = result.split('\n')
    const dirLine = lines.find((l) => l.includes('src'))
    const fileLine = lines.find((l) => l.includes('readme'))
    expect(dirLine).toBe('src/')
    expect(fileLine).toBe('readme.md')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('returns "(empty directory)" for empty dirs', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-ld-'))

    const result = (await exec({ dirPath: tmpDir })) as string
    expect(result).toBe('(empty directory)')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('returns error for non-existent directory', async () => {
    const result = (await exec({ dirPath: '/tmp/nonexistent-xc-dir-test' })) as string
    expect(result).toContain('Error')
  })
})
