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
  ['anthropic:claude-fable-5', 1000000],
  ['anthropic:claude-opus-4-8', 1000000],
  ['anthropic:claude-opus-4-7', 1000000],
  ['anthropic:claude-sonnet-4-6', 1000000],
  ['anthropic:claude-haiku-4-5', 200000],
  // OpenAI
  ['openai:gpt-5.5', 1047576],
  ['openai:gpt-5.4-mini', 1047576],
  ['openai:gpt-4.1', 1047576],
  ['openai:gpt-4.1-mini', 1047576],
  ['openai:gpt-4.1-nano', 1047576],
  ['openai:o3', 200000],
  ['openai:o4-mini', 200000],
  // Google
  ['google:gemini-3.5-flash', 1000000],
  ['google:gemini-2.5-pro', 1000000],
  ['google:gemini-2.5-flash', 1000000],
  // DeepSeek
  ['deepseek:deepseek-v4-flash', 1000000],
  ['deepseek:deepseek-v4-pro', 1000000],
  // Alibaba — per DashScope docs: qwen-turbo and qwen3-coder-plus extend to 1M;
  // qwen-max still caps at 32k (use qwen3-max for 256k). Values verified against
  // https://help.aliyun.com/zh/model-studio/models.
  ['alibaba:qwen3.7-max', 131072],
  ['alibaba:qwen-turbo', 1000000],
  ['alibaba:qwen-plus', 131072],
  ['alibaba:qwen-max', 32768],
  ['alibaba:qwen3-max', 262144],
  ['alibaba:qwen3-coder-plus', 1000000],
  ['alibaba:qwq-plus', 131072],
  // xAI
  ['xai:grok-4.3', 1000000],
  ['xai:grok-3', 131072],
  ['xai:grok-3-mini', 131072],
  // Zhipu
  ['zhipu:glm-5.1', 200000],
  ['zhipu:glm-5', 200000],
  ['zhipu:glm-4-plus', 128000],
  // Moonshot
  ['moonshotai:kimi-k2.6', 131072],
  ['moonshotai:kimi-k2.5', 131072],
])

/** Provider-level fallback context windows. */
const PROVIDER_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ['anthropic', 1000000],
  ['openai', 128000],
  ['google', 1000000],
  ['deepseek', 1000000],
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
 * Per-model cap on max_tokens (reply size). Some providers reject requests
 * that exceed their ceiling rather than clamping silently.
 * For models without an explicit entry, we fall back to a high default that
 * the AI SDK will clamp for known providers.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 16384
const MODEL_MAX_OUTPUT_TOKENS: ReadonlyMap<string, number> = new Map([
  // DeepSeek V4: both flash and pro advertise up to 384K output tokens.
  // We cap at a generous but conservative 131072 to avoid edge-case 400s.
  ['deepseek:deepseek-v4-flash', 131072],
  ['deepseek:deepseek-v4-pro', 131072],
  // Alibaba — qwen-turbo rejects anything above 16384; other Qwen3 models
  // support 32768 (non-thinking) / 81920 (thinking mode). We cap at the
  // non-thinking ceiling so the request always succeeds. qwen-max only has a
  // 32k context window, so we keep its output ceiling well below that.
  ['alibaba:qwen-turbo', 16384],
  ['alibaba:qwen-plus', 32000],
  ['alibaba:qwen-max', 8192],
  ['alibaba:qwen3-max', 32000],
  ['alibaba:qwen3-coder-plus', 32000],
  ['alibaba:qwq-plus', 32000],
])

/** Resolve the max_tokens ceiling we send to the provider. */
export function getMaxOutputTokens(modelId: string): number {
  return MODEL_MAX_OUTPUT_TOKENS.get(modelId) ?? DEFAULT_MAX_OUTPUT_TOKENS
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
