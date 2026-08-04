// @x-code-cli/core — Durable file writes: same-directory temp file, fsync,
// atomic rename. Used by the memory stores and any other state file that
// must never be observed half-written.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export async function syncDirectory(dir: string): Promise<void> {
  const handle = await fs.open(dir, 'r').catch(() => null)
  if (!handle) return
  await handle.sync().catch(() => {})
  await handle.close().catch(() => {})
}

export async function atomicWriteFile(target: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  const handle = await fs.open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf-8')
    await handle.sync().catch(() => {})
  } finally {
    await handle.close()
  }
  await fs.rename(temp, target)
  await syncDirectory(path.dirname(target))
}
