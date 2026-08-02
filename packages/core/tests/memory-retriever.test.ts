import path from 'node:path'

import { MemoryIndex } from '../src/knowledge/memory-index.js'
import { MemoryRetriever } from '../src/knowledge/memory-retriever.js'
import { parseMemoryTopic } from '../src/knowledge/memory-store.js'
import type { RecallQuery } from '../src/knowledge/memory-types.js'
import { topicMarkdown } from './memory-test-helpers.js'

function query(text: string, history = false): RecallQuery {
  return {
    currentUserText: text,
    recentConversationText: '',
    repositoryId: 'D:/res/x-code-cli',
    mentionedPaths: [],
    identifiers: [],
    explicitHistoryIntent: history,
    explicitForgetIntent: false,
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
    const result = retriever.retrieve(query('之前的工作流程怎么做', true))
    expect(result.needsSelector).toBe(true)
  })

  it('packs only selected topic sections within the token budget', () => {
    const attachment = retriever.pack(query('x-code-cli TypeScript'), ['product-portfolio'], 4)
    expect(attachment?.topics).toHaveLength(1)
    expect(attachment?.topics[0]?.renderedContent).toContain('TypeScript')
    expect(attachment?.estimatedTokens).toBeLessThanOrEqual(4000)
  })
})
