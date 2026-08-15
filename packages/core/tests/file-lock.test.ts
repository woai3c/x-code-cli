import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { acquireFileLock } from '../src/utils/file-lock.js'

const execFileAsync = promisify(execFile)
const LOCK_MODULE_URL = new URL('../dist/utils/file-lock.js', import.meta.url).href

async function runLockContender(lockPath: string, holdMs: number): Promise<{ start: number; end: number }> {
  const script = `
    import { acquireFileLock } from ${JSON.stringify(LOCK_MODULE_URL)}
    const lease = await acquireFileLock(process.argv[1], { waitMs: 10000, retryMs: 5 })
    if (!lease) throw new Error('timed out acquiring test lock')
    const start = Date.now()
    await new Promise(resolve => setTimeout(resolve, Number(process.argv[2])))
    const end = Date.now()
    await lease.release()
    process.stdout.write(JSON.stringify({ start, end }))
  `
  const result = await execFileAsync(
    process.execPath,
    ['--input-type=module', '--eval', script, lockPath, String(holdMs)],
    { windowsHide: true },
  )
  return JSON.parse(result.stdout) as { start: number; end: number }
}

describe('file lock ownership', () => {
  it('serializes real child processes even when a legacy owner file remains', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-file-lock-'))
    const lockPath = path.join(directory, 'owner.lock')
    try {
      await fs.writeFile(
        lockPath,
        JSON.stringify({ ownerId: 'dead-owner', pid: 2_147_483_647, hostname: os.hostname() }),
      )

      const intervals = await Promise.all(Array.from({ length: 12 }, () => runLockContender(lockPath, 25)))
      const events = intervals
        .flatMap(({ start, end }) => [
          { at: start, delta: 1 },
          { at: end, delta: -1 },
        ])
        .sort((a, b) => a.at - b.at || a.delta - b.delta)
      let active = 0
      let maxActive = 0
      for (const event of events) {
        active += event.delta
        maxActive = Math.max(maxActive, active)
      }

      expect(maxActive).toBe(1)
      await expect(fs.readFile(lockPath, 'utf-8')).resolves.toContain('"pid"')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 20_000)

  it('keeps a second lease out until the current lease releases', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-file-lock-'))
    const lockPath = path.join(directory, 'owner.lock')
    try {
      const first = await acquireFileLock(lockPath)
      expect(first).not.toBeNull()
      await expect(acquireFileLock(lockPath)).resolves.toBeNull()

      await first!.release()
      const second = await acquireFileLock(lockPath)
      expect(second).not.toBeNull()
      await second!.release()
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('does not overlap a live owner from the legacy owner-file protocol', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-file-lock-'))
    const lockPath = path.join(directory, 'owner.lock')
    try {
      await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, hostname: os.hostname() }))
      await expect(acquireFileLock(lockPath)).resolves.toBeNull()

      await fs.writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, hostname: os.hostname() }))
      const lease = await acquireFileLock(lockPath)
      expect(lease).not.toBeNull()
      await lease!.release()
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
