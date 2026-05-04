import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { parseSimpleGitignore, scanWorkspaceFiles } from '../src/ui/hooks/use-file-completion.js'

describe('parseSimpleGitignore', () => {
  it('extracts bare names', () => {
    const ig = parseSimpleGitignore('node_modules\ndist\n')
    expect(ig.names.has('node_modules')).toBe(true)
    expect(ig.names.has('dist')).toBe(true)
  })

  it('extracts suffix patterns', () => {
    const ig = parseSimpleGitignore('*.log\n*.tsbuildinfo\n')
    expect(ig.suffixes.has('.log')).toBe(true)
    expect(ig.suffixes.has('.tsbuildinfo')).toBe(true)
  })

  it('skips comments, blanks, and negations', () => {
    const ig = parseSimpleGitignore('# a comment\n\n!important.log\n')
    expect(ig.names.size).toBe(0)
    expect(ig.suffixes.size).toBe(0)
  })

  it('strips leading and trailing slashes', () => {
    const ig = parseSimpleGitignore('/foo\nbar/\n')
    expect(ig.names.has('foo')).toBe(true)
    expect(ig.names.has('bar')).toBe(true)
  })

  it('drops compound patterns we do not handle (mid-slash, glob, ?)', () => {
    const ig = parseSimpleGitignore('foo/bar\n**/baz\nx?.log\n[abc].txt\n')
    expect(ig.names.size).toBe(0)
    expect(ig.suffixes.size).toBe(0)
  })

  it('lowercases suffix patterns', () => {
    const ig = parseSimpleGitignore('*.LOG\n')
    expect(ig.suffixes.has('.log')).toBe(true)
  })
})

describe('scanWorkspaceFiles', () => {
  let root: string

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcc-scan-'))
    // Layout:
    //   top.ts
    //   src/ChatInput.tsx
    //   src/foo.ts
    //   node_modules/some-pkg/index.js   (must be skipped — hard blacklist)
    //   .git/HEAD                         (must be skipped — hard blacklist)
    //   build.log                         (only skipped if *.log gitignore'd)
    //   .hidden                           (kept; menu's score layer hides)
    await fs.writeFile(path.join(root, 'top.ts'), '')
    await fs.mkdir(path.join(root, 'src'))
    await fs.writeFile(path.join(root, 'src', 'ChatInput.tsx'), '')
    await fs.writeFile(path.join(root, 'src', 'foo.ts'), '')
    await fs.mkdir(path.join(root, 'node_modules', 'some-pkg'), { recursive: true })
    await fs.writeFile(path.join(root, 'node_modules', 'some-pkg', 'index.js'), '')
    await fs.mkdir(path.join(root, '.git'))
    await fs.writeFile(path.join(root, '.git', 'HEAD'), '')
    await fs.writeFile(path.join(root, 'build.log'), '')
    await fs.writeFile(path.join(root, '.hidden'), '')
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('walks the tree and produces POSIX-style relative paths', async () => {
    const entries = await scanWorkspaceFiles({ rootDir: root, ignore: { names: new Set(), suffixes: new Set() } })
    const paths = entries.map((e) => e.relPath).sort()
    expect(paths).toContain('top.ts')
    expect(paths).toContain('src/ChatInput.tsx')
    expect(paths).toContain('src/foo.ts')
    expect(paths).toContain('build.log')
    expect(paths).toContain('.hidden')
    expect(paths).toContain('src')
  })

  it('skips hard-blacklisted directories (node_modules, .git)', async () => {
    const entries = await scanWorkspaceFiles({ rootDir: root, ignore: { names: new Set(), suffixes: new Set() } })
    expect(entries.find((e) => e.relPath.includes('node_modules'))).toBeUndefined()
    expect(entries.find((e) => e.relPath.includes('.git'))).toBeUndefined()
  })

  it('honors the simple gitignore suffix layer', async () => {
    const entries = await scanWorkspaceFiles({
      rootDir: root,
      ignore: { names: new Set(), suffixes: new Set(['.log']) },
    })
    expect(entries.find((e) => e.relPath === 'build.log')).toBeUndefined()
  })

  it('honors the gitignore name layer', async () => {
    const entries = await scanWorkspaceFiles({
      rootDir: root,
      ignore: { names: new Set(['src']), suffixes: new Set() },
    })
    expect(entries.find((e) => e.relPath.startsWith('src'))).toBeUndefined()
  })

  it('marks directories explicitly', async () => {
    const entries = await scanWorkspaceFiles({ rootDir: root, ignore: { names: new Set(), suffixes: new Set() } })
    const srcEntry = entries.find((e) => e.relPath === 'src')
    expect(srcEntry?.isDirectory).toBe(true)
    const fileEntry = entries.find((e) => e.relPath === 'top.ts')
    expect(fileEntry?.isDirectory).toBe(false)
  })

  it('caps the result at maxEntries', async () => {
    const entries = await scanWorkspaceFiles({
      rootDir: root,
      maxEntries: 2,
      ignore: { names: new Set(), suffixes: new Set() },
    })
    expect(entries.length).toBeLessThanOrEqual(2)
  })

  it('returns empty when aborted before the first readdir', async () => {
    const ac = new AbortController()
    ac.abort()
    const entries = await scanWorkspaceFiles({
      rootDir: root,
      signal: ac.signal,
      ignore: { names: new Set(), suffixes: new Set() },
    })
    expect(entries).toEqual([])
  })
})
