import path from 'node:path'

import {
  MemoryIndex,
  extractMemoryIdentifiers,
  normalizeMemoryText,
  tokenizeMemoryText,
} from '../src/knowledge/memory-index.js'
import { parseMemoryTopic } from '../src/knowledge/memory-store.js'
import { topicMarkdown } from './memory-test-helpers.js'

describe('MemoryIndex', () => {
  it('normalizes Unicode, identifiers, Windows paths, and Chinese n-grams', () => {
    expect(normalizeMemoryText('D:\\Res\\x-code-cli')).toBe('d:/res/x code cli')
    expect(tokenizeMemoryText('MemoryService 用户画像')).toEqual(
      expect.arrayContaining(['memoryservice', 'memory', 'service', '用户', '画像', '用户画像']),
    )
    expect(tokenizeMemoryText('x-code-cli')).toEqual(expect.arrayContaining(['x-code-cli', 'x', 'code', 'cli']))
    expect(extractMemoryIdentifiers('package react failed in @scope/tool with TS2322')).toEqual(
      expect.arrayContaining(['react', '@scope/tool', 'TS2322']),
    )
  })

  it('retrieves aliases and repository paths exactly and ranks lexical content', () => {
    const topic = parseMemoryTopic(
      topicMarkdown({
        id: 'product-portfolio',
        type: 'portfolio',
        aliases: ['x-code-cli'],
        keywords: ['MemoryService', 'TypeScript'],
        appliesTo: ['D:/res/x-code-cli'],
        facts: [{ id: 'portfolio.x-code.stack', content: '- Uses TypeScript and pnpm workspace.' }],
      }),
      path.join('C:/memory/topics', 'product-portfolio.md'),
    )
    const index = new MemoryIndex()
    index.rebuild([topic], 7)

    expect([...index.exactHits('x-code-cli 的技术栈', [], [])].map(([id]) => id)).toEqual(['product-portfolio'])
    expect(index.exactHits('repo', ['D:/res/x-code-cli'], []).has('product-portfolio')).toBe(true)
    expect(index.bm25('TypeScript pnpm')[0]?.topicId).toBe('product-portfolio')
    expect(index.facts.get('portfolio.x-code.stack')?.topicId).toBe('product-portfolio')
  })
})
