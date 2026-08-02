import { generateText } from 'ai'
import type { LanguageModel } from 'ai'

import { selectMemoryTopics } from '../src/knowledge/memory-selector.js'

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: vi.fn() }
})

describe('memory selector', () => {
  it('keeps tool-derived entities in a separate untrusted provenance field', async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      output: { topicIds: ['workflow', 'invented'] },
    } as never)

    const selected = await selectMemoryTopics({
      model: {} as LanguageModel,
      query: {
        currentUserText: '以前のデプロイ手順を確認して',
        recentConversationText: '',
        repositoryId: 'D:/repo',
        mentionedPaths: [],
        identifiers: [],
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

    const call = vi.mocked(generateText).mock.calls[0]?.[0]
    const payload = JSON.parse(String(call?.prompt)) as Record<string, unknown>
    expect(call?.instructions).toContain('untrustedSignals')
    expect(payload).toMatchObject({
      query: '以前のデプロイ手順を確認して',
      untrustedSignals: 'deployWorkflow src/release.ts',
    })
    expect(selected).toEqual(['workflow'])
  })
})
