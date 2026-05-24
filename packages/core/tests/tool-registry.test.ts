// Tests for truncateToolResult — the only piece of tools/index.ts that
// has non-trivial logic worth covering at this layer.
import { describe, expect, it, vi } from 'vitest'

import { MAX_TOOL_RESULT_BYTES, truncateToolResult } from '../src/tools/index.js'

// Importing from tools/index.ts pulls in webFetch, which transitively loads
// cheerio + turndown. Mock them so the import doesn't fail in the test env.
vi.mock('cheerio', () => ({
  load: vi.fn(() => {
    const $ = () => ({ remove: vi.fn(), first: vi.fn(() => ({ length: 0, html: () => '' })), html: () => '' })
    $.load = $
    return $
  }),
}))

vi.mock('turndown', () => ({
  default: class {
    turndown() {
      return ''
    }
  },
}))

describe('truncateToolResult', () => {
  it('does not truncate results at exactly the byte limit', () => {
    const exact = 'x'.repeat(MAX_TOOL_RESULT_BYTES)
    expect(truncateToolResult(exact)).toBe(exact)
  })

  it('truncates long results keeping head and tail', () => {
    const long = 'x'.repeat(MAX_TOOL_RESULT_BYTES + 1000)
    const result = truncateToolResult(long)
    expect(result.length).toBeLessThan(long.length)
    expect(result).toContain('truncated')
  })
})
