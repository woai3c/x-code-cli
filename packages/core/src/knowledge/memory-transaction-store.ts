import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { MemoryChange, MemorySchemaFile, MemoryTransactionManifest } from './memory-types.js'

const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 10_000
const STALE_LOCK_MS = 30_000

export function memoryContentHash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

async function pathExists(target: string): Promise<boolean> {
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

async function syncDirectory(dir: string): Promise<void> {
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

interface CommitInput {
  writes: Map<string, string>
  deletes: string[]
  memoryContent: string
  change: Omit<MemoryChange, 'generation'>
}

export class MemoryTransactionStore {
  readonly memoryRoot: string
  readonly stateRoot: string
  readonly transactionsDir: string
  readonly changesDir: string
  readonly locksDir: string
  readonly schemaPath: string
  readonly memoryPath: string

  constructor(memoryRoot: string) {
    this.memoryRoot = memoryRoot
    this.stateRoot = path.join(memoryRoot, '.state')
    this.transactionsDir = path.join(this.stateRoot, 'transactions')
    this.changesDir = path.join(this.stateRoot, 'changes')
    this.locksDir = path.join(this.stateRoot, 'locks')
    this.schemaPath = path.join(this.stateRoot, 'schema.json')
    this.memoryPath = path.join(memoryRoot, 'MEMORY.md')
  }

  async initializeLayout(): Promise<MemorySchemaFile> {
    await Promise.all([
      fs.mkdir(path.join(this.memoryRoot, 'topics'), { recursive: true }),
      fs.mkdir(this.transactionsDir, { recursive: true }),
      fs.mkdir(this.changesDir, { recursive: true }),
      fs.mkdir(this.locksDir, { recursive: true }),
      fs.mkdir(path.join(this.stateRoot, 'jobs', 'pending'), { recursive: true }),
      fs.mkdir(path.join(this.stateRoot, 'jobs', 'running'), { recursive: true }),
      fs.mkdir(path.join(this.stateRoot, 'jobs', 'failed'), { recursive: true }),
    ])

    if (!(await pathExists(this.schemaPath))) {
      const schema: MemorySchemaFile = { version: 2, generation: 0 }
      await atomicWriteFile(this.schemaPath, JSON.stringify(schema, null, 2) + '\n')
      if (!(await pathExists(this.memoryPath))) {
        await atomicWriteFile(this.memoryPath, emptyCoreProfile())
      }
      return schema
    }
    return this.readSchema()
  }

  async readSchema(): Promise<MemorySchemaFile> {
    const raw = await fs.readFile(this.schemaPath, 'utf-8')
    const parsed = JSON.parse(raw) as { version?: unknown; generation?: unknown }
    if (parsed.version !== 2 || !Number.isSafeInteger(parsed.generation) || Number(parsed.generation) < 0) {
      throw new Error(`Unsupported memory schema: version=${String(parsed.version)}`)
    }
    return { version: 2, generation: Number(parsed.generation) }
  }

  async withWriterLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.locksDir, 'writer.lock')
    const started = Date.now()
    while (true) {
      try {
        const handle = await fs.open(lockPath, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf-8')
          await handle.sync().catch(() => {})
        } finally {
          await handle.close()
        }
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw error
        const stat = await fs.stat(lockPath).catch(() => null)
        const owner = await fs
          .readFile(lockPath, 'utf-8')
          .then((raw) => JSON.parse(raw) as { pid?: number })
          .catch(() => null)
        const staleUnknownOwner = stat && !owner?.pid && Date.now() - stat.mtimeMs > STALE_LOCK_MS
        const deadKnownOwner = owner?.pid && !processExists(owner.pid)
        if (staleUnknownOwner || deadKnownOwner) {
          await fs.unlink(lockPath).catch(() => {})
          continue
        }
        if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error('Timed out waiting for memory writer lock')
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
      }
    }

    try {
      await this.recoverCommittedTransactionsLocked()
      return await fn()
    } finally {
      await fs.unlink(lockPath).catch(() => {})
    }
  }

  async recover(): Promise<void> {
    await this.withWriterLock(async () => undefined)
  }

  async hasUnfinishedCommit(): Promise<boolean> {
    const entries = await fs.readdir(this.transactionsDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(this.transactionsDir, entry.name)
      if ((await pathExists(path.join(dir, 'COMMIT'))) && !(await pathExists(path.join(dir, 'DONE')))) return true
    }
    return false
  }

  async readConsistent<T>(reader: () => Promise<T>): Promise<{ value: T; generation: number }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await this.hasUnfinishedCommit()) await this.recover()
      const generationA = (await this.readSchema()).generation
      const value = await reader()
      const generationB = (await this.readSchema()).generation
      if (generationA === generationB && !(await this.hasUnfinishedCommit())) {
        return { value, generation: generationB }
      }
    }
    throw new Error('Memory changed repeatedly while being read')
  }

  async commit(input: CommitInput): Promise<number> {
    return this.withWriterLock(() => this.commitLocked(input))
  }

  async commitLocked(input: CommitInput): Promise<number> {
    const schema = await this.readSchema()
    const transactionId = `${Date.now()}-${process.pid}-${randomUUID()}`
    const transactionDir = path.join(this.transactionsDir, transactionId)
    const stagedDir = path.join(transactionDir, 'staged')
    const targetGeneration = schema.generation + 1
    const writes = new Map(input.writes)
    writes.set(this.memoryPath, input.memoryContent)
    const manifest: MemoryTransactionManifest = {
      transactionId,
      baseGeneration: schema.generation,
      targetGeneration,
      writes: [],
      deletes: [],
    }

    await fs.mkdir(stagedDir, { recursive: true })
    let stagedIndex = 0
    for (const [target, content] of [...writes].sort(([a], [b]) => a.localeCompare(b))) {
      const previous = await fs.readFile(target).catch(() => null)
      const stagedName = `${String(stagedIndex++).padStart(4, '0')}.data`
      const staged = path.join('staged', stagedName)
      const stagedPath = path.join(transactionDir, staged)
      await atomicWriteFile(stagedPath, content)
      manifest.writes.push({
        target,
        staged,
        ...(previous ? { previousHash: memoryContentHash(previous) } : {}),
        nextHash: memoryContentHash(content),
      })
    }
    for (const target of [...new Set(input.deletes)].sort()) {
      const previous = await fs.readFile(target).catch(() => null)
      if (!previous) continue
      manifest.deletes.push({ target, previousHash: memoryContentHash(previous) })
    }

    const change: MemoryChange = { ...input.change, generation: targetGeneration }
    await atomicWriteFile(path.join(transactionDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    await atomicWriteFile(path.join(transactionDir, 'deletes.json'), JSON.stringify(manifest.deletes, null, 2) + '\n')
    await atomicWriteFile(path.join(transactionDir, 'MEMORY.md'), input.memoryContent)
    await atomicWriteFile(path.join(transactionDir, 'change.json'), JSON.stringify(change, null, 2) + '\n')
    await syncDirectory(transactionDir)
    await atomicWriteFile(path.join(transactionDir, 'COMMIT'), '')
    await this.applyCommittedTransaction(transactionDir, manifest, change)
    return targetGeneration
  }

  private async recoverCommittedTransactionsLocked(): Promise<void> {
    const entries = await fs.readdir(this.transactionsDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      const dir = path.join(this.transactionsDir, entry.name)
      const committed = await pathExists(path.join(dir, 'COMMIT'))
      const done = await pathExists(path.join(dir, 'DONE'))
      if (!committed) {
        await fs.rm(dir, { recursive: true, force: true })
        continue
      }
      if (done) {
        await fs.rm(dir, { recursive: true, force: true })
        continue
      }
      const manifest = JSON.parse(
        await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8'),
      ) as MemoryTransactionManifest
      const change = JSON.parse(await fs.readFile(path.join(dir, 'change.json'), 'utf-8')) as MemoryChange
      await this.applyCommittedTransaction(dir, manifest, change)
    }
  }

  private async applyCommittedTransaction(
    transactionDir: string,
    manifest: MemoryTransactionManifest,
    change: MemoryChange,
  ): Promise<void> {
    this.validateTransaction(transactionDir, manifest, change)
    const currentGeneration = (await this.readSchema()).generation
    if (currentGeneration < manifest.targetGeneration) {
      for (const write of manifest.writes) {
        const staged = await fs.readFile(path.join(transactionDir, write.staged), 'utf-8')
        if (memoryContentHash(staged) !== write.nextHash)
          throw new Error(`Corrupt staged memory write: ${write.target}`)
        const current = await fs.readFile(write.target).catch(() => null)
        const currentHash = current ? memoryContentHash(current) : undefined
        if (
          path.resolve(write.target) !== path.resolve(this.memoryPath) &&
          currentHash !== write.nextHash &&
          currentHash !== write.previousHash
        ) {
          throw new Error(`Memory write target changed during transaction: ${write.target}`)
        }
        if (currentHash !== write.nextHash) await atomicWriteFile(write.target, staged)
      }
      for (const deletion of manifest.deletes) {
        const current = await fs.readFile(deletion.target).catch(() => null)
        if (!current) continue
        const hash = memoryContentHash(current)
        if (hash !== deletion.previousHash) {
          throw new Error(`Memory delete target changed during recovery: ${deletion.target}`)
        }
        await fs.unlink(deletion.target)
      }
      await atomicWriteFile(
        path.join(this.changesDir, `${manifest.targetGeneration}.json`),
        JSON.stringify(change, null, 2) + '\n',
      )
      await atomicWriteFile(
        this.schemaPath,
        JSON.stringify({ version: 2, generation: manifest.targetGeneration }, null, 2) + '\n',
      )
      await this.pruneChanges()
    } else if (currentGeneration !== manifest.targetGeneration) {
      throw new Error(
        `Cannot replay memory transaction ${manifest.transactionId}: generation ${currentGeneration} passed ${manifest.targetGeneration}`,
      )
    }
    await atomicWriteFile(path.join(transactionDir, 'DONE'), '')
    await fs.rm(transactionDir, { recursive: true, force: true })
  }

  private validateTransaction(transactionDir: string, manifest: MemoryTransactionManifest, change: MemoryChange): void {
    if (manifest.targetGeneration !== manifest.baseGeneration + 1 || change.generation !== manifest.targetGeneration) {
      throw new Error(`Invalid memory transaction generation: ${manifest.transactionId}`)
    }
    const topicsRoot = path.resolve(this.memoryRoot, 'topics')
    const isTopicPath = (target: string) => {
      const resolved = path.resolve(target)
      const relative = path.relative(topicsRoot, resolved)
      return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative) && resolved.endsWith('.md')
    }
    for (const write of manifest.writes) {
      if (path.resolve(write.target) !== path.resolve(this.memoryPath) && !isTopicPath(write.target)) {
        throw new Error(`Memory transaction target is outside the store: ${write.target}`)
      }
      const staged = path.resolve(transactionDir, write.staged)
      const relative = path.relative(path.resolve(transactionDir, 'staged'), staged)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Memory transaction staged path is invalid: ${write.staged}`)
      }
    }
    for (const deletion of manifest.deletes) {
      if (!isTopicPath(deletion.target)) {
        throw new Error(`Memory transaction delete target is outside the store: ${deletion.target}`)
      }
    }
  }

  private async pruneChanges(): Promise<void> {
    const entries = (await fs.readdir(this.changesDir).catch(() => []))
      .filter((name) => /^\d+\.json$/.test(name))
      .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)))
    for (const entry of entries.slice(0, -256)) await fs.unlink(path.join(this.changesDir, entry)).catch(() => {})
  }
}

export function emptyCoreProfile(): string {
  return '<!-- Generated from memory/topics. Manual edits will be overwritten. -->\n\n# Core profile\n\n# Topic registry\n'
}
