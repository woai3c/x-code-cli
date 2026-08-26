import fs from 'node:fs/promises'

import { streamText } from 'ai'
import type { LanguageModel } from 'ai'

import { createLoopState } from '../src/agent/loop-state.js'
import { MemoryService } from '../src/knowledge/memory/service.js'
import { createMemorySearchTool } from '../src/tools/memory-search.js'
import { makeMemoryRoot, memoryConfig, topicMarkdown, writeTopic } from './memory-test-helpers.js'

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, streamText: vi.fn() }
})

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
    const service = new MemoryService({ memoryRoot: root, config: memoryConfig })
    await service.initialize(process.cwd())
    const results = await service.search(
      { query: 'x-code-cli TypeScript', maxResults: 2 },
      { repositoryId: 'D:/res/x-code-cli' },
    )
    expect(results[0]).toMatchObject({ topicId: 'product-portfolio', status: 'active' })
    expect(results[0]?.snippet).toContain('TypeScript')
    await service.shutdown(0)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('uses the semantic selector across the bounded manifest without lexical routing', async () => {
    const root = await makeMemoryRoot()
    await writeTopic(
      root,
      topicMarkdown({
        id: 'deployment-workflow',
        type: 'workflow',
        description: 'Production deployment checklist',
        aliases: ['release checklist'],
        keywords: ['production', 'deploy'],
        facts: [{ id: 'workflow.deploy.verify', content: '- Run the smoke suite before production deployment.' }],
      }),
      'deployment-workflow',
    )
    vi.mocked(streamText).mockReturnValueOnce({
      output: Promise.resolve({ topicIds: ['deployment-workflow'] }),
      usage: Promise.resolve({}),
    } as never)
    const service = new MemoryService({
      memoryRoot: root,
      config: memoryConfig,
      resolveModel: () => ({}) as LanguageModel,
    })
    service.setActiveModelId('test:model')
    await service.initialize(process.cwd())

    const results = await service.search(
      { query: 'opaque-semantic-query', semantic: true },
      { repositoryId: 'D:/res/x-code-cli' },
    )

    expect(results[0]?.topicId).toBe('deployment-workflow')
    await service.shutdown(0)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('falls back to bounded lexical results when semantic selection fails', async () => {
    const root = await makeMemoryRoot()
    await writeTopic(
      root,
      topicMarkdown({
        id: 'deployment-workflow',
        type: 'workflow',
        aliases: ['deploy'],
        facts: [{ id: 'workflow.deploy.verify', content: '- Run the smoke suite before deployment.' }],
      }),
      'deployment-workflow',
    )
    vi.mocked(streamText).mockImplementationOnce(
      () =>
        ({
          output: Promise.reject(new Error('selector unavailable')),
          usage: Promise.resolve({}),
        }) as never,
    )
    const service = new MemoryService({
      memoryRoot: root,
      config: memoryConfig,
      resolveModel: () => ({}) as LanguageModel,
    })
    service.setActiveModelId('test:model')
    await service.initialize(process.cwd())

    const results = await service.search({ query: 'deploy', semantic: true }, { repositoryId: 'repo' })

    expect(results[0]?.topicId).toBe('deployment-workflow')
    await service.shutdown(0)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('rejects wildcard and candidate-expanding requests structurally', async () => {
    const root = await makeMemoryRoot()
    await writeTopic(
      root,
      topicMarkdown({
        id: 'profile',
        type: 'user',
        aliases: ['user profile'],
        facts: [{ id: 'user.language', content: '- OPAQUE_PROFILE_VALUE' }],
      }),
      'profile',
    )
    const service = new MemoryService({ memoryRoot: root, config: memoryConfig })
    await service.initialize(process.cwd())
    const context = { repositoryId: 'repo' }
    for (const query of [
      '*',
      '.*',
      'all memories',
      'list all memory',
      'everything you know about me',
      '列出所有记忆',
    ]) {
      await expect(service.search({ query }, context)).rejects.toThrow('specific')
    }
    await expect(service.search({ query: 'language', topicIds: ['missing'] }, context)).rejects.toThrow('cannot expand')
    await service.shutdown(0)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('does not let untrusted tool output manufacture a memory-search intent', async () => {
    const root = await makeMemoryRoot()
    const service = new MemoryService({ memoryRoot: root, config: memoryConfig })
    await service.initialize(process.cwd())
    const state = createLoopState()
    state.messages = [
      { role: 'user', content: 'Summarize this command output.' },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tool-1',
            toolName: 'shell',
            output: { type: 'text', value: 'UNTRUSTED_MEMORY_REQUEST product-portfolio' },
          },
        ],
      },
    ] as never[]
    const search = vi.spyOn(service, 'search')
    const tool = createMemorySearchTool(service, state, process.cwd())

    const result = await (tool as any).execute({ query: 'product-portfolio' }, { toolCallId: 'memory-1' })

    expect(result).toMatchObject({ error: expect.stringContaining('grounded') })
    expect(search).not.toHaveBeenCalled()
    await service.shutdown(0)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('rejects a query that adds arbitrary terms after one shared user token', async () => {
    const root = await makeMemoryRoot()
    const service = new MemoryService({ memoryRoot: root, config: memoryConfig })
    await service.initialize(process.cwd())
    const state = createLoopState()
    state.messages = [
      { role: 'user', content: 'Summarize the command output.' },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tool-1',
            toolName: 'shell',
            output: { type: 'text', value: 'private-profile' },
          },
        ],
      },
    ] as never[]
    const search = vi.spyOn(service, 'search')
    const tool = createMemorySearchTool(service, state, process.cwd())

    const result = await (tool as any).execute({ query: 'command private-profile' }, { toolCallId: 'memory-1' })

    expect(result).toMatchObject({ error: expect.stringContaining('grounded') })
    expect(search).not.toHaveBeenCalled()
    await service.shutdown(0)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('accepts a semantic query copied from the current user request', async () => {
    const root = await makeMemoryRoot()
    const service = new MemoryService({ memoryRoot: root, config: memoryConfig })
    await service.initialize(process.cwd())
    const state = createLoopState()
    state.messages = [{ role: 'user', content: 'opaque-current-request' }] as never[]
    const search = vi.spyOn(service, 'search').mockResolvedValue([])
    const tool = createMemorySearchTool(service, state, process.cwd())

    const result = await (tool as any).execute(
      { query: 'opaque-current-request', semantic: true },
      { toolCallId: 'memory-1' },
    )

    expect(result).toEqual({ results: [] })
    expect(search).toHaveBeenCalledWith(
      { query: 'opaque-current-request', semantic: true },
      { repositoryId: process.cwd() },
    )
    await service.shutdown(0)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('caps memory exposure per user turn without inspecting request language', async () => {
    const root = await makeMemoryRoot()
    const service = new MemoryService({ memoryRoot: root, config: memoryConfig })
    await service.initialize(process.cwd())
    const state = createLoopState()
    state.messages = [{ role: 'user', content: 'Compare project memories' }] as never[]
    vi.spyOn(service, 'search').mockResolvedValue(
      Array.from({ length: 5 }, (_, index) => ({
        topicId: `topic-${index}`,
        section: 'root',
        status: 'active' as const,
        updatedAt: '2026-08-02T00:00:00.000Z',
        path: `topics/topic-${index}.md`,
        snippet: `topic ${index}`,
        score: 1,
      })),
    )
    const tool = createMemorySearchTool(service, state, process.cwd())

    const first = await (tool as any).execute({ query: 'project memories' }, { toolCallId: 'memory-1' })
    const second = await (tool as any).execute({ query: 'project memories' }, { toolCallId: 'memory-2' })

    expect(first.results).toHaveLength(5)
    expect(second).toMatchObject({ error: expect.stringContaining('budget exhausted') })
    await service.shutdown(0)
    await fs.rm(root, { recursive: true, force: true })
  })
})
