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
  /** Rolling record of recently executed tool calls, keyed by a hash of the
   *  tool name + stable-stringified input. Used by the doom-loop guard to
   *  detect when the model is looping on the same failing call. */
  recentToolCalls: Array<{ toolName: string; hash: string }>
  /** Cached system prompt text — rebuilt once per session so the prefix
   *  stays byte-stable across turns, enabling automatic prefix-caching on
   *  OpenAI-compatible providers (DeepSeek, Moonshot, Alibaba, …). */
  systemPromptCache: string | null
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
    recentToolCalls: [],
    systemPromptCache: null,
  }
}
