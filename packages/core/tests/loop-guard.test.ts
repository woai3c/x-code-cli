// Tests for agent/loop-guard.ts
import { describe, expect, it } from 'vitest'

import {
  HARD_LOOP_THRESHOLD,
  SOFT_LOOP_THRESHOLD,
  checkForLoop,
  hashToolCall,
  recordToolCall,
} from '../src/agent/loop-guard.js'
import { createLoopState } from '../src/agent/loop-state.js'

describe('hashToolCall', () => {
  it('produces same hash for identical input regardless of key order', () => {
    const a = hashToolCall('shell', { command: 'ls', timeout: 5000 })
    const b = hashToolCall('shell', { timeout: 5000, command: 'ls' })
    expect(a).toBe(b)
  })

  it('produces different hashes for different tool names', () => {
    const a = hashToolCall('shell', { command: 'ls' })
    const b = hashToolCall('grep', { command: 'ls' })
    expect(a).not.toBe(b)
  })

  it('produces different hashes for different inputs', () => {
    const a = hashToolCall('shell', { command: 'ls' })
    const b = hashToolCall('shell', { command: 'pwd' })
    expect(a).not.toBe(b)
  })

  it('hash is a 16-char hex string', () => {
    const h = hashToolCall('shell', { command: 'ls' })
    expect(h).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('checkForLoop', () => {
  it('returns ok for a fresh state', () => {
    const state = createLoopState()
    const result = checkForLoop(state, 'shell', { command: 'ls' }, 'tc1')
    expect(result.kind).toBe('ok')
  })

  it('returns ok when prior calls are under the soft threshold', () => {
    const state = createLoopState()
    for (let i = 0; i < SOFT_LOOP_THRESHOLD - 2; i++) {
      recordToolCall(state, 'shell', { command: 'ls' })
    }
    const result = checkForLoop(state, 'shell', { command: 'ls' }, 'tc-new')
    expect(result.kind).toBe('ok')
  })

  it('returns soft-block at SOFT_LOOP_THRESHOLD', () => {
    const state = createLoopState()
    for (let i = 0; i < SOFT_LOOP_THRESHOLD - 1; i++) {
      recordToolCall(state, 'shell', { command: 'ls' })
    }
    const result = checkForLoop(state, 'shell', { command: 'ls' }, 'tc-new')
    expect(result.kind).toBe('soft-block')
    if (result.kind === 'soft-block') {
      expect(result.message).toContain('shell')
      expect(result.toolCallId).toBe('tc-new')
    }
  })

  it('returns hard-block at HARD_LOOP_THRESHOLD', () => {
    const state = createLoopState()
    for (let i = 0; i < HARD_LOOP_THRESHOLD - 1; i++) {
      recordToolCall(state, 'shell', { command: 'ls' })
    }
    const result = checkForLoop(state, 'shell', { command: 'ls' }, 'tc-new')
    expect(result.kind).toBe('hard-block')
  })

  it('different inputs reset the duplicate count', () => {
    const state = createLoopState()
    for (let i = 0; i < SOFT_LOOP_THRESHOLD - 1; i++) {
      recordToolCall(state, 'shell', { command: 'ls' })
    }
    // A different-input call in between should NOT contribute to the loop
    // count for the new identical call
    recordToolCall(state, 'shell', { command: 'pwd' })
    const result = checkForLoop(state, 'shell', { command: 'pwd' }, 'tc-new')
    // Only 1 prior 'pwd' call → ok
    expect(result.kind).toBe('ok')
  })

  it('different tool names do not contribute to the duplicate count', () => {
    const state = createLoopState()
    for (let i = 0; i < SOFT_LOOP_THRESHOLD - 1; i++) {
      recordToolCall(state, 'shell', { command: 'ls' })
    }
    // A different-tool call should not trigger the guard
    const result = checkForLoop(state, 'grep', { pattern: 'foo' }, 'tc-new')
    expect(result.kind).toBe('ok')
  })
})

describe('recordToolCall', () => {
  it('appends to recentToolCalls', () => {
    const state = createLoopState()
    recordToolCall(state, 'shell', { command: 'ls' })
    expect(state.recentToolCalls).toHaveLength(1)
    expect(state.recentToolCalls[0].toolName).toBe('shell')
  })

  it('caps the history at 2x the window size', () => {
    const state = createLoopState()
    for (let i = 0; i < 50; i++) {
      recordToolCall(state, 'shell', { command: `cmd-${i}` })
    }
    expect(state.recentToolCalls.length).toBeLessThanOrEqual(16) // LOOP_WINDOW_SIZE * 2
  })
})
