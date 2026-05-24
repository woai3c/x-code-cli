// Tests for tools/truncate.ts
import { describe, expect, it } from 'vitest'

import { MAX_TOOL_RESULT_BYTES, MAX_TOOL_RESULT_LINES, truncateToolResult } from '../src/tools/truncate.js'

describe('truncateToolResult', () => {
  describe('under-budget passthrough', () => {
    it('returns short ASCII string unchanged', () => {
      expect(truncateToolResult('hello world')).toBe('hello world')
    })

    it('returns exact byte-limit ASCII unchanged', () => {
      const exact = 'x'.repeat(MAX_TOOL_RESULT_BYTES)
      expect(truncateToolResult(exact)).toBe(exact)
    })

    it('returns exact line limit unchanged', () => {
      const lines = Array.from({ length: MAX_TOOL_RESULT_LINES }, (_, i) => `line ${i}`).join('\n')
      expect(truncateToolResult(lines)).toBe(lines)
    })
  })

  describe('byte-budget truncation', () => {
    it('truncates ASCII over byte budget', () => {
      const long = 'x'.repeat(MAX_TOOL_RESULT_BYTES + 5000)
      const out = truncateToolResult(long)
      expect(out.length).toBeLessThan(long.length)
      expect(out).toMatch(/truncated/)
    })

    it('head-tail mode keeps start and end', () => {
      const long = 'A'.repeat(100) + 'M'.repeat(MAX_TOOL_RESULT_BYTES) + 'Z'.repeat(100)
      const out = truncateToolResult(long, { direction: 'head-tail' })
      expect(out.startsWith('AAAA')).toBe(true)
      expect(out.endsWith('ZZZZ')).toBe(true)
    })

    it('head mode keeps start only', () => {
      const long = 'A'.repeat(100) + 'Z'.repeat(MAX_TOOL_RESULT_BYTES)
      const out = truncateToolResult(long, { direction: 'head', maxBytes: 1000 })
      expect(out.startsWith('AAAA')).toBe(true)
      expect(out.length).toBeLessThan(long.length)
    })

    it('tail mode keeps end only', () => {
      const long = 'A'.repeat(MAX_TOOL_RESULT_BYTES) + 'Z'.repeat(100)
      const out = truncateToolResult(long, { direction: 'tail', maxBytes: 1000 })
      expect(out.endsWith('ZZZZ')).toBe(true)
      expect(out.length).toBeLessThan(long.length)
    })

    it('truncates non-ASCII (CJK) content to the byte budget', () => {
      // 20k CJK chars ≈ 60 kB UTF-8, over the 50 kB default
      const cjk = '你好世界'.repeat(5000)
      const out = truncateToolResult(cjk)
      expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES + 500)
    })
  })

  describe('line-budget truncation', () => {
    it('truncates when line count exceeds', () => {
      const lines = Array.from({ length: MAX_TOOL_RESULT_LINES + 500 }, (_, i) => `line-${i}`).join('\n')
      const out = truncateToolResult(lines)
      expect(out.split('\n').length).toBeLessThan(lines.split('\n').length)
      expect(out).toMatch(/lines/)
    })

    it('head-tail keeps both file start and file end', () => {
      const lines = Array.from({ length: MAX_TOOL_RESULT_LINES + 500 }, (_, i) => `line-${i}`).join('\n')
      const out = truncateToolResult(lines, { direction: 'head-tail' })
      expect(out).toContain('line-0')
      expect(out).toContain('line-' + (MAX_TOOL_RESULT_LINES + 499))
    })

    it('head mode drops the tail', () => {
      const lines = Array.from({ length: 5000 }, (_, i) => `line-${i}`).join('\n')
      const out = truncateToolResult(lines, { direction: 'head', maxLines: 100 })
      expect(out).toContain('line-0')
      expect(out).not.toContain('line-4999')
    })
  })

  describe('marker format', () => {
    it('line-drop marker mentions line count', () => {
      const lines = Array.from({ length: MAX_TOOL_RESULT_LINES + 10 }, (_, i) => `x${i}`).join('\n')
      const out = truncateToolResult(lines)
      expect(out).toMatch(/\d+ lines/)
    })

    it('byte-only drop marker does not mention lines', () => {
      const long = 'x'.repeat(MAX_TOOL_RESULT_BYTES + 1000)
      const out = truncateToolResult(long)
      expect(out).not.toMatch(/lines/)
    })
  })
})
