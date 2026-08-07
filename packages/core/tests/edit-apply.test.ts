import { describe, expect, it } from 'vitest'

import {
  MAX_BATCH_EDITS,
  MAX_BATCH_INPUT_BYTES,
  MAX_BATCH_SCAN_BYTES,
  applyBatchEdits,
  normalizeEditInput,
} from '../src/tools/edit-apply.js'
import { edit } from '../src/tools/edit.js'

describe('normalizeEditInput', () => {
  it('keeps the public schema lenient for array, JSON string, and legacy inputs', () => {
    const schema = (edit as any).inputSchema
    expect(schema.safeParse({ filePath: '/x', edits: [{ oldString: 'a', newString: 'b' }] }).success).toBe(true)
    expect(schema.safeParse({ filePath: '/x', edits: '[{"oldString":"a","newString":"b"}]' }).success).toBe(true)
    expect(schema.safeParse({ filePath: '/x', oldString: 'a', newString: 'b' }).success).toBe(true)
  })

  it('normalizes legacy and array inputs', () => {
    expect(normalizeEditInput({ filePath: '/x', oldString: 'a', newString: 'b' })).toEqual({
      mode: 'legacy',
      filePath: '/x',
      oldString: 'a',
      newString: 'b',
      replaceAll: false,
    })
    expect(normalizeEditInput({ filePath: '/x', edits: [{ oldString: 'a', newString: 'b' }] })).toEqual({
      mode: 'batch',
      filePath: '/x',
      edits: [{ oldString: 'a', newString: 'b' }],
    })
  })

  it('accepts a JSON-encoded edits array for weak-model compatibility', () => {
    expect(
      normalizeEditInput({ filePath: '/x', edits: JSON.stringify([{ oldString: 'alpha', newString: 'beta' }]) }),
    ).toMatchObject({ mode: 'batch', edits: [{ oldString: 'alpha', newString: 'beta' }] })
  })

  it('rejects mixed, empty, no-op, duplicate, oversized, and malformed inputs', () => {
    expect(() =>
      normalizeEditInput({
        filePath: '/x',
        edits: [{ oldString: 'a', newString: 'b' }],
        oldString: 'a',
        newString: 'b',
      }),
    ).toThrow(/Do not combine/)
    expect(() => normalizeEditInput({ filePath: '/x', oldString: '', newString: 'b' })).toThrow(/must not be empty/)
    expect(() => normalizeEditInput({ filePath: '/x', oldString: 'a', newString: 'a' })).toThrow(/must change/)
    expect(() =>
      normalizeEditInput({
        filePath: '/x',
        edits: [
          { oldString: 'a', newString: 'b' },
          { oldString: 'a', newString: 'c' },
        ],
      }),
    ).toThrow(/duplicates/)
    expect(() =>
      normalizeEditInput({
        filePath: '/x',
        edits: Array.from({ length: MAX_BATCH_EDITS + 1 }, (_, index) => ({
          oldString: `old-${index}`,
          newString: `new-${index}`,
        })),
      }),
    ).toThrow(/replacement limit/)
    expect(() =>
      normalizeEditInput({
        filePath: '/x',
        edits: [{ oldString: 'a'.repeat(MAX_BATCH_INPUT_BYTES), newString: 'b' }],
      }),
    ).toThrow(/input limit/)
    expect(() => normalizeEditInput({ filePath: '/x', edits: 'not-json' })).toThrow(/JSON-encoded array/)
  })
})

describe('applyBatchEdits', () => {
  it('applies independent replacements against the original content', () => {
    expect(
      applyBatchEdits('alpha beta gamma', [
        { oldString: 'alpha', newString: 'beta' },
        { oldString: 'beta', newString: 'delta' },
        { oldString: 'gamma', newString: '你好' },
      ]),
    ).toBe('beta delta 你好')
  })

  it('rejects missing, non-unique, overlapping, nested, and duplicate matches', () => {
    expect(() => applyBatchEdits('alpha', [{ oldString: 'missing', newString: 'x' }])).toThrow(/not found/)
    expect(() => applyBatchEdits('a a', [{ oldString: 'a', newString: 'b' }])).toThrow(/not unique/)
    expect(() =>
      applyBatchEdits('abcdef', [
        { oldString: 'abcd', newString: 'x' },
        { oldString: 'cdef', newString: 'y' },
      ]),
    ).toThrow(/overlaps/)
    expect(() =>
      applyBatchEdits('abcdef', [
        { oldString: 'abcdef', newString: 'x' },
        { oldString: 'bcd', newString: 'y' },
      ]),
    ).toThrow(/overlaps/)
    expect(() =>
      applyBatchEdits('abc', [
        { oldString: 'a', newString: 'x' },
        { oldString: 'a', newString: 'y' },
      ]),
    ).toThrow(/duplicates/)
  })

  it('preserves exact CRLF and no-final-newline content outside replacements', () => {
    expect(
      applyBatchEdits('第一行\r\nsecond\r\nlast', [
        { oldString: '第一行\r\n', newString: '首行\r\n' },
        { oldString: 'last', newString: 'tail' },
      ]),
    ).toBe('首行\r\nsecond\r\ntail')
  })

  it('rejects work beyond the synchronous scan budget', () => {
    const content = 'x'.repeat(Math.floor(MAX_BATCH_SCAN_BYTES / 64) + 1)
    expect(() =>
      applyBatchEdits(
        content,
        Array.from({ length: 64 }, (_, index) => ({ oldString: `old-${index}`, newString: `new-${index}` })),
      ),
    ).toThrow(/work limit/)
  })
})
