import { describe, expect, it } from 'vitest'

import { createLoopState } from '../src/agent/loop-state.js'
import {
  accumulateChildUsage,
  accumulateUsage,
  attributedModelId,
  cloneUsageBreakdown,
  normalizeLanguageModelUsage,
} from '../src/agent/usage.js'
import type { UsageBreakdown } from '../src/agent/usage.js'

describe('usage normalization', () => {
  it('accepts numeric AI SDK usage without double-counting cache tokens', () => {
    const usage = normalizeLanguageModelUsage({
      inputTokens: 100,
      outputTokens: 20,
      inputTokenDetails: { cacheReadTokens: 60, cacheWriteTokens: 10 },
    } as any)

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 60,
      cacheCreationTokens: 10,
      reasoningTokens: 0,
      cacheReadReported: true,
      cacheCreationReported: true,
    })
  })

  it('separates billed thinking tokens from visible output', () => {
    // Gemini reports thoughtsTokenCount; the SDK folds it into
    // outputTokenDetails.reasoningTokens (already included in outputTokens).
    const gemini = normalizeLanguageModelUsage({
      inputTokens: 40,
      outputTokens: 779,
      outputTokenDetails: { textTokens: 716, reasoningTokens: 63 },
    } as any)
    const compatible = normalizeLanguageModelUsage({ outputTokens: { total: 90, text: 30, reasoning: 60 } })

    expect(gemini.reasoningTokens).toBe(63)
    expect(compatible.reasoningTokens).toBe(60)
    expect(compatible.outputTokens).toBe(90)
  })

  it('accepts compatible-provider object token shapes', () => {
    const usage = normalizeLanguageModelUsage({
      inputTokens: { total: 80, noCache: 50, cacheRead: 30, cacheWrite: 4 },
      outputTokens: { total: 15 },
    })

    expect(usage).toMatchObject({
      inputTokens: 80,
      outputTokens: 15,
      cacheReadTokens: 30,
      cacheCreationTokens: 4,
    })
  })

  it('distinguishes missing cache fields from an explicitly reported zero', () => {
    const missing = normalizeLanguageModelUsage({ inputTokens: 10, outputTokens: 1 } as any)
    const explicitZero = normalizeLanguageModelUsage({
      inputTokens: 10,
      outputTokens: 1,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    } as any)

    expect(missing.cacheReadReported).toBe(false)
    expect(missing.cacheCreationReported).toBe(false)
    expect(explicitZero.cacheReadReported).toBe(true)
    expect(explicitZero.cacheCreationReported).toBe(true)
  })
})

describe('usage attribution', () => {
  const delta = (inputTokens: number, outputTokens: number, reasoningTokens = 0) => ({
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens,
    cacheReadReported: false,
    cacheCreationReported: false,
  })

  it('records source and model as parallel views while incrementing totals once', () => {
    const state = createLoopState()
    accumulateUsage(state, { source: 'main', modelId: 'openai:one', usage: delta(10, 2) })
    accumulateUsage(state, { source: 'compaction', modelId: 'openai:two', usage: delta(5, 1) })
    accumulateUsage(state, { source: 'vision', modelId: 'google:vision', usage: delta(7, 3) })

    expect(state.tokenUsage.totalTokens).toBe(28)
    const sourceTotal = Object.values(state.usageBreakdown.bySource).reduce(
      (sum, usage) => sum + usage.inputTokens + usage.outputTokens,
      0,
    )
    const modelTotal = Object.values(state.usageBreakdown.byModel).reduce(
      (sum, usage) => sum + usage.inputTokens + usage.outputTokens,
      0,
    )
    expect(sourceTotal).toBe(28)
    expect(modelTotal).toBe(28)
  })

  it('backfills buckets restored from a session written by an older version', () => {
    // Old sessions have no reasoningTokens in their persisted breakdown; a
    // plain spread would leave it undefined and poison later `+=` with NaN.
    const legacyBucket = {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheReadReported: false,
      cacheCreationReported: false,
    }
    const legacy = {
      bySource: { main: legacyBucket },
      byModel: { 'google:gemini-3.8-flash': legacyBucket },
    } as unknown as UsageBreakdown

    const cloned = cloneUsageBreakdown(legacy)
    expect(cloned.bySource.main.reasoningTokens).toBe(0)
    expect(cloned.byModel['google:gemini-3.8-flash']?.reasoningTokens).toBe(0)

    const state = createLoopState()
    state.usageBreakdown = cloned
    accumulateUsage(state, {
      source: 'main',
      modelId: 'google:gemini-3.8-flash',
      usage: { ...delta(0, 0, 5) },
    })
    expect(state.usageBreakdown.bySource.main.reasoningTokens).toBe(5)
    expect(state.tokenUsage.reasoningTokens).toBe(5)
  })

  it('accumulates thinking tokens alongside the totals they are part of', () => {
    const state = createLoopState()
    accumulateUsage(state, { source: 'main', modelId: 'google:gemini-3.8-flash', usage: delta(10, 2, 1200) })
    accumulateUsage(state, { source: 'main', modelId: 'google:gemini-3.8-flash', usage: delta(10, 2, 800) })

    expect(state.tokenUsage.reasoningTokens).toBe(2000)
    expect(state.tokenUsage.outputTokens).toBe(4)
    expect(state.usageBreakdown.byModel['google:gemini-3.8-flash']?.reasoningTokens).toBe(2000)
  })

  it('folds all child requests once into sub-agent while retaining child model buckets', () => {
    const parent = createLoopState()
    const child = createLoopState()
    accumulateUsage(child, { source: 'main', modelId: 'anthropic:worker', usage: delta(30, 5) })
    accumulateUsage(child, { source: 'compaction', modelId: 'openai:summarizer', usage: delta(10, 2) })

    accumulateChildUsage(parent, child, 'fallback:model')

    expect(parent.tokenUsage.totalTokens).toBe(47)
    expect(parent.usageBreakdown.bySource['sub-agent']).toMatchObject({ inputTokens: 40, outputTokens: 7 })
    expect(parent.usageBreakdown.bySource.compaction.inputTokens).toBe(0)
    expect(parent.usageBreakdown.byModel['anthropic:worker']).toMatchObject({ inputTokens: 30, outputTokens: 5 })
    expect(parent.usageBreakdown.byModel['openai:summarizer']).toMatchObject({ inputTokens: 10, outputTokens: 2 })
  })

  it('keeps model-switch buckets separate and qualifies bare response model ids', () => {
    expect(attributedModelId('openai:router', 'gpt-actual')).toBe('openai:gpt-actual')
    const state = createLoopState()
    accumulateUsage(state, { source: 'main', modelId: 'openai:old', usage: delta(10, 1) })
    accumulateUsage(state, { source: 'main', modelId: 'openai:new', usage: delta(20, 2) })

    expect(state.usageBreakdown.byModel['openai:old']?.inputTokens).toBe(10)
    expect(state.usageBreakdown.byModel['openai:new']?.inputTokens).toBe(20)
  })
})
