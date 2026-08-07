import { describe, expect, it } from 'vitest'

import { createLoopState } from '../src/agent/loop-state.js'
import {
  accumulateChildUsage,
  accumulateUsage,
  attributedModelId,
  normalizeLanguageModelUsage,
} from '../src/agent/usage.js'

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
      cacheReadReported: true,
      cacheCreationReported: true,
    })
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
  const delta = (inputTokens: number, outputTokens: number) => ({
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
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
