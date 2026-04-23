// @x-code-cli/core — Shared agent loop state
import type { ModelMessage } from 'ai'

import type { TokenUsage } from '../types/index.js'

export interface LoopState {
  messages: ModelMessage[]
  tokenUsage: TokenUsage
  /** Real input-token count from the most recent API response, used to trigger compression. */
  lastInputTokens: number
  sessionId: string
  startedAt: string
  filesModified: Set<string>
  turnCount: number
}

export function createLoopState(): LoopState {
  return {
    messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    lastInputTokens: 0,
    sessionId: Date.now().toString(36),
    startedAt: new Date().toISOString(),
    filesModified: new Set(),
    turnCount: 0,
  }
}
