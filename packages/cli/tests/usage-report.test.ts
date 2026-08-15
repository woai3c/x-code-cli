import { describe, expect, it } from 'vitest'

import type { ContextBreakdown, TokenUsage } from '@x-code-cli/core'

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
})
