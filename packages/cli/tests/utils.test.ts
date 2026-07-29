import { describe, expect, it } from 'vitest'

import { formatCompactionResult, getToolResultSummary } from '../src/ui/utils.js'

describe('compaction usage reports', () => {
  it('reports the estimated context sizes after compression', () => {
    expect(formatCompactionResult(85_971, 23_953)).toBe(
      'Conversation compressed (estimated): before ~86.0k; removed ~62.0k; after ~24.0k.',
    )
  })

  it('clamps removed to zero when summary grew', () => {
    expect(formatCompactionResult(10_000, 12_500)).toBe(
      'Conversation compressed (estimated): before ~10.0k; removed ~0; after ~12.5k.',
    )
  })
})

describe('CLI tool result summaries', () => {
  it('preserves complete shell table output instead of truncating away the bottom border', () => {
    const table = [
      '┌──────┬────────┐',
      '│ Name │ Status │',
      '├──────┼────────┤',
      '│ api  │ ok     │',
      '│ web  │ ok     │',
      '└──────┴────────┘',
    ].join('\n')

    expect(getToolResultSummary('shell', table, 'completed')).toBe(table)
  })

  it('keeps the bottom border when summarizing a long shell table', () => {
    const rows = Array.from({ length: 40 }, (_, i) => `│ svc-${i.toString().padStart(2, '0')} │ ok │`)
    const table = ['┌────────┬────┐', '│ Name   │ St │', '├────────┼────┤', ...rows, '└────────┴────┘'].join('\n')

    const summary = getToolResultSummary('shell', table, 'completed')

    expect(summary).toContain('... +')
    expect(summary?.endsWith('└────────┴────┘')).toBe(true)
  })
})
