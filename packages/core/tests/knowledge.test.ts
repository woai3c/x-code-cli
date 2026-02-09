// Tests for knowledge system (auto-memory + loader)
import { beforeEach, describe, expect, it } from 'vitest'

import { AutoMemory } from '../src/knowledge/auto-memory.js'
import type { KnowledgeFact } from '../src/types/index.js'

// Create in-memory AutoMemory for testing (won't write to disk if path doesn't exist, that's fine)
function createTestMemory() {
  return new AutoMemory('/tmp/x-code-test-memory-' + Date.now() + '.md')
}

describe('AutoMemory', () => {
  let memory: AutoMemory

  beforeEach(() => {
    memory = createTestMemory()
  })

  it('starts empty', () => {
    expect(memory.getAll()).toEqual([])
  })

  it('adds a fact', () => {
    const fact: KnowledgeFact = {
      key: 'runtime',
      fact: 'Node.js 20',
      category: 'tech-stack',
      date: '2025-01-01',
    }
    memory.add(fact)
    expect(memory.getAll()).toHaveLength(1)
    expect(memory.getAll()[0]).toMatchObject(fact)
  })

  it('replaces fact with same category + key (conflict detection)', () => {
    memory.add({ key: 'runtime', fact: 'Node.js 20', category: 'tech-stack', date: '2025-01-01' })
    memory.add({ key: 'runtime', fact: 'Node.js 22', category: 'tech-stack', date: '2025-06-01' })

    expect(memory.getAll()).toHaveLength(1)
    expect(memory.getAll()[0].fact).toBe('Node.js 22')
  })

  it('allows same key in different categories', () => {
    memory.add({ key: 'style', fact: 'use tabs', category: 'conventions', date: '2025-01-01' })
    memory.add({ key: 'style', fact: 'minimalist', category: 'preferences', date: '2025-01-01' })

    expect(memory.getAll()).toHaveLength(2)
  })

  it('finds a fact by key', () => {
    memory.add({ key: 'runtime', fact: 'Node.js 20', category: 'tech-stack', date: '2025-01-01' })
    const found = memory.find('runtime')
    expect(found).toBeDefined()
    expect(found!.fact).toBe('Node.js 20')
  })

  it('finds a fact by key and category', () => {
    memory.add({ key: 'style', fact: 'use tabs', category: 'conventions', date: '2025-01-01' })
    memory.add({ key: 'style', fact: 'minimalist', category: 'preferences', date: '2025-01-01' })

    const found = memory.find('style', 'conventions')
    expect(found).toBeDefined()
    expect(found!.fact).toBe('use tabs')
  })

  it('returns undefined for non-existent fact', () => {
    expect(memory.find('nonexistent')).toBeUndefined()
  })

  it('deletes a fact by key', () => {
    memory.add({ key: 'runtime', fact: 'Node.js 20', category: 'tech-stack', date: '2025-01-01' })
    memory.delete('runtime')
    expect(memory.getAll()).toHaveLength(0)
  })

  it('deletes a fact by key and category', () => {
    memory.add({ key: 'style', fact: 'use tabs', category: 'conventions', date: '2025-01-01' })
    memory.add({ key: 'style', fact: 'minimalist', category: 'preferences', date: '2025-01-01' })

    memory.delete('style', 'conventions')
    expect(memory.getAll()).toHaveLength(1)
    expect(memory.getAll()[0].category).toBe('preferences')
  })

  it('evicts facts older than maxAgeDays', () => {
    const oldDate = '2020-01-01'
    const newDate = new Date().toISOString().split('T')[0]

    memory.add({ key: 'old', fact: 'old fact', category: 'context', date: oldDate })
    memory.add({ key: 'new', fact: 'new fact', category: 'context', date: newDate })

    memory.evict(90)
    expect(memory.getAll()).toHaveLength(1)
    expect(memory.getAll()[0].key).toBe('new')
  })

  it('getPromptContent returns formatted string', () => {
    memory.add({ key: 'runtime', fact: 'Node.js 20', category: 'tech-stack', date: '2025-01-01' })
    memory.add({ key: 'build', fact: 'esbuild', category: 'tech-stack', date: '2025-01-01' })

    const content = memory.getPromptContent()
    expect(content).toContain('## Auto Memory')
    expect(content).toContain('### tech-stack')
    expect(content).toContain('runtime: Node.js 20')
    expect(content).toContain('build: esbuild')
  })
})
