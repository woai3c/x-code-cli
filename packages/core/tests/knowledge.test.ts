import fs from 'node:fs/promises'
import path from 'node:path'

import { createLoopState } from '../src/agent/loop-state.js'
import { MemoryService } from '../src/knowledge/memory-service.js'
import { makeMemoryRoot, memoryConfig, topicMarkdown, writeTopic } from './memory-test-helpers.js'

describe('Memory v2 knowledge source', () => {
  it('initializes an empty v2 store without reading legacy auto.md', async () => {
    const root = await makeMemoryRoot()
    await fs.writeFile(path.join(root, 'auto.md'), 'legacy content that must be ignored', 'utf-8')
    const service = new MemoryService({ memoryRoot: root, config: memoryConfig })
    await service.initialize(process.cwd())

    expect(service.getCoreProfile()).not.toContain('legacy content')
    expect(JSON.parse(await fs.readFile(path.join(root, '.state', 'schema.json'), 'utf-8'))).toEqual({
      version: 2,
      generation: 0,
    })
    const status = await service.status()
    expect(status).not.toHaveProperty('enabled')
    expect(status).toMatchObject({ initialized: true, schemaVersion: 2 })
    expect(['idle', 'running']).toContain(status.worker)
    expect(await fs.readFile(path.join(root, 'auto.md'), 'utf-8')).toContain('legacy content')
    await service.shutdown(0)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('reloads manual topic edits and isolates a topic as soon as it becomes invalid', async () => {
    const root = await makeMemoryRoot()
    const service = new MemoryService({ memoryRoot: root, config: memoryConfig })
    await service.initialize(process.cwd())
    await writeTopic(
      root,
      topicMarkdown({
        id: 'profile',
        type: 'user',
        aliases: ['user-profile'],
        keywords: ['language'],
        facts: [{ id: 'user.language', content: '- OPAQUE_PROFILE_VALUE' }],
      }),
      'profile',
    )
    const topicPath = path.join(root, 'topics', 'profile.md')

    await service.reload()
    expect(service.listTopics().map((topic) => topic.id)).toEqual(['profile'])
    const freshState = createLoopState()
    freshState.messages.push({ role: 'user', content: 'user-profile language' })
    await service.recall(
      {
        currentUserText: 'user-profile language',
        recentConversationText: '',
        repositoryId: process.cwd(),
        mentionedPaths: [],
        identifiers: [],
      },
      freshState,
    )
    expect(freshState.memoryRecallAttachments).toHaveLength(1)
    expect(freshState.memoryRecallTombstones).toEqual([])

    const valid = await fs.readFile(topicPath, 'utf-8')
    await fs.writeFile(topicPath, valid.replace('status: active', 'status: broken'), 'utf-8')
    await service.reload()

    expect(service.listTopics()).toEqual([])
    expect((await service.status()).invalidTopics[0]?.path).toBe(topicPath)
    expect(await service.search({ query: 'user-profile language' }, { repositoryId: process.cwd() })).toEqual([])
    await service.shutdown(0)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('invalidates resumed attachments when the memory store generation moved backwards', async () => {
    const root = await makeMemoryRoot()
    const service = new MemoryService({ memoryRoot: root, config: memoryConfig })
    await service.initialize(process.cwd())
    const state = createLoopState()
    state.memoryGeneration = 7
    state.messages.push({ role: 'user', content: 'What was my preference?' })
    state.memoryRecallAttachments.push({
      attachmentId: 'old-memory',
      anchorMessageIndex: 0,
      placement: 'before-user',
      estimatedTokens: 10,
      topics: [
        {
          topicId: 'profile',
          topicHash: 'old-topic-hash',
          factIds: ['user.language'],
          factHashes: { 'user.language': 'old-fact-hash' },
          path: 'topics/profile.md',
          renderedContent: 'OPAQUE_RECALLED_VALUE',
        },
      ],
    })

    await service.recall(
      {
        currentUserText: 'What was my preference?',
        recentConversationText: '',
        repositoryId: process.cwd(),
        mentionedPaths: [],
        identifiers: [],
      },
      state,
    )

    expect(state.memoryRecallTombstones.at(-1)).toEqual({
      generation: 0,
      factIds: ['user.language'],
      topicIds: ['profile'],
    })
    expect(state.memoryGeneration).toBe(0)
    expect(state.expectCacheMiss).toBe(true)
    await service.shutdown(0)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('commits manual-only edits and tombstones their previously recalled topic content', async () => {
    const root = await makeMemoryRoot()
    await writeTopic(
      root,
      topicMarkdown({
        id: 'manual-notes',
        type: 'reference',
        aliases: ['manual-note'],
        keywords: ['codename'],
        manual: 'The durable launch codename is Aurora.',
      }),
      'manual-notes',
    )
    const service = new MemoryService({ memoryRoot: root, config: memoryConfig })
    await service.initialize(process.cwd())
    const state = createLoopState()
    state.messages.push({ role: 'user', content: 'What is the manual-note codename?' })
    await service.recall(
      {
        currentUserText: 'What is the manual-note codename?',
        recentConversationText: '',
        repositoryId: process.cwd(),
        mentionedPaths: [],
        identifiers: [],
      },
      state,
    )
    expect(state.memoryRecallAttachments[0]?.topics[0]?.factIds).toEqual([])

    const topicPath = path.join(root, 'topics', 'manual-notes.md')
    const beforeGeneration = state.memoryGeneration
    await fs.writeFile(topicPath, (await fs.readFile(topicPath, 'utf-8')).replace('Aurora', 'Borealis'), 'utf-8')
    await service.reload(state)

    expect(state.memoryGeneration).toBe(beforeGeneration + 1)
    expect(state.memoryRecallTombstones.at(-1)?.topicIds).toEqual(['manual-notes'])
    await service.shutdown(0)
    await fs.rm(root, { recursive: true, force: true })
  })
})
