import { describe, expect, it } from 'vitest'

import { computeEditDiff } from '../src/agent/diff.js'

describe('computeEditDiff', () => {
  it('returns create payload for new files (oldContent = null)', () => {
    const result = computeEditDiff('test.ts', null, 'line1\nline2\nline3\n')
    expect(result).not.toBeNull()
    expect(result!.isCreate).toBe(true)
    expect(result!.additions).toBe(3)
    expect(result!.removals).toBe(0)
    expect(result!.hunks).toEqual([])
    expect(result!.content).toBe('line1\nline2\nline3\n')
  })

  it('returns null when content is identical', () => {
    const content = 'const x = 1\n'
    const result = computeEditDiff('test.ts', content, content)
    expect(result).toBeNull()
  })

  it('returns hunks for a simple edit', () => {
    const old = 'line1\nline2\nline3\n'
    const new_ = 'line1\nmodified\nline3\n'
    const result = computeEditDiff('test.ts', old, new_)
    expect(result).not.toBeNull()
    expect(result!.isCreate).toBe(false)
    expect(result!.hunks.length).toBeGreaterThan(0)
    expect(result!.additions).toBeGreaterThan(0)
    expect(result!.removals).toBeGreaterThan(0)
  })

  it('counts additions for appended lines', () => {
    const old = 'line1\n'
    const new_ = 'line1\nline2\nline3\n'
    const result = computeEditDiff('test.ts', old, new_)
    expect(result).not.toBeNull()
    expect(result!.additions).toBe(2)
    expect(result!.removals).toBe(0)
  })

  it('counts removals for deleted lines', () => {
    const old = 'line1\nline2\nline3\n'
    const new_ = 'line1\n'
    const result = computeEditDiff('test.ts', old, new_)
    expect(result).not.toBeNull()
    expect(result!.removals).toBe(2)
    expect(result!.additions).toBe(0)
  })

  it('handles empty new file creation', () => {
    const result = computeEditDiff('empty.ts', null, '')
    expect(result).not.toBeNull()
    expect(result!.isCreate).toBe(true)
    expect(result!.additions).toBe(0)
  })
})
