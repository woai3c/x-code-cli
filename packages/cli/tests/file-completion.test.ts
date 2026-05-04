import { describe, expect, it } from 'vitest'

import { type FileEntry, applyCompletion, detectAtToken, scoreAndRank } from '../src/ui/file-completion.js'

describe('detectAtToken', () => {
  it('activates immediately after a bare @ at line start', () => {
    const t = detectAtToken('@', 1)
    expect(t.active).toBe(true)
    expect(t.atIdx).toBe(0)
    expect(t.query).toBe('')
    expect(t.tokenEnd).toBe(1)
  })

  it('captures the in-progress query before the cursor', () => {
    const t = detectAtToken('hello @ch', 9)
    expect(t.active).toBe(true)
    expect(t.atIdx).toBe(6)
    expect(t.query).toBe('ch')
    expect(t.tokenEnd).toBe(9)
  })

  it('rejects @ embedded inside a word (e.g. user@host)', () => {
    const t = detectAtToken('user@host', 9)
    expect(t.active).toBe(false)
  })

  it('rejects npm-style version specifier (foo@1.2)', () => {
    // Cursor at end of "npm install foo@1.2"
    const t = detectAtToken('npm install foo@1.2', 19)
    expect(t.active).toBe(false)
  })

  it('inactive when cursor sits past the next whitespace', () => {
    const t = detectAtToken('@foo bar', 8)
    expect(t.active).toBe(false)
  })

  it('inactive when cursor immediately follows a space', () => {
    const t = detectAtToken('@foo ', 5)
    expect(t.active).toBe(false)
  })

  it('captures query when cursor is mid-token', () => {
    // "@foo|bar" — cursor at 4, full token "@foobar" runs to 7
    const t = detectAtToken('@foobar', 4)
    expect(t.active).toBe(true)
    expect(t.atIdx).toBe(0)
    expect(t.query).toBe('foo')
    expect(t.tokenEnd).toBe(7)
  })

  it('treats tabs and newlines as whitespace boundaries', () => {
    expect(detectAtToken('a\t@x', 4).active).toBe(true)
    expect(detectAtToken('a\n@x', 4).active).toBe(true)
  })

  it('rejects out-of-range cursors', () => {
    expect(detectAtToken('hello', -1).active).toBe(false)
    expect(detectAtToken('hello', 99).active).toBe(false)
  })

  it('handles bare @ at end with surrounding text after whitespace', () => {
    const t = detectAtToken('hello @', 7)
    expect(t.active).toBe(true)
    expect(t.atIdx).toBe(6)
    expect(t.query).toBe('')
    expect(t.tokenEnd).toBe(7)
  })
})

describe('scoreAndRank', () => {
  const E = (relPath: string, isDirectory = false): FileEntry => ({ relPath, isDirectory })

  it('ranks basename matches above nested-path matches', () => {
    const entries = [E('src/foo/chatter/util.ts'), E('packages/cli/src/ui/components/ChatInput.tsx')]
    const ranked = scoreAndRank(entries, 'chat')
    expect(ranked[0]?.relPath).toBe('packages/cli/src/ui/components/ChatInput.tsx')
  })

  it('hides dotfiles when query does not start with dot', () => {
    const entries = [E('.gitignore'), E('readme.md')]
    const ranked = scoreAndRank(entries, 'r')
    expect(ranked.find((r) => r.relPath === '.gitignore')).toBeUndefined()
    expect(ranked.find((r) => r.relPath === 'readme.md')).toBeDefined()
  })

  it('shows dotfiles when query starts with dot', () => {
    const entries = [E('.gitignore'), E('readme.md')]
    const ranked = scoreAndRank(entries, '.gi')
    expect(ranked[0]?.relPath).toBe('.gitignore')
  })

  it('returns shallow paths first when query is empty', () => {
    const entries = [E('a/b/c/deep.ts'), E('top.ts'), E('a/mid.ts')]
    const ranked = scoreAndRank(entries, '')
    expect(ranked[0]?.relPath).toBe('top.ts')
    expect(ranked[1]?.relPath).toBe('a/mid.ts')
    expect(ranked[2]?.relPath).toBe('a/b/c/deep.ts')
  })

  it('drops entries that fail subsequence match', () => {
    const entries = [E('foo.ts'), E('bar.ts')]
    const ranked = scoreAndRank(entries, 'xyz')
    expect(ranked).toHaveLength(0)
  })

  it('matches case-insensitively', () => {
    const ranked = scoreAndRank([E('ChatInput.tsx')], 'chat')
    expect(ranked).toHaveLength(1)
  })

  it('breaks score ties alphabetically', () => {
    // Two entries with identical basename match score on empty query —
    // both have depth 1, so tie-break should fall to alphabetical order.
    const ranked = scoreAndRank([E('zebra.ts'), E('apple.ts')], '')
    expect(ranked[0]?.relPath).toBe('apple.ts')
    expect(ranked[1]?.relPath).toBe('zebra.ts')
  })
})

describe('applyCompletion', () => {
  it('inserts the picked path replacing the @-token', () => {
    const out = applyCompletion('hello @ch', 6, 9, {
      relPath: 'src/ui/ChatInput.tsx',
      isDirectory: false,
    })
    expect(out.text).toBe('hello @src/ui/ChatInput.tsx')
    expect(out.cursor).toBe(out.text.length)
  })

  it('appends a trailing slash for directories', () => {
    const out = applyCompletion('@s', 0, 2, { relPath: 'src', isDirectory: true })
    expect(out.text).toBe('@src/')
    expect(out.cursor).toBe(5)
  })

  it('preserves text after the token end', () => {
    const out = applyCompletion('look @ch then read it', 5, 8, {
      relPath: 'a.ts',
      isDirectory: false,
    })
    expect(out.text).toBe('look @a.ts then read it')
    expect(out.cursor).toBe(10)
  })
})
