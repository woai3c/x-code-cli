// Tests for the auto-memory system
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { AutoMemory } from '../src/knowledge/auto-memory.js'
import type { KnowledgeFact } from '../src/types/index.js'

function createTestMemory() {
  return new AutoMemory(path.join(os.tmpdir(), 'x-code-test-memory-' + Date.now() + Math.random() + '.md'))
}

describe('AutoMemory', () => {
  let memory: AutoMemory

  beforeEach(() => {
    memory = createTestMemory()
  })

  it('adds a fact', () => {
    const fact: KnowledgeFact = {
      key: 'user-role',
      fact: 'senior Go engineer, new to React',
      category: 'user',
      date: '2026-04-18',
    }
    memory.add(fact)
    expect(memory.getAll()).toHaveLength(1)
    expect(memory.getAll()[0]).toMatchObject(fact)
  })

  it('replaces fact with same category + key (conflict detection)', () => {
    memory.add({ key: 'release-freeze', fact: 'starts 2026-03-05', category: 'project', date: '2026-03-01' })
    memory.add({ key: 'release-freeze', fact: 'extended to 2026-03-12', category: 'project', date: '2026-03-08' })

    expect(memory.getAll()).toHaveLength(1)
    expect(memory.getAll()[0].fact).toBe('extended to 2026-03-12')
  })

  it('allows same key in different categories', () => {
    memory.add({ key: 'testing', fact: 'integration tests hit real DB', category: 'feedback', date: '2026-04-01' })
    memory.add({
      key: 'testing',
      fact: 'Grafana test dashboard at internal/test',
      category: 'reference',
      date: '2026-04-01',
    })

    expect(memory.getAll()).toHaveLength(2)
  })

  it('finds a fact by key', () => {
    memory.add({ key: 'user-role', fact: 'data scientist', category: 'user', date: '2026-04-01' })
    const found = memory.find('user-role')
    expect(found).toBeDefined()
    expect(found!.fact).toBe('data scientist')
  })

  it('finds a fact by key and category', () => {
    memory.add({ key: 'testing', fact: 'no mocks', category: 'feedback', date: '2026-04-01' })
    memory.add({ key: 'testing', fact: 'Grafana dashboard', category: 'reference', date: '2026-04-01' })

    const found = memory.find('testing', 'feedback')
    expect(found).toBeDefined()
    expect(found!.fact).toBe('no mocks')
  })

  it('deletes a fact by key', () => {
    memory.add({ key: 'user-role', fact: 'senior Go engineer', category: 'user', date: '2026-04-01' })
    memory.delete('user-role')
    expect(memory.getAll()).toHaveLength(0)
  })

  it('deletes a fact by key and category (leaves other categories intact)', () => {
    memory.add({ key: 'testing', fact: 'no mocks', category: 'feedback', date: '2026-04-01' })
    memory.add({ key: 'testing', fact: 'Grafana dashboard', category: 'reference', date: '2026-04-01' })

    memory.delete('testing', 'feedback')
    expect(memory.getAll()).toHaveLength(1)
    expect(memory.getAll()[0].category).toBe('reference')
  })

  it('evicts facts older than maxAgeDays', () => {
    const oldDate = '2020-01-01'
    const newDate = new Date().toISOString().split('T')[0]

    memory.add({ key: 'old', fact: 'old fact', category: 'project', date: oldDate })
    memory.add({ key: 'new', fact: 'new fact', category: 'project', date: newDate })

    memory.evict(90)
    expect(memory.getAll()).toHaveLength(1)
    expect(memory.getAll()[0].key).toBe('new')
  })

  it('rejects writes with an invalid category (defense in depth)', () => {
    memory.add({
      key: 'bogus',
      fact: 'should be dropped',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      category: 'tech-stack' as any,
      date: '2026-04-20',
    })
    expect(memory.getAll()).toHaveLength(0)
  })

  it('drops legacy entries under unknown categories on load', async () => {
    const tmp = path.join(os.tmpdir(), 'x-code-legacy-mem-' + Date.now() + Math.random() + '.md')
    await fs.writeFile(
      tmp,
      `## Auto Memory

### context
- [2026-04-05] junk-task: user asked for a snake game

### tech-stack
- [2026-04-05] package-manager: pnpm

### user
- [2026-04-05] user-role: senior Go engineer
`,
      'utf-8',
    )
    const mem = new AutoMemory(tmp)
    await mem.load()
    const all = mem.getAll()
    expect(all).toHaveLength(1)
    expect(all[0].category).toBe('user')
    await fs.rm(tmp, { force: true })
  })

  it('getPromptContent groups by category', () => {
    memory.add({ key: 'user-role', fact: 'senior Go engineer', category: 'user', date: '2026-04-01' })
    memory.add({ key: 'user-lang', fact: 'reply in Chinese', category: 'user', date: '2026-04-01' })
    memory.add({ key: 'testing-policy', fact: 'no mocks', category: 'feedback', date: '2026-04-01' })

    const content = memory.getPromptContent()
    expect(content).toContain('## Auto Memory')
    expect(content).toContain('### user')
    expect(content).toContain('### feedback')
    expect(content).toContain('user-role: senior Go engineer')
    expect(content).toContain('testing-policy: no mocks')
  })
})
