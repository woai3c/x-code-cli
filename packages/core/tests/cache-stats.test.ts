import { describe, expect, it } from 'vitest'

import { createProviderTurnUsage, estimateCacheMiss, scanCacheMisses } from '../src/agent/cache-stats.js'
import { normalizeLanguageModelUsage } from '../src/agent/usage.js'

function turn(options: {
  modelId?: string
  timestamp?: string
  input: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasons?: Parameters<typeof createProviderTurnUsage>[0]['expectedMissReasons']
}) {
  const usage = {
    inputTokens: options.input,
    outputTokens: options.output ?? 10,
    ...(options.cacheRead === undefined && options.cacheWrite === undefined
      ? {}
      : {
          inputTokenDetails: {
            cacheReadTokens: options.cacheRead,
            cacheWriteTokens: options.cacheWrite,
          },
        }),
  }
  return createProviderTurnUsage({
    modelId: options.modelId ?? 'openai:test',
    usage,
    normalized: normalizeLanguageModelUsage(usage as any),
    expectedMissReasons: options.reasons,
    timestamp: options.timestamp,
  })
}

describe('cache miss estimation', () => {
  it('does not report a miss when a stable prefix is fully read from cache', () => {
    const previous = turn({ input: 5_000, cacheRead: 4_000, cacheWrite: 0 })
    const current = turn({ input: 6_000, cacheRead: 5_000, cacheWrite: 0 })

    expect(estimateCacheMiss(previous, current)).toBeUndefined()
  })

  it('reports explicit cache-read zero as an unexpected miss', () => {
    const previous = turn({ input: 8_000, cacheRead: 6_000, cacheWrite: 0 })
    const current = turn({ input: 9_000, cacheRead: 0, cacheWrite: 0 })

    expect(estimateCacheMiss(previous, current)).toMatchObject({
      missedTokens: 8_000,
      expected: false,
      reasons: [],
    })
  })

  it.each(['compaction', 'tool-activation', 'permission-mode-change'] as const)(
    'marks %s misses as expected',
    (reason) => {
      const previous = turn({ input: 8_000, cacheRead: 6_000 })
      const current = turn({ input: 9_000, cacheRead: 0, reasons: [reason] })

      expect(estimateCacheMiss(previous, current)).toMatchObject({ expected: true, reasons: [reason] })
    },
  )

  it('adds model-change even when the caller did not pre-mark it', () => {
    const previous = turn({ modelId: 'openai:old', input: 8_000, cacheRead: 6_000 })
    const current = turn({ modelId: 'openai:new', input: 9_000, cacheRead: 0 })

    expect(estimateCacheMiss(previous, current)).toMatchObject({ expected: true, reasons: ['model-change'] })
  })

  it('does not infer cache support from missing fields and filters noise', () => {
    const previous = turn({ input: 8_000, cacheRead: 6_000 })
    expect(estimateCacheMiss(previous, turn({ input: 9_000 }))).toBeUndefined()
    expect(estimateCacheMiss(previous, turn({ input: 8_500, cacheRead: 7_500 }))).toBeUndefined()
  })

  it('records idle duration and only labels TTL expiry for a known provider', () => {
    const start = '2026-08-07T00:00:00.000Z'
    const end = '2026-08-07T00:06:00.000Z'
    const anthropic = estimateCacheMiss(
      turn({ modelId: 'anthropic:test', input: 8_000, cacheRead: 6_000, timestamp: start }),
      turn({ modelId: 'anthropic:test', input: 9_000, cacheRead: 0, timestamp: end }),
    )
    const custom = estimateCacheMiss(
      turn({ modelId: 'custom:test', input: 8_000, cacheRead: 6_000, timestamp: start }),
      turn({ modelId: 'custom:test', input: 9_000, cacheRead: 0, timestamp: end }),
    )

    expect(anthropic).toMatchObject({
      idleMs: 360_000,
      probableTtlExpiry: true,
      expected: true,
      reasons: ['ttl-expiry'],
    })
    expect(custom).toMatchObject({ idleMs: 360_000, probableTtlExpiry: false, expected: false, reasons: [] })

    const summary = scanCacheMisses([
      turn({ modelId: 'anthropic:test', input: 8_000, cacheRead: 6_000, timestamp: start }),
      turn({ modelId: 'anthropic:test', input: 9_000, cacheRead: 0, timestamp: end }),
    ])
    expect(summary).toMatchObject({
      expectedTokens: 8_000,
      expectedCount: 1,
      unexpectedTokens: 0,
      unexpectedCount: 0,
      probableTtlTokens: 8_000,
      probableTtlCount: 1,
    })
  })

  it('summarizes expected and unexpected estimates separately', () => {
    const summary = scanCacheMisses([
      turn({ input: 5_000, cacheRead: 4_000 }),
      turn({ input: 6_000, cacheRead: 0, reasons: ['compaction'] }),
      turn({ input: 7_000, cacheRead: 0 }),
    ])

    expect(summary).toMatchObject({
      expectedTokens: 5_000,
      expectedCount: 1,
      unexpectedTokens: 6_000,
      unexpectedCount: 1,
    })
  })
})
