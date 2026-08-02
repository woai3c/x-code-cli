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

  it('lets the model evaluate non-empty turns in any language and skips only control commands', () => {
    const base = {
      assistantFinal: '你好',
      events: [],
      changedFiles: [],
      verification: [],
      repositoryId: 'repo',
      turnStartedAt: '2026-08-02T00:00:00.000Z',
      turnCompletedAt: '2026-08-02T00:00:01.000Z',
    }
    for (const text of ['你好', 'Hello', 'Hola', 'こんにちは', 'مرحبًا', '记住以后用中文']) {
      expect(shouldCreateMemoryJob({ ...base, userMessages: [text] })).toBe(true)
    }
    expect(shouldCreateMemoryJob({ ...base, userMessages: ['/memory status'] })).toBe(false)
  })

  it('redacts secrets before creating a deterministic durable job', () => {
    const projection = {
      userMessages: ['key=sk-proj-abcdefghijklmnop github_pat_abcdefghijklmnopqrstuv'],
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
    expect(JSON.stringify(one)).not.toContain('github_pat_abcdefghijklmnopqrstuv')
  })

  it('marks structural tool errors and never projects file bodies', () => {
    const messages = [
      { role: 'user', content: 'Inspect the config' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'read-1',
            toolName: 'mcp__filesystem__read_file',
            input: { path: 'secret.env' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'read-1',
            toolName: 'mcp__filesystem__read_file',
            output: { error: { message: 'permission denied' }, value: 'FILE_BODY_MUST_NOT_ENTER_MEMORY' },
          },
        ],
      },
      { role: 'assistant', content: 'I could not read it.' },
    ] as ModelMessage[]

    const projection = buildTurnMemoryProjection({
      messages,
      turnStartMessageIndex: 0,
      filesModifiedBefore: new Set(),
      filesModifiedAfter: new Set(),
      repositoryId: 'repo',
      turnStartedAt: '2026-08-02T00:00:00.000Z',
      turnCompletedAt: '2026-08-02T00:00:01.000Z',
    })

    expect(projection.events).toContainEqual({
      type: 'tool-result',
      name: 'mcp__filesystem__read_file',
      status: 'error',
      evidence: '{"path":"secret.env"}; file content omitted; status=error',
    })
    expect(JSON.stringify(projection)).not.toContain('FILE_BODY_MUST_NOT_ENTER_MEMORY')
    expect(projection.verification).toEqual([])
  })

  it('recognizes verification from the tool invocation instead of localized output text', () => {
    const messages = [
      { role: 'user', content: 'Vérifie le projet' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'shell-1',
            toolName: 'shell',
            input: { command: 'pnpm test' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'shell-1',
            toolName: 'shell',
            output: { exitCode: 0, value: 'Toutes les vérifications ont réussi.' },
          },
        ],
      },
      { role: 'assistant', content: 'Terminé.' },
    ] as ModelMessage[]

    const projection = buildTurnMemoryProjection({
      messages,
      turnStartMessageIndex: 0,
      filesModifiedBefore: new Set(),
      filesModifiedAfter: new Set(),
      repositoryId: 'repo',
      turnStartedAt: '2026-08-02T00:00:00.000Z',
      turnCompletedAt: '2026-08-02T00:00:01.000Z',
    })

    expect(projection.verification).toEqual(['shell: Toutes les vérifications ont réussi.'])
  })
})
