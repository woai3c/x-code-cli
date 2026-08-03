import fs from 'node:fs/promises'
import path from 'node:path'

import { MemoryJobStore } from '../src/agent/memory-job-store.js'
import { MemoryWorker, bindOperationEvidence, isDeleteOperationAuthorized } from '../src/agent/memory-worker.js'
import type { MemoryJob, MemoryOperation } from '../src/knowledge/memory-types.js'
import { makeMemoryRoot } from './memory-test-helpers.js'

function job(): MemoryJob {
  return {
    version: 2,
    jobId: 'job-evidence',
    sessionId: 'session',
    turnStartMessageIndex: 0,
    modelId: 'test:model',
    repositoryId: 'repo',
    cwd: 'D:/repo',
    createdAt: '2026-08-02T00:00:00.000Z',
    sourceOccurredAt: '2026-08-02T00:00:01.000Z',
    attempt: 0,
    explicitMemoryIntent: false,
    projection: {
      userMessages: ['The project uses TypeScript.'],
      assistantFinal: 'Understood.',
      events: [],
      changedFiles: [],
      verification: [],
      repositoryId: 'repo',
      turnStartedAt: '2026-08-02T00:00:00.000Z',
      turnCompletedAt: '2026-08-02T00:00:01.000Z',
    },
  }
}

function operation(evidence: MemoryOperation['evidence']): Extract<MemoryOperation, { action: 'upsert' }> {
  return {
    action: 'upsert',
    topicId: 'project',
    factId: 'project.stack',
    content: '- Uses TypeScript.',
    evidence,
  }
}

function deleteOperation(userRequest: string): Extract<MemoryOperation, { action: 'delete' }> {
  return {
    action: 'delete',
    remove: [{ topicId: 'profile', factId: 'user.preference', expectedTopicHash: 'hash' }],
    evidence: [{ kind: 'explicit', sourceId: 'model', occurredAt: '2026-08-02T00:00:01.000Z' }],
    reason: 'explicit-forget',
    userRequest,
  }
}

describe('memory worker evidence binding', () => {
  it('derives evidence authority, source, and time from the durable projection', () => {
    const source = job()
    const bound = bindOperationEvidence(
      [
        operation([
          { kind: 'explicit', sourceId: 'forged', occurredAt: '2099-01-01T00:00:00.000Z' },
          { kind: 'validated', sourceId: 'forged', occurredAt: '2099-01-01T00:00:00.000Z' },
          { kind: 'observed', sourceId: 'forged', occurredAt: '2099-01-01T00:00:00.000Z' },
        ]),
        operation([{ kind: 'observed', sourceId: 'forged', occurredAt: '2099-01-01T00:00:00.000Z' }]),
      ],
      source,
    )

    expect(bound).toHaveLength(1)
    expect(bound[0]?.evidence).toEqual([
      {
        kind: 'explicit',
        sourceId: 'memory-job:job-evidence:explicit',
        occurredAt: source.sourceOccurredAt,
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ])
  })

  it.each(['opaque-request', 'Ω-request', 'Ж-request', '🙂-request'])(
    'authorizes deletion using exact opaque user-message provenance: %s',
    (request) => {
      expect(isDeleteOperationAuthorized(deleteOperation(request), [request])).toBe(true)
    },
  )

  it('rejects delete authorization manufactured outside user messages', () => {
    const request = 'opaque-delete-request'
    expect(isDeleteOperationAuthorized(deleteOperation(request), ['unrelated-current-request'])).toBe(false)
  })

  it('rejects partial user-message provenance for deletion', () => {
    expect(isDeleteOperationAuthorized(deleteOperation('x'), ['prefix-x-suffix'])).toBe(false)
  })

  it('accepts observed evidence only when durable tool signals ground the operation', () => {
    const source = job()
    source.projection.events.push({
      type: 'tool-result',
      name: 'opaqueTool',
      status: 'ok',
      evidence: '{}; signals={"paths":["D:/repo/src/worker.ts"],"identifiers":["TypeScript"]}; status=ok',
    })

    const bound = bindOperationEvidence(
      [
        operation([{ kind: 'observed', sourceId: 'model', occurredAt: source.sourceOccurredAt }]),
        {
          ...operation([{ kind: 'observed', sourceId: 'model', occurredAt: source.sourceOccurredAt }]),
          content: '- Uses OpaqueValue.',
        },
      ],
      source,
    )

    expect(bound).toHaveLength(1)
    expect(bound[0]?.evidence[0]?.kind).toBe('observed')
  })

  it('retries a temporarily unavailable model instead of losing the durable job', async () => {
    const root = await makeMemoryRoot()
    const jobStore = new MemoryJobStore(root)
    await jobStore.initialize()
    await jobStore.enqueue(job())
    const worker = new MemoryWorker({
      jobStore,
      resolveModel: () => null,
      preferredModelId: () => null,
      contextFor: async () => ({ coreProfile: '', factRegistry: '', relatedTopics: [] }),
      commitOperations: async () => ({ status: 'no-op', notices: [], generation: 0 }),
      onCommitted: async () => {},
      onNotice: () => {},
      maxOperations: () => 8,
      maxOutputTokens: () => 1500,
      maxAttempts: () => 2,
    })

    worker.wake()
    const pendingPath = path.join(jobStore.pendingDir, 'job-evidence.json')
    await vi.waitFor(async () => {
      const value = JSON.parse(await fs.readFile(pendingPath, 'utf-8')) as MemoryJob
      expect(value.attempt).toBe(1)
    })
    expect(await jobStore.counts()).toEqual({ pending: 1, running: 0, failed: 0 })
    const retried = JSON.parse(await fs.readFile(pendingPath, 'utf-8')) as MemoryJob
    expect(retried.attempt).toBe(1)
    expect(retried.nextAttemptAt).toBeDefined()
    await worker.shutdown(0)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('finishes a transaction-applied job without retaining its marker', async () => {
    const root = await makeMemoryRoot()
    const jobStore = new MemoryJobStore(root)
    await jobStore.initialize()
    await jobStore.enqueue(job())
    await fs.writeFile(path.join(jobStore.appliedDir, 'job-evidence.json'), '{"jobId":"job-evidence"}\n', 'utf-8')
    const worker = new MemoryWorker({
      jobStore,
      resolveModel: () => null,
      preferredModelId: () => null,
      contextFor: async () => ({ coreProfile: '', factRegistry: '', relatedTopics: [] }),
      commitOperations: async () => ({ status: 'no-op', notices: [], generation: 0 }),
      onCommitted: async () => {},
      onNotice: () => {},
      maxOperations: () => 8,
      maxOutputTokens: () => 1500,
      maxAttempts: () => 2,
    })

    worker.wake()
    await vi.waitFor(async () => expect(await jobStore.counts()).toEqual({ pending: 0, running: 0, failed: 0 }))

    expect(await jobStore.lastRun()).toMatchObject({ jobId: 'job-evidence', status: 'no-op' })
    await expect(fs.access(path.join(jobStore.appliedDir, 'job-evidence.json'))).rejects.toThrow()
    await worker.shutdown(0)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('contains root worker failures instead of leaking a rejected wake promise', async () => {
    const onNotice = vi.fn()
    const worker = new MemoryWorker({
      jobStore: {
        tryAcquireExtractorLock: async () => {
          throw new Error('lock read failed')
        },
        nextPendingDelay: async () => null,
      } as unknown as MemoryJobStore,
      resolveModel: () => null,
      preferredModelId: () => null,
      contextFor: async () => ({ coreProfile: '', factRegistry: '', relatedTopics: [] }),
      commitOperations: async () => ({ status: 'no-op', notices: [], generation: 0 }),
      onCommitted: async () => {},
      onNotice,
      maxOperations: () => 8,
      maxOutputTokens: () => 1500,
      maxAttempts: () => 2,
    })

    worker.wake()
    await vi.waitFor(() => expect(worker.status).toBe('idle'))

    expect(onNotice).toHaveBeenCalledWith({ action: 'failed', error: 'lock read failed' })
    await worker.shutdown(0)
  })
})
