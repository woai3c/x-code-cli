// Integration tests for the grep tool's new output modes / filters. These run
// the bundled ripgrep against real temp files to verify the schema → rg flag
// mapping end-to-end.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { grep } from '../src/tools/grep.js'

const exec = (input: Record<string, unknown>) =>
  grep.execute!(input as any, { toolCallId: 'test', messages: [], abortSignal: undefined as any })

let dir: string
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-grep-'))
  await fs.writeFile(path.join(dir, 'a.ts'), 'export const foo = 1\nconst bar = 2\nFOO again\n')
  await fs.writeFile(path.join(dir, 'b.ts'), 'function baz() {}\nconst foo2 = foo\n')
  await fs.writeFile(path.join(dir, 'c.md'), 'foo in markdown\n')
})
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('grep tool', () => {
  it('content mode returns line-numbered matches', async () => {
    const out = (await exec({ pattern: 'foo', path: dir })) as string
    expect(out).toMatch(/a\.ts:1:/)
    expect(out).toContain('export const foo = 1')
  })

  it('files_with_matches returns only paths, no line content', async () => {
    const out = (await exec({ pattern: 'foo', path: dir, outputMode: 'files_with_matches' })) as string
    expect(out).toContain('a.ts')
    expect(out).toContain('b.ts')
    expect(out).not.toContain('export const foo = 1')
  })

  it('count mode returns per-file match counts', async () => {
    const out = (await exec({ pattern: 'foo', path: dir, outputMode: 'count' })) as string
    expect(out).toMatch(/a\.ts:\d+/)
  })

  it('caseInsensitive widens matching across case', async () => {
    const sensitive = (await exec({ pattern: 'FOO', path: dir })) as string
    expect(sensitive).toContain('FOO again')
    expect(sensitive).not.toContain('export const foo = 1')

    const insensitive = (await exec({ pattern: 'FOO', path: dir, caseInsensitive: true })) as string
    expect(insensitive).toContain('export const foo = 1')
    expect(insensitive).toContain('FOO again')
  })

  it('type filter restricts to a language', async () => {
    const out = (await exec({ pattern: 'foo', path: dir, type: 'ts' })) as string
    expect(out).toContain('a.ts')
    expect(out).not.toContain('c.md')
  })

  it('linesAfter includes trailing context', async () => {
    const out = (await exec({ pattern: 'bar', path: dir, linesAfter: 1 })) as string
    expect(out).toContain('const bar = 2')
    expect(out).toContain('FOO again')
  })

  it('returns "No matches found." when nothing matches', async () => {
    const out = (await exec({ pattern: 'zzzznotfound', path: dir })) as string
    expect(out).toBe('No matches found.')
  })
})
