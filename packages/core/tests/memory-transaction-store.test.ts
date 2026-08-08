import fs from 'node:fs/promises'
import path from 'node:path'

import { MemoryTransactionStore, memoryContentHash } from '../src/knowledge/memory/transaction-store.js'
import type { MemoryChange, MemoryTransactionManifest } from '../src/knowledge/memory/types.js'
import { makeMemoryRoot } from './memory-test-helpers.js'

describe('MemoryTransactionStore', () => {
  it('replays COMMIT without DONE idempotently at the fixed target generation', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryTransactionStore(root)
    await store.initializeLayout()
    const transactionDir = path.join(store.transactionsDir, 'crashed-tx')
    const stagedDir = path.join(transactionDir, 'staged')
    const target = path.join(root, 'topics', 'recovered.md')
    const content = 'recovered topic bytes\n'
    await fs.mkdir(stagedDir, { recursive: true })
    await fs.writeFile(path.join(stagedDir, '0000.data'), content, 'utf-8')
    const manifest: MemoryTransactionManifest = {
      transactionId: 'crashed-tx',
      baseGeneration: 0,
      targetGeneration: 1,
      writes: [{ target, staged: 'staged/0000.data', nextHash: memoryContentHash(content) }],
      deletes: [],
    }
    const change: MemoryChange = { generation: 1, reason: 'upsert', changed: [], deleted: [] }
    await fs.writeFile(path.join(transactionDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8')
    await fs.writeFile(path.join(transactionDir, 'change.json'), JSON.stringify(change), 'utf-8')
    await fs.writeFile(path.join(transactionDir, 'COMMIT'), '', 'utf-8')

    await store.recover()
    await store.recover()

    expect(await fs.readFile(target, 'utf-8')).toBe(content)
    expect((await store.readSchema()).generation).toBe(1)
    expect(await fs.readdir(store.transactionsDir)).toEqual([])
    await fs.rm(root, { recursive: true, force: true })
  })

  it('serializes concurrent commits into distinct generations', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryTransactionStore(root)
    await store.initializeLayout()
    await Promise.all([
      store.commit({
        writes: new Map(),
        deletes: [],
        memoryContent: '# Core profile\n\none\n',
        change: { reason: 'upsert', changed: [], deleted: [] },
      }),
      store.commit({
        writes: new Map(),
        deletes: [],
        memoryContent: '# Core profile\n\ntwo\n',
        change: { reason: 'upsert', changed: [], deleted: [] },
      }),
    ])
    expect((await store.readSchema()).generation).toBe(2)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('rejects a tampered transaction target outside the memory store', async () => {
    const root = await makeMemoryRoot()
    const store = new MemoryTransactionStore(root)
    await store.initializeLayout()
    const transactionDir = path.join(store.transactionsDir, 'tampered-tx')
    const stagedDir = path.join(transactionDir, 'staged')
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.md`)
    await fs.mkdir(stagedDir, { recursive: true })
    await fs.writeFile(path.join(stagedDir, '0000.data'), 'do not write outside\n', 'utf-8')
    const manifest: MemoryTransactionManifest = {
      transactionId: 'tampered-tx',
      baseGeneration: 0,
      targetGeneration: 1,
      writes: [
        {
          target: outside,
          staged: 'staged/0000.data',
          nextHash: memoryContentHash('do not write outside\n'),
        },
      ],
      deletes: [],
    }
    const change: MemoryChange = { generation: 1, reason: 'upsert', changed: [], deleted: [] }
    await fs.writeFile(path.join(transactionDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8')
    await fs.writeFile(path.join(transactionDir, 'change.json'), JSON.stringify(change), 'utf-8')
    await fs.writeFile(path.join(transactionDir, 'COMMIT'), '', 'utf-8')

    await expect(store.recover()).rejects.toThrow('outside the store')
    await expect(fs.access(outside)).rejects.toThrow()
    await fs.rm(root, { recursive: true, force: true })
  })
})
