import { describe, expect, it } from 'vitest'

import type { CacheMissSummary, ContextBreakdown, TokenUsage } from '@x-code-cli/core'

import { formatUsageReport } from '../src/ui/app/usage-report.js'

describe('formatUsageReport context detail', () => {
  it('shows initialization sub-parts and rule-size warnings', () => {
    const usage: TokenUsage = {
      inputTokens: 1_200,
      outputTokens: 100,
      totalTokens: 1_300,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      currentContextTokens: 1_000,
    }
    const context: ContextBreakdown = {
      categories: [
        { key: 'system', label: 'System prompt', estimatedTokens: 100 },
        { key: 'tools', label: 'Tool definitions', estimatedTokens: 100 },
      ],
      details: [
        { label: 'Prompt · Working Rules', estimatedTokens: 60 },
        { label: 'Tools · Direct built-ins', estimatedTokens: 100 },
      ],
      warnings: ['Merged rule files exceed 32 KiB.'],
      estimatedTotal: 200,
    }

    const output = formatUsageReport(usage, 'test:model', 'live', undefined, undefined, undefined, undefined, context)

    expect(output).toContain('**Initialization detail**')
    expect(output).toContain('Prompt · Working Rules: ~300')
    expect(output).toContain('Tools · Direct built-ins: ~500')
    expect(output).toContain('Warning: Merged rule files exceed 32 KiB.')
  })

  it('distinguishes raw cache reads from estimated reusable-prefix reuse', () => {
    const usage: TokenUsage = {
      inputTokens: 26_738,
      outputTokens: 100,
      totalTokens: 26_838,
      cacheReadTokens: 13_312,
      cacheCreationTokens: 0,
      currentContextTokens: 18_202,
    }
    const cacheMissSummary: CacheMissSummary = {
      expectedTokens: 0,
      expectedCount: 0,
      unexpectedTokens: 0,
      unexpectedCount: 0,
      probableTtlTokens: 0,
      probableTtlCount: 0,
      estimatedReusableTokens: 8_536,
      estimatedReusedTokens: 7_680,
      comparableTurnCount: 1,
      estimates: [],
    }

    const output = formatUsageReport(
      usage,
      'openai:gpt-5.6-sol',
      'live',
      undefined,
      undefined,
      undefined,
      cacheMissSummary,
    )

    expect(output).toContain('Cache read:      13,312  (49.8% of input)')
    expect(output).toContain('Reusable prefix: 7,680 / 8,536  (90.0%, estimated across 1 adjacent turn)')
  })
})
