import type { LoopState } from './loop-state.js'
import type { UsageDelta } from './usage.js'

export type CacheMissReason =
  | 'compaction'
  | 'tool-activation'
  | 'permission-mode-change'
  | 'reasoning-change'
  | 'model-change'
  | 'tool-surface-change'
  | 'memory-context-change'
  | 'goal-change'
  | 'transcript-rewrite'
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
  /** Provider/transport-specific window in which adjacent cache reads are
   *  meaningfully comparable. Missing on sessions written by older builds. */
  cacheComparisonTtlMs?: number | null
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
  /** Upper bound of reusable input across comparable adjacent turns. */
  estimatedReusableTokens: number
  /** Provider-reported cache reads, clamped to the comparable prefix. */
  estimatedReusedTokens: number
  comparableTurnCount: number
  estimates: CacheMissEstimate[]
}

const CACHE_MISS_NOISE_FLOOR = 1024

export function createCacheMissSummary(): CacheMissSummary {
  return {
    expectedTokens: 0,
    expectedCount: 0,
    unexpectedTokens: 0,
    unexpectedCount: 0,
    probableTtlTokens: 0,
    probableTtlCount: 0,
    estimatedReusableTokens: 0,
    estimatedReusedTokens: 0,
    comparableTurnCount: 0,
    estimates: [],
  }
}

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
  cacheComparisonTtlMs?: number | null
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
    ...(options.cacheComparisonTtlMs === undefined ? {} : { cacheComparisonTtlMs: options.cacheComparisonTtlMs }),
    expectedMissReasons: [...(options.expectedMissReasons ?? [])],
  }
}

function cacheTtlMs(turn: ProviderTurnUsage): number | null {
  if (turn.cacheComparisonTtlMs !== undefined) return turn.cacheComparisonTtlMs
  if (turn.modelId.startsWith('anthropic:') || turn.modelId.startsWith('alibaba:')) return 5 * 60 * 1000
  if (/^openai:gpt-5\.6(?:$|-)/.test(turn.modelId)) return 30 * 60 * 1000
  return null
}

function appendComparablePrefix(
  summary: CacheMissSummary,
  previous: ProviderTurnUsage,
  current: ProviderTurnUsage,
): void {
  if (previous.modelId !== current.modelId || current.expectedMissReasons.length > 0) return
  if (previous.inputTokens == null || current.inputTokens == null || current.cacheReadTokens == null) return
  if (!current.cacheReadReported) return

  const idleMs = Math.max(0, Date.parse(current.timestamp) - Date.parse(previous.timestamp))
  const ttl = cacheTtlMs(current)
  if (ttl !== null && idleMs >= ttl) return

  const reusable = Math.min(previous.inputTokens, current.inputTokens)
  if (reusable <= 0) return
  // `??=` keeps resumed sessions written by older builds from accumulating NaN.
  summary.estimatedReusableTokens ??= 0
  summary.estimatedReusedTokens ??= 0
  summary.comparableTurnCount ??= 0
  summary.estimatedReusableTokens += reusable
  summary.estimatedReusedTokens += Math.min(current.cacheReadTokens, reusable)
  summary.comparableTurnCount++
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
  const ttl = previous.modelId === current.modelId ? cacheTtlMs(current) : null
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

/** Add one adjacent provider-turn pair to a cumulative summary. Mutates the
 *  supplied summary so the hot path stays O(1) as a session grows. */
export function appendCacheMissEstimate(
  summary: CacheMissSummary,
  previous: ProviderTurnUsage | undefined,
  current: ProviderTurnUsage,
): CacheMissEstimate | undefined {
  if (!previous) return undefined
  appendComparablePrefix(summary, previous, current)
  const estimate = estimateCacheMiss(previous, current)
  if (!estimate) return undefined
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
  return estimate
}

export function appendProviderTurnUsage(state: LoopState, current: ProviderTurnUsage): CacheMissEstimate | undefined {
  const previous = state.providerTurns.at(-1)
  state.providerTurns.push(current)
  return appendCacheMissEstimate(state.cacheMissSummary, previous, current)
}

export function scanCacheMisses(turns: readonly ProviderTurnUsage[]): CacheMissSummary {
  const summary = createCacheMissSummary()
  for (let i = 1; i < turns.length; i++) {
    appendCacheMissEstimate(summary, turns[i - 1], turns[i]!)
  }
  return summary
}
