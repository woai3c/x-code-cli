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

  it('treats nested headings as part of a fact until a same-level boundary', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryStore(root)
    await store.initialize()
    await writeTopic(
      root,
      topicMarkdown({
        id: 'product',
        type: 'portfolio',
        facts: [
          {
            id: 'portfolio.x-code.stack',
            content: '- VALUE_OLD\n\n### Nested details\n\n- NESTED_VALUE_OLD',
          },
        ],
      }),
      'product',
    )
    const topic = (await store.load()).topics[0]!
    expect(topic.facts[0]?.content).toContain('NESTED_VALUE_OLD')

    await store.applyOperations([
      {
        action: 'upsert',
        topicId: 'product',
        factId: 'portfolio.x-code.stack',
        expectedTopicHash: topic.hash,
        content: '- VALUE_NEW',
        evidence: [{ kind: 'explicit', sourceId: 'session', occurredAt: '2026-08-04T00:00:00.000Z' }],
      },
    ])

    const written = await fs.readFile(path.join(root, 'topics', 'product.md'), 'utf-8')
    expect(written).toContain('VALUE_NEW')
    expect(written).not.toContain('VALUE_OLD')
    expect(written).not.toContain('NESTED_VALUE_OLD')
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
            content: '- VALUE_NEWER',
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
        content: '- VALUE_OLDER',
        evidence: [{ kind: 'explicit', sourceId: 'old-session', occurredAt: '2026-08-02T00:00:00.000Z' }],
      },
    ])
    expect(result.status).toBe('warning')
    expect(await fs.readFile(topic.path, 'utf-8')).toContain('VALUE_NEWER')
    await fs.rm(root, { recursive: true, force: true })
  })

  it('protects explicit facts without relying on predicate vocabulary', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryStore(root)
    await store.initialize()
    await writeTopic(
      root,
      topicMarkdown({
        id: 'profile',
        type: 'reference',
        facts: [{ id: 'custom.slot', content: '- VALUE_EXPLICIT', observedAt: '2026-08-02T00:00:00.000Z' }],
      }),
      'profile',
    )
    const topic = (await store.load()).topics[0]!

    const result = await store.applyOperations([
      {
        action: 'upsert',
        topicId: 'profile',
        factId: 'custom.slot',
        expectedTopicHash: topic.hash,
        content: '- VALUE_VALIDATED',
        evidence: [{ kind: 'validated', sourceId: 'test-run', occurredAt: '2026-08-04T00:00:00.000Z' }],
      },
    ])

    expect(result.status).toBe('warning')
    expect(await fs.readFile(topic.path, 'utf-8')).toContain('VALUE_EXPLICIT')
    await fs.rm(root, { recursive: true, force: true })
  })

  it('reuses an existing fact ID when the structural subject and predicate match', async () => {
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
        factId: 'x-code.stack',
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

  it('reserves quarantined topic IDs so automatic writes cannot replace invalid files', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryStore(root)
    await store.initialize()
    const invalid = topicMarkdown({
      id: 'profile',
      type: 'user',
      facts: [{ id: 'user.language', content: '- VALUE_A' }],
    }).replace('status: active', 'status: invalid')
    await writeTopic(root, invalid, 'Profile')

    const result = await store.applyOperations([
      {
        action: 'upsert',
        topicId: 'profile',
        factId: 'user.language',
        content: '- VALUE_B',
        evidence: [{ kind: 'explicit', sourceId: 'session', occurredAt: '2026-08-04T00:00:00.000Z' }],
        topicPatch: {
          type: 'user',
          description: 'User preferences',
          addAliases: ['user-profile'],
          addKeywords: ['language'],
        },
      },
    ])

    expect(result.status).toBe('warning')
    expect(await fs.readFile(path.join(root, 'topics', 'Profile.md'), 'utf-8')).toBe(invalid)
    expect(await fs.readdir(path.join(root, 'topics'))).toEqual(['Profile.md'])
    await fs.rm(root, { recursive: true, force: true })
  })

  it('rejects evidence timestamps and sources forged beyond the durable job boundary', async () => {
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
            content: '- VALUE_BOUND',
            observedAt: '2026-08-03T00:00:00.000Z',
          },
        ],
      }),
      'profile',
    )
    const topic = (await store.load()).topics[0]!

    const result = await store.applyOperations(
      [
        {
          action: 'upsert',
          topicId: 'profile',
          factId: 'user.language',
          expectedTopicHash: topic.hash,
          content: '- VALUE_FORGED',
          evidence: [{ kind: 'explicit', sourceId: 'forged', occurredAt: '2099-01-01T00:00:00.000Z' }],
        },
      ],
      { jobId: 'job-evidence', sourceOccurredAt: '2026-08-02T00:00:00.000Z' },
    )

    expect(result.status).toBe('warning')
    expect(await fs.readFile(topic.path, 'utf-8')).toContain('VALUE_BOUND')
    await fs.rm(root, { recursive: true, force: true })
  })

  it('commits each durable job at most once across crash replay', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryStore(root)
    await store.initialize()
    const context = { jobId: 'job-replay', sourceOccurredAt: '2026-08-04T00:00:00.000Z' }
    const evidence = [
      {
        kind: 'explicit' as const,
        sourceId: 'memory-job:job-replay:explicit',
        occurredAt: context.sourceOccurredAt,
      },
    ]

    const first = await store.applyOperations(
      [
        {
          action: 'upsert',
          topicId: 'product',
          factId: 'portfolio.x-code.stack',
          content: '- Stack is TypeScript.',
          evidence,
          topicPatch: {
            type: 'portfolio',
            description: 'Product stack',
            addAliases: ['x-code'],
            addKeywords: ['stack'],
          },
        },
      ],
      context,
    )
    const replay = await store.applyOperations(
      [
        {
          action: 'upsert',
          topicId: 'product',
          factId: 'portfolio.x-code.stack',
          content: '- Stack is Rust.',
          evidence,
        },
      ],
      context,
    )

    expect(first.status).toBe('success')
    expect(replay).toMatchObject({ status: 'no-op', generation: first.generation })
    expect(await fs.readFile(path.join(root, 'topics', 'product.md'), 'utf-8')).toContain('Stack is TypeScript')
    await fs.rm(root, { recursive: true, force: true })
  })

  it('does not mark a fully rejected durable job as applied', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryStore(root)
    await store.initialize()
    const context = { jobId: 'job-rejected', sourceOccurredAt: '2026-08-04T00:00:00.000Z' }

    const result = await store.applyOperations(
      [
        {
          action: 'upsert',
          topicId: 'product',
          factId: 'product:x-code:stack',
          content: '- Stack is TypeScript.',
          evidence: [
            {
              kind: 'explicit',
              sourceId: 'memory-job:job-rejected:explicit',
              occurredAt: context.sourceOccurredAt,
            },
          ],
          topicPatch: {
            type: 'portfolio',
            description: 'Product stack',
            addAliases: ['x-code'],
            addKeywords: ['stack'],
          },
        },
      ],
      context,
    )

    expect(result.status).toBe('warning')
    await expect(fs.access(path.join(root, '.state', 'jobs', 'applied', 'job-rejected.json'))).rejects.toThrow()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('redacts secrets again at the final persistence boundary', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryStore(root)
    await store.initialize()
    const secret = 'github_pat_abcdefghijklmnopqrstuv'

    await store.applyOperations([
      {
        action: 'upsert',
        topicId: 'reference',
        factId: 'reference.example.token',
        content: `- Never persist ${secret}.`,
        evidence: [{ kind: 'explicit', sourceId: 'session', occurredAt: '2026-08-04T00:00:00.000Z' }],
        topicPatch: {
          type: 'reference',
          description: 'A redaction regression topic',
          addAliases: ['redaction'],
          addKeywords: ['secret'],
        },
      },
    ])

    const written = await fs.readFile(path.join(root, 'topics', 'reference.md'), 'utf-8')
    expect(written).not.toContain(secret)
    expect(written).toContain('[REDACTED_GITHUB_TOKEN]')
    await fs.rm(root, { recursive: true, force: true })
  })
})
