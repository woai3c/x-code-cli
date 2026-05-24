import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LruCache } from '../src/utils/lru-cache.js'

describe('LruCache', () => {
  it('stores and retrieves values', () => {
    const cache = new LruCache<number>({ maxEntries: 10 })
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1)
    expect(cache.get('b')).toBe(2)
  })

  it('returns null for missing keys', () => {
    const cache = new LruCache<string>({ maxEntries: 10 })
    expect(cache.get('missing')).toBeNull()
  })

  it('evicts oldest entry when maxEntries is exceeded', () => {
    const cache = new LruCache<number>({ maxEntries: 3 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    cache.set('d', 4)
    expect(cache.get('a')).toBeNull()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('c')).toBe(3)
    expect(cache.get('d')).toBe(4)
    expect(cache.size).toBe(3)
  })

  it('promotes accessed entries (LRU order)', () => {
    const cache = new LruCache<number>({ maxEntries: 3 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    // Access 'a' — it becomes most-recently-used
    cache.get('a')
    // Insert 'd' — 'b' is now the oldest and should be evicted
    cache.set('d', 4)
    expect(cache.get('b')).toBeNull()
    expect(cache.get('a')).toBe(1)
    expect(cache.get('c')).toBe(3)
    expect(cache.get('d')).toBe(4)
  })

  describe('TTL expiry', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('returns null for expired entries', () => {
      const cache = new LruCache<string>({ maxEntries: 10, ttlMs: 1000 })
      cache.set('key', 'value')
      expect(cache.get('key')).toBe('value')

      vi.advanceTimersByTime(1001)
      expect(cache.get('key')).toBeNull()
    })

    it('returns value before TTL expires', () => {
      const cache = new LruCache<string>({ maxEntries: 10, ttlMs: 5000 })
      cache.set('key', 'value')

      vi.advanceTimersByTime(4999)
      expect(cache.get('key')).toBe('value')
    })
  })
})
