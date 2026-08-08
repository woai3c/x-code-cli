import path from 'node:path'

import { MemoryRetriever, buildRecallQuery } from '../src/knowledge/memory/retriever.js'
import { MemoryIndex } from '../src/knowledge/memory/search-index.js'
import { parseMemoryTopic } from '../src/knowledge/memory/store.js'
import type { RecallQuery } from '../src/knowledge/memory/types.js'
import { topicMarkdown } from './memory-test-helpers.js'

function query(text: string): RecallQuery {
  return {
    currentUserText: text,
    recentConversationText: '',
    repositoryId: 'D:/res/x-code-cli',
    mentionedPaths: [],
    identifiers: [],
    explicitHistoryIntent: false,
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
    const result = retriever.retrieve(query('x-code-cli'))
    expect(result.selectedTopicIds).toEqual(['product-portfolio'])
    expect(result.needsSelector).toBe(false)
    expect(result.candidates[0]?.score).toBeGreaterThan(0.4)
  })

  it('does not ask for semantic selection for one ordinary weak lexical route', () => {
    const result = retriever.retrieve(query('core'))
    expect(result.needsSelector).toBe(false)
    expect(result.selectedTopicIds).toEqual([])
  })

  it('routes explicit history requests by type and asks the semantic selector', () => {
    const historyQuery = query('What did we decide before about authentication?')
    historyQuery.explicitHistoryIntent = true
    const result = retriever.retrieve(historyQuery)

    expect(result.needsSelector).toBe(true)
    expect(result.candidates.some((candidate) => candidate.routes.includes('type'))).toBe(true)
  })

  it('detects explicit history and forget intent while building queries', () => {
    const history = buildRecallQuery('What did we decide last time?', [], 0, 'D:\\repo')
    const forget = buildRecallQuery('Forget my previous preference', [], 0, 'D:\\repo')

    expect(history).toMatchObject({ explicitHistoryIntent: true, explicitForgetIntent: false })
    expect(forget).toMatchObject({ explicitHistoryIntent: true, explicitForgetIntent: true })
    expect(history.repositoryId).toBe('D:/repo')
  })

  it('does not treat a short alias as a substring of an unrelated word', () => {
    const go = parseMemoryTopic(
      topicMarkdown({
        id: 'go-language',
        type: 'reference',
        aliases: ['go'],
        facts: [{ id: 'reference.go.version', content: '- Go version is 1.25.' }],
      }),
      path.join('C:/memory/topics', 'go-language.md'),
    )
    const goIndex = new MemoryIndex()
    goIndex.rebuild([go], 1)
    const goRetriever = new MemoryRetriever(goIndex, {
      maxTopicsPerTurn: 5,
      maxTokensPerTopic: 1500,
      maxTokensPerTurn: 4000,
    })

    const result = goRetriever.retrieve(query('debug google authentication'))
    expect(result.protectedTopicIds).toEqual([])
    expect(result.selectedTopicIds).toEqual([])
  })

  it('sends ambiguous protected exact matches to the selector', () => {
    const first = parseMemoryTopic(
      topicMarkdown({ id: 'shared-one', type: 'reference', aliases: ['shared-key'], manual: 'First reference.' }),
      path.join('C:/memory/topics', 'shared-one.md'),
    )
    const second = parseMemoryTopic(
      topicMarkdown({ id: 'shared-two', type: 'reference', aliases: ['shared-key'], manual: 'Second reference.' }),
      path.join('C:/memory/topics', 'shared-two.md'),
    )
    const sharedIndex = new MemoryIndex()
    sharedIndex.rebuild([first, second], 1)
    const sharedRetriever = new MemoryRetriever(sharedIndex, {
      maxTopicsPerTurn: 5,
      maxTokensPerTopic: 1500,
      maxTokensPerTurn: 4000,
    })

    const result = sharedRetriever.retrieve(query('shared-key'))
    expect(result.selectedTopicIds).toEqual([])
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
