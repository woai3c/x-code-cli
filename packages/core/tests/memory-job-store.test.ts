import fs from 'node:fs/promises'
import path from 'node:path'

import { MemoryJobStore } from '../src/agent/memory-job-store.js'
import type { MemoryJob } from '../src/knowledge/memory-types.js'
import { makeMemoryRoot } from './memory-test-helpers.js'

function job(id = 'job-1'): MemoryJob {
  return {
    version: 2,
    jobId: id,
    sessionId: 'session',
    turnStartMessageIndex: 0,
    modelId: 'test:model',
    repositoryId: 'D:/repo',
    cwd: 'D:/repo',
    createdAt: '2026-08-02T00:00:00.000Z',
    sourceOccurredAt: '2026-08-02T00:00:01.000Z',
    attempt: 0,
    explicitMemoryIntent: true,
    projection: {
      userMessages: ['remember this'],
      assistantFinal: 'done',
      events: [],
      changedFiles: [],
      verification: [],
      repositoryId: 'D:/repo',
      turnStartedAt: '2026-08-02T00:00:00.000Z',
      turnCompletedAt: '2026-08-02T00:00:01.000Z',
    },
  }
}

describe('MemoryJobStore', () => {
  it('atomically enqueues, deduplicates, claims, retries, and fails jobs', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryJobStore(root)
    await store.initialize()

    expect(await store.enqueue(job())).toBe('created')
    expect(await store.enqueue(job())).toBe('duplicate')
    const claimed = await store.claimNext()
    expect(claimed?.jobId).toBe('job-1')
    expect(await store.retry(claimed!)).toBe('pending')
    expect((await store.counts()).pending).toBe(1)

    await fs.writeFile(
      `${store.pendingDir}/job-1.json`,
      JSON.stringify({ ...claimed, attempt: 7, nextAttemptAt: undefined }),
      'utf-8',
    )
    const finalClaim = await store.claimNext()
    expect(await store.retry(finalClaim!)).toBe('failed')
    expect(await store.counts()).toEqual({ pending: 0, running: 0, failed: 1 })
    await fs.rm(root, { recursive: true, force: true })
  })

  it('allows only one extractor lease and recovers running jobs after ownership', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryJobStore(root)
    await store.initialize()
    const lease = await store.tryAcquireExtractorLock()
    expect(lease).not.toBeNull()
    expect(await store.tryAcquireExtractorLock()).toBeNull()
    await lease!.release()
    const nextLease = await store.tryAcquireExtractorLock()
    expect(nextLease).not.toBeNull()
    await nextLease!.release()

    await store.enqueue(job('recover-me'))
    await store.claimNext()
    expect((await store.counts()).running).toBe(1)
    await store.recoverRunning()
    expect((await store.counts()).pending).toBe(1)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('quarantines a tampered job ID instead of using it as a filesystem path', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryJobStore(root)
    await store.initialize()
    await fs.writeFile(
      path.join(store.pendingDir, 'tampered.json'),
      JSON.stringify({ ...job(), jobId: '../outside' }),
      'utf-8',
    )

    expect(await store.claimNext()).toBeNull()
    expect(await fs.readdir(store.failedDir)).toEqual(['tampered.json'])
    await fs.rm(root, { recursive: true, force: true })
  })
})
