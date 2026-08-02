import fs from 'node:fs/promises'
import path from 'node:path'

import { createLoopState } from '../src/agent/loop-state.js'
import { MemoryService } from '../src/knowledge/memory-service.js'
import { makeMemoryRoot, topicMarkdown, writeTopic } from './memory-test-helpers.js'

describe('Memory v2 knowledge source', () => {
  it('initializes an empty v2 store without reading legacy auto.md', async () => {
    const root = await makeMemoryRoot()
    await fs.writeFile(path.join(root, 'auto.md'), 'legacy content that must be ignored', 'utf-8')
    const service = new MemoryService({ memoryRoot: root })
    await service.initialize(process.cwd())

    expect(service.getCoreProfile()).not.toContain('legacy content')
    expect(JSON.parse(await fs.readFile(path.join(root, '.state', 'schema.json'), 'utf-8'))).toEqual({
      version: 2,
      generation: 0,
    })
    expect(await fs.readFile(path.join(root, 'auto.md'), 'utf-8')).toContain('legacy content')
    await service.shutdown(0)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('reloads manual topic edits and isolates a topic as soon as it becomes invalid', async () => {
    const root = await makeMemoryRoot()
    const service = new MemoryService({ memoryRoot: root })
    await service.initialize(process.cwd())
    await writeTopic(
      root,
      topicMarkdown({
        id: 'profile',
        type: 'user',
        aliases: ['user-profile'],
        keywords: ['language'],
        facts: [{ id: 'user.language', content: '- Reply in Chinese.' }],
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
        explicitHistoryIntent: false,
        explicitForgetIntent: false,
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
    expect(
      await service.search(
        { query: 'user-profile language' },
        { repositoryId: process.cwd(), currentUserText: 'user-profile language', explicitHistoryIntent: true },
      ),
    ).toEqual([])
    await service.shutdown(0)
    await fs.rm(root, { recursive: true, force: true })
  })
})
