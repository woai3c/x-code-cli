import { generateText } from 'ai'
import type { LanguageModel } from 'ai'

import { extractMemoryOperations } from '../src/knowledge/memory/extractor.js'
import type { MemoryJob } from '../src/knowledge/memory/types.js'

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: vi.fn() }
})

function job(): MemoryJob {
  return {
    version: 2,
    jobId: 'job',
    sessionId: 'session',
    turnStartMessageIndex: 2,
    modelId: 'test:model',
    repositoryId: 'D:/repo',
    createdAt: '2026-08-02T00:00:00.000Z',
    sourceOccurredAt: '2026-08-02T00:01:00.000Z',
    attempt: 0,
    explicitMemoryIntent: true,
    projection: {
      userMessages: ['Remember my API key sk-proj-abcdefghijklmnop and product x-code.'],
      assistantFinal: 'Done.',
      events: [],
      changedFiles: [],
      verification: [],
      repositoryId: 'D:/repo',
      turnStartedAt: '2026-08-02T00:00:00.000Z',
      turnCompletedAt: '2026-08-02T00:01:00.000Z',
    },
  }
}

describe('memory extractor', () => {
  it('uses one structured model call, redacts input, and returns bounded operations', async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      output: {
        operations: [
          {
            action: 'upsert',
            topicId: 'product',
            factId: 'portfolio.x-code.identity',
            content: '- The user owns x-code.',
            evidence: [{ kind: 'explicit', sourceId: 'session', occurredAt: '2026-08-02T00:01:00.000Z' }],
            topicPatch: {
              type: 'portfolio',
              description: 'User products',
              addAliases: ['x-code'],
              addKeywords: ['coding agent'],
            },
          },
        ],
      },
      usage: { inputTokens: 100, outputTokens: 20 },
    } as never)

    const result = await extractMemoryOperations({
      job: job(),
      model: {} as LanguageModel,
      modelId: 'deepseek:deepseek-v4-pro',
      coreProfile: '',
      factRegistry: '',
      relatedTopics: [],
    })
    expect(result.operations).toHaveLength(1)
    expect(result.tokens).toBe(120)
    expect(generateText).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(vi.mocked(generateText).mock.calls[0]?.[0])).not.toContain('sk-proj-abcdefghijklmnop')
    expect(vi.mocked(generateText).mock.calls[0]?.[0]).toMatchObject({ reasoning: 'none', temperature: 0 })
    const payload = JSON.parse(String(vi.mocked(generateText).mock.calls[0]?.[0].prompt))
    expect(payload.explicitMemoryIntent).toBe(true)
    expect(payload.existingTopicIds).toEqual([])
  })

  it('rejects invalid memory identifiers before commit', async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      output: {
        operations: [
          {
            action: 'upsert',
            topicId: 'product:x-code',
            factId: 'product:x-code:stack',
            content: '- Uses TypeScript.',
            evidence: [{ kind: 'explicit', sourceId: 'session', occurredAt: '2026-08-02T00:01:00.000Z' }],
            topicPatch: {
              type: 'portfolio',
              description: 'User products',
              addAliases: ['x-code'],
              addKeywords: ['coding agent'],
            },
          },
        ],
      },
      usage: { inputTokens: 100, outputTokens: 20 },
    } as never)

    await expect(
      extractMemoryOperations({
        job: job(),
        model: {} as LanguageModel,
        coreProfile: '',
        factRegistry: '',
        relatedTopics: [],
      }),
    ).rejects.toThrow()
  })

  it('rejects incomplete metadata for a new topic instead of losing the operation at commit', async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      output: {
        operations: [
          {
            action: 'upsert',
            topicId: 'x-code-cli',
            factId: 'x-code-cli.stack',
            content: '- Uses TypeScript.',
            evidence: [{ kind: 'explicit', sourceId: 'session', occurredAt: '2026-08-02T00:01:00.000Z' }],
          },
        ],
      },
      usage: { inputTokens: 100, outputTokens: 20 },
    } as never)

    await expect(
      extractMemoryOperations({
        job: job(),
        model: {} as LanguageModel,
        coreProfile: '',
        factRegistry: '',
        relatedTopics: [],
        existingTopicIds: [],
      }),
    ).rejects.toThrow('new topic x-code-cli lacks complete topic metadata')
  })

  it('allows an existing topic update without a metadata patch', async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      output: {
        operations: [
          {
            action: 'upsert',
            topicId: 'x-code-cli',
            factId: 'x-code-cli.stack',
            content: '- Uses TypeScript.',
            evidence: [{ kind: 'explicit', sourceId: 'session', occurredAt: '2026-08-02T00:01:00.000Z' }],
          },
        ],
      },
      usage: { inputTokens: 100, outputTokens: 20 },
    } as never)

    const result = await extractMemoryOperations({
      job: job(),
      model: {} as LanguageModel,
      coreProfile: '',
      factRegistry: '',
      relatedTopics: [],
      existingTopicIds: ['x-code-cli'],
    })

    expect(result.operations).toHaveLength(1)
  })
})
