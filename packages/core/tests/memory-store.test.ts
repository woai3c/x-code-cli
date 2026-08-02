import fs from 'node:fs/promises'
import path from 'node:path'

import { MemoryStore, formatMemoryTopic, parseMemoryTopic } from '../src/knowledge/memory-store.js'
import { makeMemoryRoot, topicMarkdown, writeTopic } from './memory-test-helpers.js'

describe('MemoryStore', () => {
  it('round-trips frontmatter, fact markers, and manual text', async () => {
    const root = await makeMemoryRoot()
    const filePath = path.join(root, 'topics', 'product.md')
    const raw = topicMarkdown({
      id: 'product',
      type: 'portfolio',
      aliases: ['x-code'],
      keywords: ['TypeScript'],
      manual: 'Human-authored note that the writer must preserve.',
      facts: [{ id: 'portfolio.x-code.stack', content: '- Stack is TypeScript.' }],
    })
    const parsed = parseMemoryTopic(raw, filePath)
    const again = parseMemoryTopic(formatMemoryTopic(parsed), filePath)
    expect(again.facts[0]?.metadata.id).toBe('portfolio.x-code.stack')
    expect(again.body).toContain('Human-authored note')
    await fs.rm(root, { recursive: true, force: true })
  })

  it('physically replaces a conflicting fact and removes every old value', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryStore(root)
    await store.initialize()
    await writeTopic(
      root,
      topicMarkdown({
        id: 'product',
        type: 'portfolio',
        aliases: ['x-code'],
        keywords: ['stack'],
        facts: [{ id: 'portfolio.x-code.stack', content: '- Stack is JavaScript.' }],
      }),
      'product',
    )
    const loaded = await store.load()
    const topic = loaded.topics[0]!
    const result = await store.applyOperations([
      {
        action: 'upsert',
        topicId: 'product',
        factId: 'portfolio.x-code.stack',
        expectedTopicHash: topic.hash,
        content: '- Stack is TypeScript.',
        evidence: [{ kind: 'explicit', sourceId: 'session:2', occurredAt: '2026-08-03T00:00:00.000Z' }],
      },
    ])
    expect(result.status).toBe('success')
    const written = await fs.readFile(path.join(root, 'topics', 'product.md'), 'utf-8')
    expect(written).toContain('Stack is TypeScript')
    expect(written).not.toContain('Stack is JavaScript')
    expect(written.match(/portfolio\.x-code\.stack/g)).toHaveLength(1)
    expect((await store.load()).generation).toBe(1)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('rejects a delayed job instead of overwriting newer evidence', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryStore(root)
    await store.initialize()
    await writeTopic(
      root,
      topicMarkdown({
        id: 'profile',
        type: 'user',
        facts: [
          {
            id: 'user.language',
            content: '- Reply in Chinese.',
            observedAt: '2026-08-03T00:00:00.000Z',
          },
        ],
      }),
      'profile',
    )
    const topic = (await store.load()).topics[0]!
    const result = await store.applyOperations([
      {
        action: 'upsert',
        topicId: 'profile',
        factId: 'user.language',
        expectedTopicHash: topic.hash,
        content: '- Reply in English.',
        evidence: [{ kind: 'explicit', sourceId: 'old-session', occurredAt: '2026-08-02T00:00:00.000Z' }],
      },
    ])
    expect(result.status).toBe('warning')
    expect(await fs.readFile(topic.path, 'utf-8')).toContain('Reply in Chinese')
    await fs.rm(root, { recursive: true, force: true })
  })

  it('normalizes a unique subject/predicate slot to the existing fact ID', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryStore(root)
    await store.initialize()
    await writeTopic(
      root,
      topicMarkdown({
        id: 'product',
        type: 'portfolio',
        facts: [{ id: 'portfolio.x-code.stack', content: '- Stack is TypeScript.' }],
      }),
      'product',
    )
    const topic = (await store.load()).topics[0]!
    await store.applyOperations([
      {
        action: 'upsert',
        topicId: 'product',
        factId: 'portfolio.x-code.tech-stack',
        expectedTopicHash: topic.hash,
        content: '- Stack is Rust.',
        evidence: [{ kind: 'explicit', sourceId: 'new-session', occurredAt: '2026-08-04T00:00:00.000Z' }],
      },
    ])
    const reloaded = (await store.load()).topics[0]!
    expect(reloaded.facts.map((fact) => fact.metadata.id)).toEqual(['portfolio.x-code.stack'])
    expect(reloaded.facts[0]?.content).toContain('Rust')
    await fs.rm(root, { recursive: true, force: true })
  })

  it('moves a replaced fact across topics and deletes the empty old topic', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryStore(root)
    await store.initialize()
    await writeTopic(
      root,
      topicMarkdown({
        id: 'old-product',
        type: 'portfolio',
        facts: [{ id: 'portfolio.x-code.owner', content: '- x-code belongs to the old owner.' }],
      }),
      'old-product',
    )
    const oldTopic = (await store.load()).topics[0]!
    const result = await store.applyOperations([
      {
        action: 'replace-conflict',
        topicId: 'product-portfolio',
        factId: 'portfolio.x-code.owner',
        content: '- The user owns x-code.',
        remove: [
          {
            topicId: oldTopic.metadata.id,
            factId: 'portfolio.x-code.owner',
            expectedTopicHash: oldTopic.hash,
          },
        ],
        evidence: [{ kind: 'explicit', sourceId: 'new-session', occurredAt: '2026-08-04T00:00:00.000Z' }],
        reason: 'The user corrected the product ownership.',
        topicPatch: {
          type: 'portfolio',
          description: 'Products owned by the user',
          addAliases: ['x-code'],
          addKeywords: ['ownership'],
        },
      },
    ])

    expect(result.status).toBe('success')
    await expect(fs.access(path.join(root, 'topics', 'old-product.md'))).rejects.toThrow()
    const replacement = await fs.readFile(path.join(root, 'topics', 'product-portfolio.md'), 'utf-8')
    expect(replacement).toContain('The user owns x-code')
    expect(replacement).not.toContain('old owner')
    await fs.rm(root, { recursive: true, force: true })
  })

  it('leaves unrelated manually formatted topic files byte-identical', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryStore(root)
    await store.initialize()
    const untouched = topicMarkdown({
      id: 'manual-notes',
      type: 'reference',
      manual: 'Keep this  manual spacing.  ',
      facts: [{ id: 'reference.docs.url', content: '- Docs live at https://example.test.' }],
    }).replace('\n\n## Facts', '\n\n\n\n## Facts')
    await writeTopic(root, untouched, 'manual-notes')

    await store.applyOperations([
      {
        action: 'upsert',
        topicId: 'product',
        factId: 'portfolio.x-code.stack',
        content: '- Stack is TypeScript.',
        evidence: [{ kind: 'explicit', sourceId: 'session', occurredAt: '2026-08-04T00:00:00.000Z' }],
        topicPatch: {
          type: 'portfolio',
          description: 'Product stack',
          addAliases: ['x-code'],
          addKeywords: ['stack'],
        },
      },
    ])

    expect(await fs.readFile(path.join(root, 'topics', 'manual-notes.md'), 'utf-8')).toBe(untouched)
    await fs.rm(root, { recursive: true, force: true })
  })
})
