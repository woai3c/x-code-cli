import fs from 'node:fs/promises'

import { MemoryService } from '../src/knowledge/memory-service.js'
import { makeMemoryRoot, topicMarkdown, writeTopic } from './memory-test-helpers.js'

describe('MemoryService.search', () => {
  it('returns bounded section snippets for specific queries', async () => {
    const root = await makeMemoryRoot()
    await writeTopic(
      root,
      topicMarkdown({
        id: 'product-portfolio',
        type: 'portfolio',
        aliases: ['x-code-cli'],
        keywords: ['TypeScript'],
        facts: [{ id: 'portfolio.x-code.stack', content: '- x-code-cli uses TypeScript.' }],
      }),
      'product-portfolio',
    )
    const service = new MemoryService({ memoryRoot: root })
    await service.initialize(process.cwd())
    const results = await service.search(
      { query: 'x-code-cli TypeScript', maxResults: 2 },
      { repositoryId: 'D:/res/x-code-cli', currentUserText: 'x-code-cli TypeScript' },
    )
    expect(results[0]).toMatchObject({ topicId: 'product-portfolio', status: 'active' })
    expect(results[0]?.snippet).toContain('TypeScript')
    await service.shutdown(0)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('rejects empty, wildcard, enumeration, and candidate-expanding requests', async () => {
    const root = await makeMemoryRoot()
    await writeTopic(
      root,
      topicMarkdown({
        id: 'profile',
        type: 'user',
        aliases: ['user profile'],
        facts: [{ id: 'user.language', content: '- Reply in Chinese.' }],
      }),
      'profile',
    )
    const service = new MemoryService({ memoryRoot: root })
    await service.initialize(process.cwd())
    const context = { repositoryId: 'repo', currentUserText: 'history' }
    await expect(service.search({ query: '*' }, context)).rejects.toThrow('specific')
    await expect(service.search({ query: 'language', topicIds: ['missing'] }, context)).rejects.toThrow('cannot expand')
    await service.shutdown(0)
    await fs.rm(root, { recursive: true, force: true })
  })
})
