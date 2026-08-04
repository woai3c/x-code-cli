// @x-code-cli/core — Cross-process file lock backed by an exclusive-create
// ('wx') owner file. Shared by the memory extractor and writer locks.
//
// Stale reclamation: a lock whose owner pid is dead on this host is reclaimed
// immediately; an owner from another host (or an unreadable owner file) is
// only reclaimed once its heartbeat/mtime age exceeds staleMs, so a live
// remote holder never loses the lock to a transiently stalled heartbeat.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'

import { atomicWriteFile } from './atomic-file.js'

export interface FileLockLease {
  release(): Promise<void>
}

export interface AcquireFileLockOptions {
  staleMs?: number
  /** When set, the holder rewrites heartbeatAt on this interval. */
  heartbeatMs?: number
  /** How long to retry while a live owner holds the lock. 0 = single attempt. */
  waitMs?: number
  retryMs?: number
  /** When given, a wait timeout throws this message instead of returning null. */
  timeoutError?: string
}

interface LockOwner {
  ownerId?: string
  pid?: number
  hostname?: string
  startedAt?: string
  heartbeatAt?: string
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

function lockIsStale(owner: LockOwner | null, mtimeMs: number, staleMs: number): boolean {
  if (!owner || typeof owner.pid !== 'number') return Date.now() - mtimeMs > staleMs
  const sameHost = !owner.hostname || owner.hostname === os.hostname()
  if (sameHost) return !processExists(owner.pid)
  const heartbeat = owner.heartbeatAt ? Date.parse(owner.heartbeatAt) : mtimeMs
  return Date.now() - heartbeat > staleMs
}

export async function acquireFileLock(
  lockPath: string,
  options: AcquireFileLockOptions = {},
): Promise<FileLockLease | null> {
  const staleMs = options.staleMs ?? 30_000
  const retryMs = options.retryMs ?? 25
  const deadline = Date.now() + (options.waitMs ?? 0)
  const ownerId = `${process.pid}-${randomUUID()}`
  while (true) {
    const payload: LockOwner = {
      ownerId,
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      ...(options.heartbeatMs ? { heartbeatAt: new Date().toISOString() } : {}),
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
      let heartbeat: NodeJS.Timeout | undefined
      let heartbeatWrite = Promise.resolve()
      if (options.heartbeatMs) {
        heartbeat = setInterval(() => {
          if (released) return
          payload.heartbeatAt = new Date().toISOString()
          heartbeatWrite = heartbeatWrite.then(() => atomicWriteFile(lockPath, JSON.stringify(payload))).catch(() => {})
        }, options.heartbeatMs)
        heartbeat.unref?.()
      }
      return {
        release: async () => {
          if (released) return
          released = true
          if (heartbeat) clearInterval(heartbeat)
          await heartbeatWrite
          const currentOwner = await fs
            .readFile(lockPath, 'utf-8')
            .then((raw) => (JSON.parse(raw) as LockOwner).ownerId)
            .catch(() => undefined)
          if (currentOwner === ownerId) await fs.unlink(lockPath).catch(() => {})
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = await fs
        .readFile(lockPath, 'utf-8')
        .then((raw) => JSON.parse(raw) as LockOwner)
        .catch(() => null)
      const mtimeMs = await fs
        .stat(lockPath)
        .then((stat) => stat.mtimeMs)
        .catch(() => Date.now())
      if (lockIsStale(owner, mtimeMs, staleMs)) {
        await fs.unlink(lockPath).catch(() => {})
        continue
      }
      if (Date.now() >= deadline) {
        if (options.timeoutError) throw new Error(options.timeoutError)
        return null
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs))
    }
  }
}
