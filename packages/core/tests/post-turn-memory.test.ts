import type { ModelMessage } from 'ai'

import { buildTurnMemoryProjection, createMemoryJob, shouldCreateMemoryJob } from '../src/agent/post-turn-memory.js'

describe('post-turn memory projection', () => {
  it('contains only the current root turn increment', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'current turn payload' },
      { role: 'assistant', content: 'current turn result' },
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

    expect(projection.userMessages).toEqual(['current turn payload'])
    expect(projection.assistantFinal).toBe('current turn result')
    expect(JSON.stringify(projection)).not.toContain('old question')
    expect(shouldCreateMemoryJob(projection)).toBe(true)
  })

  it('lets the model evaluate every non-empty turn and skips only control commands', () => {
    const base = {
      assistantFinal: 'result',
      events: [],
      changedFiles: [],
      verification: [],
      repositoryId: 'repo',
      turnStartedAt: '2026-08-02T00:00:00.000Z',
      turnCompletedAt: '2026-08-02T00:00:01.000Z',
    }
    for (const text of ['opaque-a', 'Ω-opaque', 'Ж-opaque', '🙂']) {
      expect(shouldCreateMemoryJob({ ...base, userMessages: [text] })).toBe(true)
    }
    expect(shouldCreateMemoryJob({ ...base, userMessages: ['/memory status'] })).toBe(false)
    expect(shouldCreateMemoryJob({ ...base, userMessages: ['你好！'] })).toBe(false)
    expect(shouldCreateMemoryJob({ ...base, userMessages: ['你好，记住我偏好中文'] })).toBe(true)
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
    })
    const two = createMemoryJob({
      projection,
      sessionId: 'session',
      turnStartMessageIndex: 4,
      modelId: 'test:model',
      repositoryId: 'repo',
    })
    expect(one.jobId).toBe(two.jobId)
    expect(JSON.stringify(one)).not.toContain('sk-proj-abcdefghijklmnop')
    expect(JSON.stringify(one)).not.toContain('github_pat_abcdefghijklmnopqrstuv')
    expect(one.explicitMemoryIntent).toBe(false)
  })

  it('marks structural tool errors and never projects raw result bodies', () => {
    const messages = [
      { role: 'user', content: 'Inspect the config' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'op-1',
            toolName: 'opaqueTool',
            input: { reference: 'opaque-ref' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'op-1',
            toolName: 'opaqueTool',
            output: { error: { code: 'DENIED' }, value: 'do not copy this raw result prose' },
          },
        ],
      },
      { role: 'assistant', content: 'the operation failed' },
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
      name: 'opaqueTool',
      status: 'error',
      evidence: '{"reference":"opaque-ref"}; signals={"identifiers":[],"paths":[]}; status=error',
    })
    expect(JSON.stringify(projection)).not.toContain('do not copy this raw result prose')
    expect(projection.verification).toEqual([])
  })

  it('recognizes verification from the command protocol without parsing result prose', () => {
    const messages = [
      { role: 'user', content: 'run the requested checks' },
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
            output: { type: 'text', value: 'ordinary result prose must stay out' },
          },
        ],
      },
      { role: 'assistant', content: 'done' },
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

    expect(projection.verification).toEqual([
      'shell: {"command":"pnpm test"}; signals={"identifiers":[],"paths":[]}; status=ok',
    ])
    expect(JSON.stringify(projection)).not.toContain('ordinary result prose must stay out')
  })

  it('retains only structured paths and identifiers from successful tool results', () => {
    const messages = [
      { role: 'user', content: 'inspect the operation' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'op-1', toolName: 'opaqueTool', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'op-1',
            toolName: 'opaqueTool',
            output: { value: 'D:\\repo\\src\\worker.ts MemoryService TS2322 ordinary prose' },
          },
        ],
      },
      { role: 'assistant', content: 'done' },
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
    const evidence = projection.events.find((event) => event.type === 'tool-result')?.evidence

    expect(evidence).toContain('D:/repo/src/worker.ts')
    expect(evidence).toContain('MemoryService')
    expect(evidence).toContain('TS2322')
    expect(evidence).not.toContain('ordinary prose')
  })

  it('enforces the projection byte budget even with many changed paths', () => {
    const projection = buildTurnMemoryProjection({
      messages: [
        { role: 'user', content: 'payload' },
        { role: 'assistant', content: 'result' },
      ],
      turnStartMessageIndex: 0,
      filesModifiedBefore: new Set(),
      filesModifiedAfter: new Set(
        Array.from({ length: 512 }, (_, index) => `D:/repo/${String(index).padStart(4, '0')}/${'x'.repeat(200)}.ts`),
      ),
      repositoryId: 'repo',
      turnStartedAt: '2026-08-02T00:00:00.000Z',
      turnCompletedAt: '2026-08-02T00:00:01.000Z',
      maxInputTokens: 256,
    })

    expect(Buffer.byteLength(JSON.stringify(projection), 'utf-8')).toBeLessThanOrEqual(256 * 3)
  })
})
