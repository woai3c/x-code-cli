import path from 'node:path'

import { MemoryIndex } from '../src/knowledge/memory-index.js'
import { MemoryRetriever } from '../src/knowledge/memory-retriever.js'
import { parseMemoryTopic } from '../src/knowledge/memory-store.js'
import type { RecallQuery } from '../src/knowledge/memory-types.js'
import { topicMarkdown } from './memory-test-helpers.js'

function query(text: string): RecallQuery {
  return {
    currentUserText: text,
    recentConversationText: '',
    repositoryId: 'D:/res/x-code-cli',
    mentionedPaths: [],
    identifiers: [],
  }
}

describe('MemoryRetriever', () => {
  const product = parseMemoryTopic(
    topicMarkdown({
      id: 'product-portfolio',
      type: 'portfolio',
      aliases: ['x-code-cli'],
      keywords: ['coding agent', 'TypeScript'],
      appliesTo: ['D:/res/x-code-cli'],
      facts: [{ id: 'portfolio.x-code.stack', content: '- x-code-cli uses TypeScript.' }],
    }),
    path.join('C:/memory/topics', 'product-portfolio.md'),
  )
  const workflow = parseMemoryTopic(
    topicMarkdown({
      id: 'workflow',
      type: 'workflow',
      keywords: ['tests', 'build'],
      facts: [{ id: 'workflow.verify', content: '- Run typecheck and build after core edits.' }],
    }),
    path.join('C:/memory/topics', 'workflow.md'),
  )
  const index = new MemoryIndex()
  index.rebuild([product, workflow], 2)
  const retriever = new MemoryRetriever(index, {
    maxTopicsPerTurn: 5,
    maxTokensPerTopic: 1500,
    maxTokensPerTurn: 4000,
  })

  it('directly selects one protected exact alias and applies repository boost', () => {
    const result = retriever.retrieve(query('x-code-cli 的技术栈是什么'))
    expect(result.selectedTopicIds).toEqual(['product-portfolio'])
    expect(result.needsSelector).toBe(false)
    expect(result.candidates[0]?.score).toBeGreaterThan(0.2)
  })

  it('asks for semantic selection on an ambiguous history query', () => {
    const result = retriever.retrieve(query('build 工作流程怎么做'))
    expect(result.needsSelector).toBe(true)
  })

  it('packs only selected topic sections within the token budget', () => {
    const attachment = retriever.pack(query('x-code-cli TypeScript'), ['product-portfolio'], 4)
    expect(attachment?.topics).toHaveLength(1)
    expect(attachment?.topics[0]?.renderedContent).toContain('TypeScript')
    expect(attachment?.estimatedTokens).toBeLessThanOrEqual(4000)
  })

  it('skips oversized sections instead of slicing memory at an unsafe boundary', () => {
    const oversized = parseMemoryTopic(
      topicMarkdown({
        id: 'oversized',
        type: 'reference',
        aliases: ['oversized-ref'],
        facts: [{ id: 'reference.oversized.body', content: Array.from({ length: 205 }, () => '- needle').join('\n') }],
      }),
      path.join('C:/memory/topics', 'oversized.md'),
    )
    const largeIndex = new MemoryIndex()
    largeIndex.rebuild([oversized], 1)
    const largeRetriever = new MemoryRetriever(largeIndex, {
      maxTopicsPerTurn: 1,
      maxTokensPerTopic: 10_000,
      maxTokensPerTurn: 20_000,
    })

    expect(largeRetriever.pack(query('oversized-ref needle'), ['oversized'], 0)).toBeNull()
  })

  it('recalls protected manual prose before the first H2 section', () => {
    const manual = parseMemoryTopic(
      topicMarkdown({
        id: 'manual-notes',
        type: 'reference',
        aliases: ['manual-note'],
        keywords: ['codename'],
        manual: 'The durable launch codename is Aurora.',
      }),
      path.join('C:/memory/topics', 'manual-notes.md'),
    )
    const manualIndex = new MemoryIndex()
    manualIndex.rebuild([manual], 1)
    const manualRetriever = new MemoryRetriever(manualIndex, {
      maxTopicsPerTurn: 1,
      maxTokensPerTopic: 1500,
      maxTokensPerTurn: 4000,
    })

    const attachment = manualRetriever.pack(query('manual-note codename'), ['manual-notes'], 0)
    expect(attachment?.topics[0]?.renderedContent).toContain('launch codename is Aurora')
    expect(attachment?.topics[0]?.factIds).toEqual([])
  })
})
