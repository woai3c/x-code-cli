import { describe, expect, it } from 'vitest'

import { dedupeChoiceLabels, forkLineageHint } from '../src/ui/app/session-format.js'
import { GLYPH_FORK_ARROW } from '../src/ui/render/terminal-glyphs.js'

describe('forkLineageHint', () => {
  const byId = new Map([
    ['parent-named', { name: 'main line', firstPrompt: 'do the base work' }],
    ['parent-unnamed', { firstPrompt: 'fix   the\nlogin   bug' }],
    ['parent-empty', { firstPrompt: '' }],
  ])

  it('returns null for non-forked sessions', () => {
    expect(forkLineageHint({}, byId)).toBeNull()
  })

  it('prefers the parent name over its first prompt', () => {
    const hint = forkLineageHint({ forkedFrom: { sessionId: 'parent-named', messageCount: 4, forkedAt: '' } }, byId)
    expect(hint).toBe(`${GLYPH_FORK_ARROW} fork of main line`)
  })

  it('falls back to a whitespace-collapsed prompt preview', () => {
    const hint = forkLineageHint({ forkedFrom: { sessionId: 'parent-unnamed', messageCount: 4, forkedAt: '' } }, byId)
    expect(hint).toBe(`${GLYPH_FORK_ARROW} fork of fix the login bug`)
  })

  it('labels prompt-less parents as (empty)', () => {
    const hint = forkLineageHint({ forkedFrom: { sessionId: 'parent-empty', messageCount: 4, forkedAt: '' } }, byId)
    expect(hint).toBe(`${GLYPH_FORK_ARROW} fork of (empty)`)
  })

  it('falls back to the id prefix when the parent session is gone', () => {
    const hint = forkLineageHint(
      { forkedFrom: { sessionId: '20260101-120000-000', messageCount: 4, forkedAt: '' } },
      byId,
    )
    expect(hint).toBe(`${GLYPH_FORK_ARROW} fork of 20260101`)
  })
})

describe('dedupeChoiceLabels', () => {
  it('leaves unique labels untouched', () => {
    const choices = [
      { label: 'a', sessionId: '1' },
      { label: 'b', sessionId: '2' },
    ]
    expect(dedupeChoiceLabels(choices).map((c) => c.label)).toEqual(['a', 'b'])
  })

  it('appends the sessionId to repeated labels so every row stays selectable', () => {
    const choices = [
      { label: 'experiment  ·  2m ago', sessionId: '20260101-120000-000', extra: 1 },
      { label: 'experiment  ·  2m ago', sessionId: '20260101-120001-000', extra: 2 },
      { label: 'experiment  ·  2m ago', sessionId: '20260101-120002-000', extra: 3 },
    ]
    const result = dedupeChoiceLabels(choices)
    expect(new Set(result.map((c) => c.label)).size).toBe(3)
    expect(result[0].label).toBe('experiment  ·  2m ago')
    expect(result[1].label).toContain('20260101-120001-000')
    expect(result[2].label).toContain('20260101-120002-000')
    // Non-label fields survive the spread.
    expect(result[1].extra).toBe(2)
  })
})
