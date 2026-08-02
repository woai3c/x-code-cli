import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { redactMemoryValue } from '../knowledge/memory-redaction.js'
import { atomicWriteFile } from '../knowledge/memory-transaction-store.js'
import type { MemoryJob } from '../knowledge/memory-types.js'

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 300_000, 900_000, 1_800_000]
const LOCK_STALE_MS = 30_000
const SAFE_JOB_ID_RE = /^[A-Za-z0-9._-]+$/
const RECENT_RUNS_MAX_BYTES = 256 * 1024
const RECENT_RUNS_MAX_RECORDS = 256

interface ExtractorLockFile {
  ownerId: string
  pid: number
  hostname: string
  startedAt: string
  heartbeatAt: string
}

export interface ExtractorLease {
  release(): Promise<void>
}

export interface MemoryRunRecord {
  jobId: string
  status: 'success' | 'no-op' | 'warning' | 'failed'
  durationMs: number
  tokens: number
  operations: number
  errorCategory?: string
  completedAt: string
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false,
  )
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function validateJob(value: unknown): MemoryJob {
  if (!value || typeof value !== 'object') throw new Error('Job must be an object')
  const job = value as Partial<MemoryJob>
  if (
    job.version !== 2 ||
    typeof job.jobId !== 'string' ||
    !SAFE_JOB_ID_RE.test(job.jobId) ||
    typeof job.sessionId !== 'string' ||
    typeof job.modelId !== 'string' ||
    typeof job.repositoryId !== 'string' ||
    typeof job.cwd !== 'string' ||
    typeof job.createdAt !== 'string' ||
    typeof job.attempt !== 'number' ||
    !job.projection
  ) {
    throw new Error('Invalid memory job schema')
  }
  return job as MemoryJob
}

export class MemoryJobStore {
  readonly stateRoot: string
  readonly pendingDir: string
  readonly runningDir: string
  readonly failedDir: string
  readonly locksDir: string
  readonly recentRunsPath: string

  constructor(memoryRoot: string) {
    this.stateRoot = path.join(memoryRoot, '.state')
    this.pendingDir = path.join(this.stateRoot, 'jobs', 'pending')
    this.runningDir = path.join(this.stateRoot, 'jobs', 'running')
    this.failedDir = path.join(this.stateRoot, 'jobs', 'failed')
    this.locksDir = path.join(this.stateRoot, 'locks')
    this.recentRunsPath = path.join(this.stateRoot, 'recent-runs.jsonl')
  }

  async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.pendingDir, { recursive: true }),
      fs.mkdir(this.runningDir, { recursive: true }),
      fs.mkdir(this.failedDir, { recursive: true }),
      fs.mkdir(this.locksDir, { recursive: true }),
    ])
  }

  async enqueue(job: MemoryJob): Promise<'created' | 'duplicate'> {
    validateJob(job)
    const fileName = `${job.jobId}.json`
    for (const dir of [this.pendingDir, this.runningDir, this.failedDir]) {
      if (await exists(path.join(dir, fileName))) return 'duplicate'
    }
    const target = path.join(this.pendingDir, fileName)
    const temp = path.join(this.pendingDir, `.${fileName}.${process.pid}.${randomUUID()}.tmp`)
    const payload = JSON.stringify(redactMemoryValue(job), null, 2) + '\n'
    const handle = await fs.open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(payload, 'utf-8')
      await handle.sync().catch(() => {})
    } finally {
      await handle.close()
    }
    try {
      await fs.link(temp, target)
      await fs.unlink(temp)
      return 'created'
    } catch (error) {
      await fs.unlink(temp).catch(() => {})
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'duplicate'
      throw error
    }
  }

  async claimNext(): Promise<MemoryJob | null> {
    const entries = (await fs.readdir(this.pendingDir).catch(() => [])).filter((name) => name.endsWith('.json')).sort()
    const now = Date.now()
    const parsed: Array<{ name: string; job: MemoryJob }> = []
    for (const name of entries) {
      const source = path.join(this.pendingDir, name)
      try {
        const job = validateJob(JSON.parse(await fs.readFile(source, 'utf-8')))
        if (`${job.jobId}.json` !== name) throw new Error('Memory job ID does not match its filename')
        if (job.nextAttemptAt && Date.parse(job.nextAttemptAt) > now) continue
        parsed.push({ name, job })
      } catch {
        await fs.rename(source, path.join(this.failedDir, name)).catch(() => {})
      }
    }
    parsed.sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt) || a.job.jobId.localeCompare(b.job.jobId))
    for (const item of parsed) {
      const source = path.join(this.pendingDir, item.name)
      const target = path.join(this.runningDir, item.name)
      try {
        await fs.rename(source, target)
        return item.job
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
    }
    return null
  }

  async complete(job: MemoryJob): Promise<void> {
    await fs.unlink(path.join(this.runningDir, `${job.jobId}.json`)).catch(() => {})
  }

  async retry(job: MemoryJob, maxAttempts = RETRY_DELAYS_MS.length): Promise<'pending' | 'failed'> {
    const nextAttempt = job.attempt + 1
    if (nextAttempt >= Math.min(maxAttempts, RETRY_DELAYS_MS.length)) {
      await this.fail({ ...job, attempt: nextAttempt })
      return 'failed'
    }
    const delay = RETRY_DELAYS_MS[nextAttempt - 1] ?? RETRY_DELAYS_MS.at(-1)!
    const jitter = Math.floor(delay * Math.random() * 0.2)
    const updated: MemoryJob = {
      ...job,
      attempt: nextAttempt,
      nextAttemptAt: new Date(Date.now() + delay + jitter).toISOString(),
    }
    const running = path.join(this.runningDir, `${job.jobId}.json`)
    await atomicWriteFile(running, JSON.stringify(updated, null, 2) + '\n')
    await fs.rename(running, path.join(this.pendingDir, `${job.jobId}.json`))
    return 'pending'
  }

  async fail(job: MemoryJob): Promise<void> {
    const running = path.join(this.runningDir, `${job.jobId}.json`)
    await atomicWriteFile(running, JSON.stringify(job, null, 2) + '\n')
    await fs.rename(running, path.join(this.failedDir, `${job.jobId}.json`)).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await fs.unlink(running).catch(() => {})
    })
  }

  async recoverRunning(): Promise<void> {
    const entries = (await fs.readdir(this.runningDir).catch(() => [])).filter((name) => name.endsWith('.json')).sort()
    for (const name of entries) {
      const source = path.join(this.runningDir, name)
      const target = path.join(this.pendingDir, name)
      if (await exists(target)) await fs.unlink(source).catch(() => {})
      else await fs.rename(source, target).catch(() => {})
    }
  }

  async tryAcquireExtractorLock(): Promise<ExtractorLease | null> {
    const lockPath = path.join(this.locksDir, 'extractor.lock')
    const ownerId = `${process.pid}-${randomUUID()}`
    while (true) {
      const now = new Date().toISOString()
      const payload: ExtractorLockFile = {
        ownerId,
        pid: process.pid,
        hostname: os.hostname(),
        startedAt: now,
        heartbeatAt: now,
      }
      try {
        const handle = await fs.open(lockPath, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify(payload), 'utf-8')
          await handle.sync().catch(() => {})
        } finally {
          await handle.close()
        }
        let released = false
        let heartbeatWrite = Promise.resolve()
        const heartbeat = setInterval(() => {
          if (released) return
          payload.heartbeatAt = new Date().toISOString()
          heartbeatWrite = heartbeatWrite.then(() => atomicWriteFile(lockPath, JSON.stringify(payload))).catch(() => {})
        }, 5000)
        heartbeat.unref?.()
        return {
          release: async () => {
            if (released) return
            released = true
            clearInterval(heartbeat)
            await heartbeatWrite
            const current = await fs
              .readFile(lockPath, 'utf-8')
              .then((raw) => JSON.parse(raw) as Partial<ExtractorLockFile>)
              .catch(() => null)
            if (current?.ownerId === ownerId) await fs.unlink(lockPath).catch(() => {})
          },
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const current = await fs
          .readFile(lockPath, 'utf-8')
          .then((raw) => JSON.parse(raw) as ExtractorLockFile)
          .catch(() => null)
        const stat = current ? null : await fs.stat(lockPath).catch(() => null)
        const heartbeatAge = current
          ? Date.now() - Date.parse(current.heartbeatAt)
          : Date.now() - (stat?.mtimeMs ?? Date.now())
        if (heartbeatAge > LOCK_STALE_MS && (!current || !processExists(current.pid))) {
          await fs.unlink(lockPath).catch(() => {})
          continue
        }
        return null
      }
    }
  }

  async appendRun(record: MemoryRunRecord): Promise<void> {
    await fs.appendFile(this.recentRunsPath, JSON.stringify(record) + '\n', { encoding: 'utf-8', mode: 0o600 })
    const size = await fs
      .stat(this.recentRunsPath)
      .then((stat) => stat.size)
      .catch(() => 0)
    if (size <= RECENT_RUNS_MAX_BYTES) return
    const records = (await fs.readFile(this.recentRunsPath, 'utf-8')).trim().split('\n').slice(-RECENT_RUNS_MAX_RECORDS)
    await atomicWriteFile(this.recentRunsPath, records.join('\n') + '\n')
  }

  async counts(): Promise<{ pending: number; running: number; failed: number }> {
    const count = async (dir: string) =>
      (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith('.json')).length
    const [pending, running, failed] = await Promise.all([
      count(this.pendingDir),
      count(this.runningDir),
      count(this.failedDir),
    ])
    return { pending, running, failed }
  }

  async lastRun(): Promise<MemoryRunRecord | undefined> {
    const raw = await fs.readFile(this.recentRunsPath, 'utf-8').catch(() => '')
    const line = raw.trim().split('\n').at(-1)
    if (!line) return undefined
    try {
      return JSON.parse(line) as MemoryRunRecord
    } catch {
      return undefined
    }
  }

  async nextPendingDelay(): Promise<number | null> {
    const entries = (await fs.readdir(this.pendingDir).catch(() => [])).filter((name) => name.endsWith('.json'))
    let earliest = Infinity
    for (const name of entries) {
      try {
        const job = validateJob(JSON.parse(await fs.readFile(path.join(this.pendingDir, name), 'utf-8')))
        const due = job.nextAttemptAt ? Date.parse(job.nextAttemptAt) : Date.now()
        earliest = Math.min(earliest, due)
      } catch {
        return 0
      }
    }
    return Number.isFinite(earliest) ? Math.max(0, earliest - Date.now()) : null
  }
}
