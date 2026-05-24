// Tests for utils/shell-error.ts
import { describe, expect, it } from 'vitest'

import { foldShellErrorNoise } from '../src/utils/shell-error.js'

const PS_ERROR_SAMPLE = `At line:1 char:24
+ "powershell -Command \\"cd 'd:\\isoform\\something'; git status\\""
+                        ~~
The string is missing the terminator: ".
    + CategoryInfo          : ParserError: (:) [], ParseException
    + FullyQualifiedErrorId : TerminatorExpectedAtEndOfString`

describe('foldShellErrorNoise', () => {
  it('folds a full PS error block into a single line', () => {
    const out = foldShellErrorNoise(PS_ERROR_SAMPLE)
    const lines = out.split('\n').filter((l) => l.trim())
    expect(lines.length).toBeLessThanOrEqual(2)
    expect(out).toContain('At line:1 char:24')
    expect(out).toContain('PS parse error')
    expect(out).not.toContain('CategoryInfo')
    expect(out).not.toContain('FullyQualifiedErrorId')
  })

  it('folds multiple consecutive blocks', () => {
    const input = `${PS_ERROR_SAMPLE}\n${PS_ERROR_SAMPLE}`
    const out = foldShellErrorNoise(input)
    const atLineCount = (out.match(/At line:/g) ?? []).length
    expect(atLineCount).toBe(2)
    expect(out).not.toContain('CategoryInfo')
  })

  it('preserves non-error lines interleaved with blocks', () => {
    const input = `before marker\n${PS_ERROR_SAMPLE}\nafter marker`
    const out = foldShellErrorNoise(input)
    expect(out).toContain('before marker')
    expect(out).toContain('after marker')
    expect(out).toContain('At line:')
    expect(out).not.toContain('CategoryInfo')
  })
})
