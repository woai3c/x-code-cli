import type { LoopState } from './loop-state.js'
import type { UsageDelta } from './usage.js'

export type CacheMissReason =
  | 'compaction'
  | 'tool-activation'
  | 'permission-mode-change'
  | 'model-change'
  | 'tool-surface-change'
  | 'memory-context-change'
  | 'goal-change'
  | 'ttl-expiry'
  | 'other'

export interface ProviderTurnUsage {
  modelId: string
  timestamp: string
  requestKind: 'main'
  inputTokens: number | null
  outputTokens: number | null
  noCacheTokens: number | null
  cacheReadTokens: number | null
  cacheCreationTokens: number | null
  cacheReadReported: boolean
  cacheCreationReported: boolean
  expectedMissReasons: CacheMissReason[]
}

export interface CacheMissEstimate {
  missedTokens: number
  expected: boolean
  reasons: CacheMissReason[]
  idleMs: number
  probableTtlExpiry: boolean
  previous: ProviderTurnUsage
  current: ProviderTurnUsage
}

export interface CacheMissSummary {
  expectedTokens: number
  expectedCount: number
  unexpectedTokens: number
  unexpectedCount: number
  probableTtlTokens: number
  probableTtlCount: number
  estimates: CacheMissEstimate[]
}

export const CACHE_MISS_NOISE_FLOOR = 1024

export function markExpectedCacheMiss(state: LoopState, reason: CacheMissReason): void {
  state.expectCacheMiss = true
  state.expectedCacheMissReasons.add(reason)
}

export function consumeExpectedCacheMissReasons(state: LoopState): CacheMissReason[] {
  const reasons = [...state.expectedCacheMissReasons]
  if (state.expectCacheMiss && reasons.length === 0) reasons.push('other')
  state.expectCacheMiss = false
  state.expectedCacheMissReasons.clear()
  return reasons
}

function tokenValue(raw: Record<string, unknown>, key: 'inputTokens' | 'outputTokens'): number | null {
  const value = raw[key]
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value)
  if (value && typeof value === 'object') {
    const total = (value as Record<string, unknown>).total
    if (typeof total === 'number' && Number.isFinite(total)) return Math.max(0, total)
  }
  return null
}

function noCacheValue(raw: Record<string, unknown>): number | null {
  const details =
    raw.inputTokenDetails && typeof raw.inputTokenDetails === 'object'
      ? (raw.inputTokenDetails as Record<string, unknown>)
      : undefined
  if (typeof details?.noCacheTokens === 'number') return Math.max(0, details.noCacheTokens)
  const input =
    raw.inputTokens && typeof raw.inputTokens === 'object' ? (raw.inputTokens as Record<string, unknown>) : undefined
  return typeof input?.noCache === 'number' ? Math.max(0, input.noCache) : null
}

export function createProviderTurnUsage(options: {
  modelId: string
  usage: Record<string, unknown>
  normalized: UsageDelta
  expectedMissReasons?: Iterable<CacheMissReason>
  timestamp?: string
}): ProviderTurnUsage {
  return {
    modelId: options.modelId,
    timestamp: options.timestamp ?? new Date().toISOString(),
    requestKind: 'main',
    inputTokens: tokenValue(options.usage, 'inputTokens'),
    outputTokens: tokenValue(options.usage, 'outputTokens'),
    noCacheTokens: noCacheValue(options.usage),
    cacheReadTokens: options.normalized.cacheReadReported ? options.normalized.cacheReadTokens : null,
    cacheCreationTokens: options.normalized.cacheCreationReported ? options.normalized.cacheCreationTokens : null,
    cacheReadReported: options.normalized.cacheReadReported,
    cacheCreationReported: options.normalized.cacheCreationReported,
    expectedMissReasons: [...(options.expectedMissReasons ?? [])],
  }
}

function cacheTtlMs(modelId: string): number | null {
  return modelId.startsWith('anthropic:') ? 5 * 60 * 1000 : null
}

export function estimateCacheMiss(
  previous: ProviderTurnUsage,
  current: ProviderTurnUsage,
): CacheMissEstimate | undefined {
  if (previous.inputTokens == null || current.inputTokens == null || current.cacheReadTokens == null) return undefined
  if (!current.cacheReadReported) return undefined

  const reusablePrefixUpperBound = Math.min(previous.inputTokens, current.inputTokens)
  const missedTokens = Math.max(0, reusablePrefixUpperBound - current.cacheReadTokens)
  if (missedTokens < CACHE_MISS_NOISE_FLOOR) return undefined

  const reasons = [...current.expectedMissReasons]
  if (previous.modelId !== current.modelId && !reasons.includes('model-change')) reasons.push('model-change')
  const idleMs = Math.max(0, Date.parse(current.timestamp) - Date.parse(previous.timestamp))
  const ttl = cacheTtlMs(current.modelId)
  const probableTtlExpiry = ttl !== null && idleMs >= ttl
  if (probableTtlExpiry && !reasons.includes('ttl-expiry')) reasons.push('ttl-expiry')
  return {
    missedTokens,
    expected: reasons.length > 0,
    reasons,
    idleMs,
    probableTtlExpiry,
    previous,
    current,
  }
}

export function scanCacheMisses(turns: readonly ProviderTurnUsage[]): CacheMissSummary {
  const estimates: CacheMissEstimate[] = []
  for (let i = 1; i < turns.length; i++) {
    const estimate = estimateCacheMiss(turns[i - 1]!, turns[i]!)
    if (estimate) estimates.push(estimate)
  }
  return estimates.reduce<CacheMissSummary>(
    (summary, estimate) => {
      if (estimate.expected) {
        summary.expectedTokens += estimate.missedTokens
        summary.expectedCount++
      } else {
        summary.unexpectedTokens += estimate.missedTokens
        summary.unexpectedCount++
      }
      if (estimate.probableTtlExpiry) {
        summary.probableTtlTokens += estimate.missedTokens
        summary.probableTtlCount++
      }
      summary.estimates.push(estimate)
      return summary
    },
    {
      expectedTokens: 0,
      expectedCount: 0,
      unexpectedTokens: 0,
      unexpectedCount: 0,
      probableTtlTokens: 0,
      probableTtlCount: 0,
      estimates: [],
    },
  )
}
