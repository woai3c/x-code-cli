import type { LanguageModelUsage } from 'ai'

import type { TokenUsage } from '../types/index.js'
import type { LoopState } from './loop-state.js'

export type UsageSource = 'main' | 'sub-agent' | 'compaction' | 'vision'

export interface UsageDelta {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  cacheReadReported: boolean
  cacheCreationReported: boolean
}

export interface UsageAttribution {
  source: UsageSource
  modelId: string
  usage: UsageDelta
}

export interface UsageBreakdown {
  bySource: Record<UsageSource, UsageDelta>
  byModel: Record<string, UsageDelta>
}

function finiteTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

function tokenTotal(value: unknown): number {
  if (typeof value === 'number') return finiteTokenCount(value)
  if (!value || typeof value !== 'object') return 0
  return finiteTokenCount((value as Record<string, unknown>).total)
}

function detailValue(
  details: Record<string, unknown> | undefined,
  objectTokens: Record<string, unknown> | undefined,
  detailKey: string,
  objectKey: string,
): { value: number; reported: boolean } {
  const detail = details?.[detailKey]
  if (typeof detail === 'number' && Number.isFinite(detail)) {
    return { value: finiteTokenCount(detail), reported: true }
  }
  const nested = objectTokens?.[objectKey]
  if (typeof nested === 'number' && Number.isFinite(nested)) {
    return { value: finiteTokenCount(nested), reported: true }
  }
  return { value: 0, reported: false }
}

export function emptyUsageDelta(): UsageDelta {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheReadReported: false,
    cacheCreationReported: false,
  }
}

export function createUsageBreakdown(): UsageBreakdown {
  return {
    bySource: {
      main: emptyUsageDelta(),
      'sub-agent': emptyUsageDelta(),
      compaction: emptyUsageDelta(),
      vision: emptyUsageDelta(),
    },
    byModel: {},
  }
}

export function cloneUsageBreakdown(breakdown: UsageBreakdown): UsageBreakdown {
  return {
    bySource: Object.fromEntries(
      Object.entries(breakdown.bySource).map(([source, usage]) => [source, { ...usage }]),
    ) as Record<UsageSource, UsageDelta>,
    byModel: Object.fromEntries(Object.entries(breakdown.byModel).map(([modelId, usage]) => [modelId, { ...usage }])),
  }
}

/** Normalize both AI SDK usage and compatible-provider object token shapes.
 *  Reported flags are captured before missing cache values become zero. */
export function normalizeLanguageModelUsage(usage: LanguageModelUsage | Record<string, unknown>): UsageDelta {
  const raw = usage as unknown as Record<string, unknown>
  const inputObject =
    raw.inputTokens && typeof raw.inputTokens === 'object' ? (raw.inputTokens as Record<string, unknown>) : undefined
  const details =
    raw.inputTokenDetails && typeof raw.inputTokenDetails === 'object'
      ? (raw.inputTokenDetails as Record<string, unknown>)
      : undefined
  const cacheRead = detailValue(details, inputObject, 'cacheReadTokens', 'cacheRead')
  const cacheCreation = detailValue(details, inputObject, 'cacheWriteTokens', 'cacheWrite')

  return {
    inputTokens: tokenTotal(raw.inputTokens),
    outputTokens: tokenTotal(raw.outputTokens),
    cacheReadTokens: cacheRead.value,
    cacheCreationTokens: cacheCreation.value,
    cacheReadReported: cacheRead.reported,
    cacheCreationReported: cacheCreation.reported,
  }
}

function addDelta(target: UsageDelta, delta: UsageDelta): void {
  target.inputTokens += delta.inputTokens
  target.outputTokens += delta.outputTokens
  target.cacheReadTokens += delta.cacheReadTokens
  target.cacheCreationTokens += delta.cacheCreationTokens
  target.cacheReadReported ||= delta.cacheReadReported
  target.cacheCreationReported ||= delta.cacheCreationReported
}

function addTokenUsage(target: TokenUsage, delta: UsageDelta): void {
  target.inputTokens += delta.inputTokens
  target.outputTokens += delta.outputTokens
  target.cacheReadTokens += delta.cacheReadTokens
  target.cacheCreationTokens += delta.cacheCreationTokens
  target.totalTokens = target.inputTokens + target.outputTokens
}

export function accumulateUsage(
  state: LoopState,
  attribution: UsageAttribution,
  options: { updateCurrentContext?: boolean } = {},
): void {
  addTokenUsage(state.tokenUsage, attribution.usage)
  if (options.updateCurrentContext) {
    state.tokenUsage.currentContextTokens = attribution.usage.inputTokens + attribution.usage.outputTokens
  }
  addDelta(state.usageBreakdown.bySource[attribution.source], attribution.usage)
  const modelBucket = (state.usageBreakdown.byModel[attribution.modelId] ??= emptyUsageDelta())
  addDelta(modelBucket, attribution.usage)
}

/** Fold a completed child's totals into the root exactly once. The root source
 *  becomes sub-agent, while the child's actual model buckets are preserved. */
export function accumulateChildUsage(parent: LoopState, child: LoopState, fallbackModelId: string): void {
  const modelEntries = Object.entries(child.usageBreakdown.byModel)
  const combined = emptyUsageDelta()
  combined.inputTokens = child.tokenUsage.inputTokens
  combined.outputTokens = child.tokenUsage.outputTokens
  combined.cacheReadTokens = child.tokenUsage.cacheReadTokens
  combined.cacheCreationTokens = child.tokenUsage.cacheCreationTokens
  for (const [, usage] of modelEntries) {
    combined.cacheReadReported ||= usage.cacheReadReported
    combined.cacheCreationReported ||= usage.cacheCreationReported
  }

  addTokenUsage(parent.tokenUsage, combined)
  addDelta(parent.usageBreakdown.bySource['sub-agent'], combined)
  if (modelEntries.length === 0) {
    addDelta((parent.usageBreakdown.byModel[fallbackModelId] ??= emptyUsageDelta()), combined)
    return
  }
  for (const [modelId, usage] of modelEntries) {
    addDelta((parent.usageBreakdown.byModel[modelId] ??= emptyUsageDelta()), usage)
  }
}

export function attributedModelId(requestedModelId: string, responseModelId?: string): string {
  if (!responseModelId || responseModelId === requestedModelId) return requestedModelId
  if (responseModelId.includes(':')) return responseModelId
  const provider = requestedModelId.split(':')[0]
  return provider ? `${provider}:${responseModelId}` : responseModelId
}
