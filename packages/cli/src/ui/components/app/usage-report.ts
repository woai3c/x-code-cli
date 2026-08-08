import { calibrateContextBreakdown, getContextWindow } from '@x-code-cli/core'
import type { CacheMissSummary, ContextBreakdown, StepStats, TokenUsage, UsageBreakdown } from '@x-code-cli/core'

import { GLYPH_RESULT_BRACKET } from '../../terminal-glyphs.js'
import { formatTokenCount } from '../../utils.js'

const SOURCE_LABELS = {
  main: 'Main agent',
  'sub-agent': 'Sub-agents',
  compaction: 'Compression',
  vision: 'Vision fallback',
} as const

export function formatUsageReport(
  usage: TokenUsage,
  modelId: string,
  source: 'live' | 'snapshot' | 'history',
  sessionName?: string,
  stepStats?: StepStats[],
  breakdown?: UsageBreakdown | null,
  cacheMissSummary?: CacheMissSummary | null,
  contextEstimate?: ContextBreakdown | null,
): string {
  const fmt = (n: number) => n.toLocaleString('en-US')
  const hitRatio = usage.inputTokens > 0 ? `${((usage.cacheReadTokens / usage.inputTokens) * 100).toFixed(1)}%` : 'n/a'
  const headerMap = {
    live: '**Usage** (current session)',
    snapshot: '**Usage** (last session — no turns yet)',
    history: '**Usage** (history)',
  }
  const lines = [headerMap[source], '']
  if (sessionName) lines.push(`- Session:         ${sessionName}`)
  lines.push(`- Active model:    ${modelId}`)

  if (contextEstimate && source === 'live' && usage.currentContextTokens > 0) {
    const calibrated = calibrateContextBreakdown(contextEstimate, usage.currentContextTokens)
    if (calibrated.length > 0) {
      const window = getContextWindow(modelId)
      const pct = Math.round((usage.currentContextTokens / window) * 100)
      const labelWidth = Math.max(...calibrated.map((category) => category.label.length))
      lines.push(
        '',
        `**Context usage** — ~${formatTokenCount(usage.currentContextTokens)} / ${formatTokenCount(window)} · ${pct}% (latest request, same number as the footer):`,
      )
      for (const category of calibrated) {
        lines.push(`- ${category.label.padEnd(labelWidth)}  ${formatTokenCount(category.tokens).padStart(9)}`)
      }
    }
  }

  lines.push('', '**Session totals** (cumulative):')
  lines.push(
    `- Input:           ${fmt(usage.inputTokens)}`,
    `- Output:          ${fmt(usage.outputTokens)}`,
    `- Cache read:      ${fmt(usage.cacheReadTokens)}  (${hitRatio} of input)`,
    `- Uncached input:  ${fmt(Math.max(0, usage.inputTokens - usage.cacheReadTokens))}`,
    `- Cache creation:  ${fmt(usage.cacheCreationTokens)}`,
    `- Total:           ${fmt(usage.totalTokens)}`,
  )

  if (breakdown) {
    const sources = Object.entries(breakdown.bySource).filter(
      ([, value]) => value.inputTokens > 0 || value.outputTokens > 0,
    )
    const models = Object.entries(breakdown.byModel).filter(
      ([, value]) => value.inputTokens > 0 || value.outputTokens > 0,
    )
    if (sources.length > 1 || models.length > 1) {
      lines.push('', '**Attribution** (the same totals, two ways — do not add them together):')
      if (sources.length > 1) {
        const parts = sources.map(([name, value]) => {
          const label = SOURCE_LABELS[name as keyof typeof SOURCE_LABELS] ?? name
          const tokens = fmt(value.inputTokens + value.outputTokens)
          const share =
            usage.totalTokens > 0
              ? ` (${Math.round(((value.inputTokens + value.outputTokens) / usage.totalTokens) * 100)}%)`
              : ''
          return `${label} ${tokens}${share}`
        })
        lines.push(`- Who: ${parts.join(' · ')}`)
      }
      if (models.length > 1) {
        const parts = models.map(([name, value]) => `${name} ${fmt(value.inputTokens + value.outputTokens)}`)
        lines.push(`- Which model: ${parts.join(' · ')}`)
      }
    }
  }

  if (cacheMissSummary && (cacheMissSummary.expectedCount > 0 || cacheMissSummary.unexpectedCount > 0)) {
    lines.push(
      '',
      '**Estimated re-billed input**:',
      `- Expected: ${fmt(cacheMissSummary.expectedTokens)} (${cacheMissSummary.expectedCount} miss${cacheMissSummary.expectedCount === 1 ? '' : 'es'})`,
      `- Unexpected: ${fmt(cacheMissSummary.unexpectedTokens)} (${cacheMissSummary.unexpectedCount} miss${cacheMissSummary.unexpectedCount === 1 ? '' : 'es'})`,
    )
    const probableTtlCount = cacheMissSummary.probableTtlCount ?? 0
    if (probableTtlCount > 0) {
      lines.push(
        `- Probable TTL expiry: ${fmt(cacheMissSummary.probableTtlTokens ?? 0)} (${probableTtlCount} miss${probableTtlCount === 1 ? '' : 'es'}, included in Expected)`,
      )
    }
  }

  lines.push(
    '',
    '_Context usage covers only the most recent request; session totals accumulate every request. The per-row split is estimated; only the totals are provider-reported. Cache fields are provider-reported; asynchronous post-turn memory jobs are not included._',
  )
  if (stepStats && stepStats.length > 0) {
    lines.push('', '**Steps:**', '')
    const indexWidth = String(stepStats.length).length
    for (let i = 0; i < stepStats.length; i++) {
      const step = stepStats[i]!
      const prompt = step.prompt || '(empty)'
      const label = `[${String(i + 1).padStart(indexWidth)}]`
      const pad = ' '.repeat(label.length + 1)
      lines.push(
        `${label} ${prompt}`,
        `${pad}${GLYPH_RESULT_BRACKET}  Input: ${fmt(step.inputTokens)}  Output: ${fmt(step.outputTokens)}  Turns: ${step.turnCount}  Tools: ${step.toolCallCount}`,
      )
    }
  }
  return lines.join('\n')
}
