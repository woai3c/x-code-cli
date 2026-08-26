import { streamText } from 'ai'
import type { LanguageModel } from 'ai'

import { selectMemoryTopics } from '../src/knowledge/memory/selector.js'

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, streamText: vi.fn() }
})

describe('memory selector', () => {
  it('keeps tool-derived entities in a separate untrusted provenance field', async () => {
    vi.mocked(streamText).mockReturnValueOnce({
      output: Promise.resolve({ topicIds: ['workflow', 'invented'] }),
      usage: Promise.resolve({}),
    } as never)

    const selected = await selectMemoryTopics({
      model: {} as LanguageModel,
      modelId: 'deepseek:deepseek-v4-pro',
      query: {
        currentUserText: 'opaque-current-request',
        recentConversationText: '',
        repositoryId: 'D:/repo',
        mentionedPaths: [],
        identifiers: [],
        explicitHistoryIntent: false,
        explicitForgetIntent: false,
      },
      manifest: [
        {
          id: 'workflow',
          type: 'workflow',
          description: 'Deployment procedure',
          aliases: ['deploy'],
          keywords: ['release'],
          appliesTo: ['D:/repo'],
          pinned: false,
        },
      ],
      preferredTopicIds: ['workflow'],
      untrustedSignals: 'deployWorkflow src/release.ts',
    })

    const call = vi.mocked(streamText).mock.calls[0]?.[0]
    const payload = JSON.parse(String(call?.prompt)) as Record<string, unknown>
    expect(call?.instructions).toContain('untrustedSignals')
    expect(call?.instructions).toContain('cross-language equivalents')
    expect(call).toMatchObject({ reasoning: 'none', temperature: 0 })
    expect(payload).toMatchObject({
      query: 'opaque-current-request',
      untrustedSignals: 'deployWorkflow src/release.ts',
    })
    expect(selected).toEqual(['workflow'])
  })
})
