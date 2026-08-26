import { createUsageBreakdown, scanCacheMisses } from '@x-code-cli/core'
import type { CacheMissSummary } from '@x-code-cli/core'

import type { AgentState } from './types.js'

export function cloneCacheMissSummary(summary: CacheMissSummary): CacheMissSummary {
  return {
    ...summary,
    estimatedReusableTokens: summary.estimatedReusableTokens ?? 0,
    estimatedReusedTokens: summary.estimatedReusedTokens ?? 0,
    comparableTurnCount: summary.comparableTurnCount ?? 0,
    estimates: summary.estimates.slice(),
  }
}

export const initialAgentState: Omit<AgentState, 'modelId' | 'permissionMode'> = {
  messages: [],
  isLoading: false,
  activeToolCalls: [],
  shellOutput: '',
  permissionQueue: [],
  authorityRequest: null,
  pendingQuestion: null,
  queuedMessages: [],
  restoredDraft: null,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    currentContextTokens: 0,
  },
  usageBreakdown: createUsageBreakdown(),
  cacheMissSummary: scanCacheMisses([]),
  error: null,
  todos: [],
  bufferingReads: false,
  compressionLabel: null,
  ingestLabel: null,
  reconnectLabel: null,
  goalStatus: null,
  goalRunnerActive: false,
  goalVerificationActive: false,
  stepStats: [],
  peerInfluenced: false,
  backgroundTerminals: [],
  shellWaitStreak: null,
}
