// @x-code-cli/core — Context window lookup & estimation
import type { ModelMessage } from 'ai'

/**
 * Compress context when usage exceeds this fraction of the model's context
 * window. Two checks use this:
 *   1. After each turn — based on the **real** input-token count reported by
 *      the API, which is the most reliable signal.
 *   2. Before each API call — based on a **character-based estimate** as a
 *      safety net. Estimates drift (tool output, non-ASCII), so we use a
 *      conservative multiplier. The estimate catches cases where a single
 *      turn (e.g. reading a huge file) pushes context past the limit before
 *      the real count is available.
 */
export const COMPRESSION_TRIGGER_RATIO = 0.8

/**
 * Rough chars-per-token ratio for pre-call estimation. Most English text is
 * ~4 chars/token; CJK and code can be lower. We use 3.0 (aggressive) so the
 * estimate over-counts slightly, making the safety net trigger earlier.
 */
const CHARS_PER_TOKEN_ESTIMATE = 3.0

/** Default context window when both model- and provider-level lookups miss. */
const DEFAULT_CONTEXT_WINDOW = 128000

/** Context window sizes per model (tokens). */
const MODEL_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  // Anthropic
  ['anthropic:claude-opus-4-6', 200000],
  ['anthropic:claude-sonnet-4-5', 200000],
  ['anthropic:claude-haiku-4-5', 200000],
  // OpenAI
  ['openai:gpt-4.1', 1047576],
  ['openai:gpt-4.1-mini', 1047576],
  ['openai:gpt-4.1-nano', 1047576],
  ['openai:o3', 200000],
  ['openai:o4-mini', 200000],
  // Google
  ['google:gemini-2.5-pro', 1000000],
  ['google:gemini-2.5-flash', 1000000],
  // DeepSeek
  ['deepseek:deepseek-chat', 64000],
  ['deepseek:deepseek-reasoner', 131072],
  // Alibaba
  ['alibaba:qwen-max', 128000],
  ['alibaba:qwen-plus', 128000],
  // xAI
  ['xai:grok-3', 131072],
  ['xai:grok-3-mini', 131072],
  // Zhipu
  ['zhipu:glm-4-plus', 128000],
  // Moonshot
  ['moonshotai:kimi-k2.5', 131072],
])

/** Provider-level fallback context windows. */
const PROVIDER_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ['anthropic', 200000],
  ['openai', 128000],
  ['google', 1000000],
  ['deepseek', 64000],
  ['alibaba', 128000],
  ['xai', 128000],
  ['zhipu', 128000],
  ['moonshotai', 128000],
])

/** Resolve context window (tokens) for a model id like `provider:model`. */
export function getContextWindow(modelId: string): number {
  const exact = MODEL_CONTEXT_WINDOWS.get(modelId)
  if (exact !== undefined) return exact
  const provider = modelId.split(':')[0]
  return PROVIDER_CONTEXT_WINDOWS.get(provider) ?? DEFAULT_CONTEXT_WINDOW
}

/** Token threshold above which we trigger compression for a given model. */
export function getCompressionThreshold(modelId: string): number {
  return Math.floor(getContextWindow(modelId) * COMPRESSION_TRIGGER_RATIO)
}

/**
 * Estimate total token count from messages using character length.
 * This is intentionally conservative (over-counting) to serve as a safety net
 * that fires before the real API limit is hit.
 */
export function estimateTokenCount(messages: ModelMessage[]): number {
  let chars = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as Array<{ type: string; text?: string }>) {
        if (typeof part.text === 'string') chars += part.text.length
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE)
}
