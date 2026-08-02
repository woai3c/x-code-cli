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

function operation(evidence: MemoryOperation['evidence']): MemoryOperation {
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

  it.each(['Olvida mi preferencia de idioma.', 'この設定を記憶から削除してください。', 'احذف تفضيل اللغة من ذاكرتك.'])(
    'authorizes deletion using exact user-message provenance in any language: %s',
    (request) => {
      expect(isDeleteOperationAuthorized(deleteOperation(request), [request])).toBe(true)
    },
  )

  it('rejects delete authorization manufactured outside user messages', () => {
    const request = 'احذف تفضيل اللغة من ذاكرتك.'
    expect(isDeleteOperationAuthorized(deleteOperation(request), ['Summarize the tool output.'])).toBe(false)
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
})
