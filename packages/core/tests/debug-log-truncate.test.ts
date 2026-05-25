// Regression test for src/utils.ts:truncateForLog
//
// Background: prior implementation used `s.slice(0, sliceLen)` to cut the
// string after computing `sliceLen = maxBytes - 64`. That counts UTF-16 code
// units rather than UTF-8 bytes — for CJK / emoji input the returned string
// would routinely exceed maxBytes by ~3-4×, defeating MAX_LINE_BYTES and
// letting individual debug entries blow past the budget. The sub-agent
// `code-reviewer` flagged this during a §3d test pass; this lock-in covers
// the byte-accurate implementation.
import { describe, expect, it } from 'vitest'

import { truncateForLog } from '../src/utils.js'

describe('truncateForLog', () => {
  it('returns ASCII input unchanged when under maxBytes', () => {
    const s = 'hello world'
    expect(truncateForLog(s, 1024)).toBe(s)
  })

  it('returns CJK input unchanged when its byte size fits', () => {
    // 10 chars * 3 bytes = 30 bytes < 1024
    const s = '中文测试一二三四五六'
    expect(truncateForLog(s, 1024)).toBe(s)
  })

  it('truncates ASCII to within maxBytes', () => {
    const s = 'a'.repeat(2000)
    const out = truncateForLog(s, 1024)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(1024)
    expect(out).toMatch(/<\+\d+b truncated>$/)
  })

  it('truncates CJK by BYTES not by JS char index (regression)', () => {
    // 1000 '龙' chars × 3 bytes/char = 3000 UTF-8 bytes total.
    // Old implementation: sliceLen = 1024 - 64 = 960, s.slice(0, 960)
    // returned 960 chars = 2880 bytes — nearly 3× the maxBytes budget.
    // Correct implementation slices the UTF-8 buffer instead.
    const s = '龙'.repeat(1000)
    const out = truncateForLog(s, 1024)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(1024)
    expect(out).toContain('truncated')
  })

  it('truncates emoji input without exceeding maxBytes', () => {
    // 🐉 is 4 bytes in UTF-8 (and 2 UTF-16 code units / surrogate pair).
    // The old slice-by-chars logic miscounted both dimensions.
    const s = '🐉'.repeat(500) // ~2000 UTF-8 bytes
    const out = truncateForLog(s, 512)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(512)
  })

  it('reports dropped bytes in the marker (not char count)', () => {
    // 1000 '龙' = 3000 bytes; sliceLen = 960; dropped = 3000 - 960 = 2040.
    // Marker should reflect bytes ('b' suffix), not the chars ('c') it
    // used to print, since the function's contract is byte-based.
    const s = '龙'.repeat(1000)
    const out = truncateForLog(s, 1024)
    const match = out.match(/<\+(\d+)b truncated>$/)
    expect(match).not.toBeNull()
    const droppedBytes = Number(match![1])
    // Should be approximately 3000 - 960 = 2040. Allow some slack since
    // TextDecoder may discard a partial codepoint at the boundary.
    expect(droppedBytes).toBeGreaterThan(2000)
    expect(droppedBytes).toBeLessThan(2100)
  })
})
