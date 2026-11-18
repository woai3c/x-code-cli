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

  it('cuts right before an open table and releases once a blank line closes it', () => {
    const withIntro = 'intro paragraph\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'
    expect(findSafeBoundary(withIntro)).toBe('intro paragraph\n'.length)

    const closedTable = `${withIntro}\n`
    expect(hasOpenMarkdownBlock(closedTable)).toBe(false)
    expect(findSafeBoundary(closedTable)).toBe(closedTable.length)
  })

  it('holds pipes and blank lines inside an open code fence until the closing fence', () => {
    const openFence = '```markdown\n| a | b |\n\nplain line\n'
    expect(findSafeBoundary(openFence)).toBe(-1)

    const closedFence = `${openFence}\`\`\`\n`
    expect(hasOpenCodeFence(closedFence)).toBe(false)
    expect(findSafeBoundary(closedFence)).toBe(closedFence.length)
  })

  it('holds pipe-less GFM tables and blockquoted tables while allowing inline code pipes to flush', () => {
    const pipelessTable = 'intro\n参数 | 说明\n--- | ---\ntimeout | 超时\n'
    expect(hasOpenMarkdownBlock(pipelessTable)).toBe(true)
    expect(findSafeBoundary(pipelessTable)).toBe('intro\n'.length)

    const quotedTable = 'intro\n> | a | b |\n> | --- | --- |\n'
    expect(hasOpenMarkdownBlock(quotedTable)).toBe(true)
    expect(findSafeBoundary(quotedTable)).toBe('intro\n'.length)

    const inlineCodePipe = '请运行 `cat a.txt | wc -l` 查看结果\n'
    expect(hasOpenMarkdownBlock(inlineCodePipe)).toBe(false)
    expect(findSafeBoundary(inlineCodePipe)).toBe(inlineCodePipe.length)

    const logicalOr = '当满足 a || b 条件时自动返回\n'
    expect(hasOpenMarkdownBlock(logicalOr)).toBe(false)
    expect(findSafeBoundary(logicalOr)).toBe(logicalOr.length)
  })
})
