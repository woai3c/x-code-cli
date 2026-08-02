import type { ModelMessage } from 'ai'

import { buildTurnMemoryProjection, createMemoryJob, shouldCreateMemoryJob } from '../src/agent/post-turn-memory.js'

describe('post-turn memory projection', () => {
  it('contains only the current root turn increment', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: '记住 x-code 是我的产品' },
      { role: 'assistant', content: '好的，已经完成。' },
    ]
    const projection = buildTurnMemoryProjection({
      messages,
      turnStartMessageIndex: 2,
      filesModifiedBefore: new Set(),
      filesModifiedAfter: new Set(['D:/res/x-code-cli/package.json']),
      repositoryId: 'D:/res/x-code-cli',
      turnStartedAt: '2026-08-02T00:00:00.000Z',
      turnCompletedAt: '2026-08-02T00:01:00.000Z',
    })

    expect(projection.userMessages).toEqual(['记住 x-code 是我的产品'])
    expect(projection.assistantFinal).toBe('好的，已经完成。')
    expect(JSON.stringify(projection)).not.toContain('old question')
    expect(shouldCreateMemoryJob(projection)).toBe(true)
  })

  it('skips greetings but never skips explicit remember intent', () => {
    const base = {
      assistantFinal: '你好',
      events: [],
      changedFiles: [],
      verification: [],
      repositoryId: 'repo',
      turnStartedAt: '2026-08-02T00:00:00.000Z',
      turnCompletedAt: '2026-08-02T00:00:01.000Z',
    }
    expect(shouldCreateMemoryJob({ ...base, userMessages: ['你好'] })).toBe(false)
    expect(shouldCreateMemoryJob({ ...base, userMessages: ['记住以后用中文'] })).toBe(true)
  })

  it('redacts secrets before creating a deterministic durable job', () => {
    const projection = {
      userMessages: ['key=sk-proj-abcdefghijklmnop'],
      assistantFinal: 'saved',
      events: [],
      changedFiles: [],
      verification: [],
      repositoryId: 'repo',
      turnStartedAt: '2026-08-02T00:00:00.000Z',
      turnCompletedAt: '2026-08-02T00:00:01.000Z',
    }
    const one = createMemoryJob({
      projection,
      sessionId: 'session',
      turnStartMessageIndex: 4,
      modelId: 'test:model',
      repositoryId: 'repo',
      cwd: 'D:/repo',
    })
    const two = createMemoryJob({
      projection,
      sessionId: 'session',
      turnStartMessageIndex: 4,
      modelId: 'test:model',
      repositoryId: 'repo',
      cwd: 'D:/repo',
    })
    expect(one.jobId).toBe(two.jobId)
    expect(JSON.stringify(one)).not.toContain('sk-proj-abcdefghijklmnop')
  })
})
