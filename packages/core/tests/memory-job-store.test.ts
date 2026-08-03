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
    explicitMemoryIntent: false,
    projection: {
      userMessages: ['opaque payload'],
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

  it('quarantines malformed projections and records a diagnostic run', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryJobStore(root)
    await store.initialize()
    await fs.writeFile(
      path.join(store.pendingDir, 'corrupt.json'),
      JSON.stringify({ ...job('corrupt'), projection: {} }),
      'utf-8',
    )

    expect(await store.claimNext()).toBeNull()
    expect(await fs.readdir(store.failedDir)).toEqual(['corrupt.json'])
    expect(await store.lastRun()).toMatchObject({ jobId: 'corrupt', status: 'failed', errorCategory: 'corrupt-job' })
    await fs.rm(root, { recursive: true, force: true })
  })

  it('does not enqueue jobs that already have a durable applied marker', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryJobStore(root)
    await store.initialize()
    await fs.writeFile(path.join(store.appliedDir, 'job-1.json'), '{"jobId":"job-1"}\n', 'utf-8')

    expect(await store.enqueue(job())).toBe('duplicate')
    expect(await store.counts()).toEqual({ pending: 0, running: 0, failed: 0 })
    await fs.rm(root, { recursive: true, force: true })
  })

  it('removes applied markers after completion and deduplicates from the bounded run log', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryJobStore(root)
    await store.initialize()
    await store.enqueue(job())
    const claimed = await store.claimNext()
    await fs.writeFile(path.join(store.appliedDir, 'job-1.json'), '{"jobId":"job-1"}\n', 'utf-8')
    await store.appendRun({
      jobId: 'job-1',
      status: 'success',
      durationMs: 1,
      tokens: 1,
      operations: 1,
      completedAt: '2026-08-02T00:00:02.000Z',
    })

    await store.complete(claimed!)

    await expect(fs.access(path.join(store.appliedDir, 'job-1.json'))).rejects.toThrow()
    expect(await store.enqueue(job())).toBe('duplicate')
    expect(await store.counts()).toEqual({ pending: 0, running: 0, failed: 0 })
    await fs.rm(root, { recursive: true, force: true })
  })

  it('publishes atomically when the filesystem does not support hard links', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryJobStore(root)
    await store.initialize()
    const link = vi
      .spyOn(fs, 'link')
      .mockRejectedValueOnce(Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }))

    expect(await store.enqueue(job('portable'))).toBe('created')
    expect((await store.claimNext())?.jobId).toBe('portable')
    link.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  })
})
