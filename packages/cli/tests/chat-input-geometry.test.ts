import { describe, expect, it } from 'vitest'

import { computePostContentScrollRows } from '../src/ui/components/ChatInput.js'

describe('ChatInput large commit geometry', () => {
  it('reserves the frame rows after content taller than the viewport', () => {
    expect(computePostContentScrollRows(1, 40, 35, 38)).toBe(4)
  })

  it('scrolls only rows overlapping the frame for a long tool summary', () => {
    expect(computePostContentScrollRows(1, 36, 34, 38)).toBe(3)
  })

  it('does not scroll when committed content ends above the frame', () => {
    expect(computePostContentScrollRows(12, 9, 21, 38)).toBe(0)
  })
})
