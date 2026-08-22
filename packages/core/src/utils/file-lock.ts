// @x-code-cli/core — Cross-process file lock backed by an OS advisory lock.
// Shared by the memory extractor/writer and managed browser profile lease.
import { flock } from 'fs-ext-extra-prebuilt'

import fs from 'node:fs/promises'
import os from 'node:os'

export interface FileLockLease {
  release(): Promise<void>
}

export interface AcquireFileLockOptions {
  /** Only used to migrate unreadable/remote owner files from older releases. */
  staleMs?: number
  /** How long to retry while a live owner holds the lock. 0 = single attempt. */
  waitMs?: number
  retryMs?: number
  /** When given, a wait timeout throws this message instead of returning null. */
  timeoutError?: string
  signal?: AbortSignal
}

interface OwnerMetadata {
  protocol?: number
  pid?: number
  hostname?: string
  heartbeatAt?: string
}

const KERNEL_LOCK_PROTOCOL = 2

function flockAsync(fd: number, operation: 'exnb' | 'un'): Promise<void> {
  return new Promise((resolve, reject) => {
    flock(fd, operation, (error) => (error ? reject(error) : resolve()))
  })
}

function lockIsBusy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EAGAIN' || code === 'EACCES' || code === 'EWOULDBLOCK'
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

async function readOwnerMetadata(handle: Awaited<ReturnType<typeof fs.open>>): Promise<OwnerMetadata | null> {
  const buffer = Buffer.alloc(4_096)
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
  try {
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf-8')) as OwnerMetadata
  } catch {
    return null
  }
}

async function legacyOwnerIsLive(handle: Awaited<ReturnType<typeof fs.open>>, staleMs: number): Promise<boolean> {
  const owner = await readOwnerMetadata(handle)
  if (owner?.protocol === KERNEL_LOCK_PROTOCOL) return false
  const stat = await handle.stat()
  if (!owner || typeof owner.pid !== 'number') return Date.now() - stat.mtimeMs <= staleMs
  const sameHost = !owner.hostname || owner.hostname === os.hostname()
  if (sameHost) return processExists(owner.pid)
  const heartbeat = owner.heartbeatAt ? Date.parse(owner.heartbeatAt) : stat.mtimeMs
  return !Number.isFinite(heartbeat) || Date.now() - heartbeat <= staleMs
}

async function openLockFile(lockPath: string): Promise<{
  handle: Awaited<ReturnType<typeof fs.open>>
  created: boolean
}> {
  try {
    return { handle: await fs.open(lockPath, 'wx+', 0o600), created: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return { handle: await fs.open(lockPath, 'r+', 0o600), created: false }
  }
}

async function retryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error('File lock acquisition aborted')
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('File lock acquisition aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function acquireFileLock(
  lockPath: string,
  options: AcquireFileLockOptions = {},
): Promise<FileLockLease | null> {
  const staleMs = options.staleMs ?? 30_000
  const retryMs = options.retryMs ?? 25
  const deadline = Date.now() + (options.waitMs ?? 0)
  while (true) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('File lock acquisition aborted')
    let opened: Awaited<ReturnType<typeof openLockFile>>
    try {
      opened = await openLockFile(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const { handle, created } = opened
    try {
      await flockAsync(handle.fd, 'exnb')
      // Releases before the advisory-lock protocol used owner JSON plus path
      // deletion. Respect a live legacy holder during rolling upgrades; dead
      // metadata is replaced once, after which kernel ownership is definitive.
      if (!created && (await legacyOwnerIsLive(handle, staleMs))) {
        await flockAsync(handle.fd, 'un').catch(() => {})
        await handle.close().catch(() => {})
        if (Date.now() >= deadline) {
          if (options.timeoutError) throw new Error(options.timeoutError)
          return null
        }
        await retryDelay(retryMs, options.signal)
        continue
      }
      await handle.truncate(0)
      await handle.writeFile(
        JSON.stringify({ protocol: KERNEL_LOCK_PROTOCOL, pid: process.pid, startedAt: new Date().toISOString() }),
        'utf-8',
      )
      await handle.sync().catch(() => {})
      let released = false
      return {
        release: async () => {
          if (released) return
          released = true
          await flockAsync(handle.fd, 'un').catch(() => {})
          await handle.close().catch(() => {})
        },
      }
    } catch (error) {
      await handle.close().catch(() => {})
      if (!lockIsBusy(error)) throw error
      if (Date.now() >= deadline) {
        if (options.timeoutError) throw new Error(options.timeoutError)
        return null
      }
      await retryDelay(retryMs, options.signal)
    }
  }
}
