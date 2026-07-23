import { describe, expect, it } from 'vitest'

import { generateTaskSlug } from '../src/agent/plan-storage.js'

describe('generateTaskSlug', () => {
  it('uses short ASCII input directly without a model request', () => {
    expect(generateTaskSlug('hello')).toBe('hello')
    expect(generateTaskSlug('a')).toBe('a')
  })

  it('normalizes longer task descriptions locally', () => {
    expect(generateTaskSlug('Fix the LOGIN bug!')).toBe('fix-the-login-bug')
  })

  it('falls back to an empty slug for non-ASCII input', () => {
    expect(generateTaskSlug('你好')).toBe('')
    expect(generateTaskSlug('🚀✨')).toBe('')
  })
})
