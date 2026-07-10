import { describe, expect, it } from 'vitest'

import { getToolResultSummary } from '../src/ui/utils.js'

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
