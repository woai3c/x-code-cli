import { describe, expect, it } from 'vitest'

import { findSafeBoundary, hasOpenCodeFence, hasOpenMarkdownBlock } from '../src/ui/agent/use-stream-buffer.js'

describe('stream buffer markdown boundaries', () => {
  it('holds a long markdown table instead of treating it as a splittable code fence', () => {
    const rows = Array.from({ length: 40 }, (_, index) => `| ${index + 1} | row ${index + 1} | value |`).join('\n')
    const table = `| id | name | value |\n| --- | --- | --- |\n${rows}\n`

    expect(hasOpenMarkdownBlock(table)).toBe(true)
    expect(hasOpenCodeFence(table)).toBe(false)
    expect(findSafeBoundary(table)).toBe(-1)
  })

  it('still identifies a long open code fence for incremental commits', () => {
    const code = `\`\`\`text\n${'line of code\n'.repeat(100)}`

    expect(hasOpenCodeFence(code)).toBe(true)
  })
})
