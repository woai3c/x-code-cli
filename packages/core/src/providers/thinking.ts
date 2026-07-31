// @x-code-cli/core — Per-provider extended-thinking / reasoning toggle
//
// AI SDK v7 provides a top-level `reasoning` parameter that works portably
// across most providers (OpenAI, Anthropic, Google, xAI, DeepSeek, Moonshot).
// We use it as the primary mechanism for reasoning control.
//
// Exceptions that still need providerOptions / fetch shim injection:
//   - zhipu: goes through @ai-sdk/openai-compatible, SDK doesn't auto-translate
//     `reasoning` for it. We inject `reasoning_effort` via fetch shim.
//   - alibaba: uses `enableThinking` in providerOptions (no top-level support).
//
// The user-facing controls:
//   /thinking on|off — binary toggle (maps to 'high' / 'none')
//   /model tier picker — explicit effort level (low/high/max etc.)
//
// When `effort` is set (user picked a tier via /model), it takes priority
// over the `enabled` flag. The /thinking toggle is only used as a fallback
// for models without an explicit tier.
import { PROVIDER_REASONING_TIERS } from '../types/index.js'
import { providerOf } from './capabilities.js'

/** Whether the model exposes a granular reasoning-effort tier (vs. the
 *  binary /thinking toggle). A provider has tiers but only some of its
 *  model families honor them — modelPattern in PROVIDER_REASONING_TIERS
 *  gates that. Drives both the /model tier picker and the effort branch
 *  in getReasoningLevel. */
export function supportsReasoningTier(modelId: string): boolean {
  const config = PROVIDER_REASONING_TIERS[providerOf(modelId)]
  if (!config) return false
  return !config.modelPattern || config.modelPattern.test(modelId)
}

export type ReasoningLevel = 'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/** Map our internal tier values (from PROVIDER_REASONING_TIERS) to the SDK's
 *  canonical reasoning levels. Most map 1:1 but 'max' maps to 'xhigh'. */
const TIER_TO_REASONING: Record<string, ReasoningLevel> = {
  none: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'xhigh',
}

/**
 * Compute the top-level `reasoning` value for streamText/generateText.
 * Returns undefined when the model doesn't support reasoning control
 * (custom provider, or Alibaba/Zhipu which use different mechanisms).
 *
 * For providers that support the SDK's top-level `reasoning` parameter
 * (OpenAI, Anthropic, Google, xAI, DeepSeek, Moonshot), this is all
 * that's needed — the SDK handles the provider-specific translation.
 */
export function getReasoningLevel(modelId: string, enabled: boolean, effort?: string): ReasoningLevel | undefined {
  const provider = providerOf(modelId)

  // These providers use separate mechanisms (providerOptions / fetch shim)
  if (provider === 'alibaba' || provider === 'zhipu' || provider === 'custom') {
    return undefined
  }

  // Tiered reasoning — user picked an explicit effort level AND the model
  // honors it.
  if (effort && supportsReasoningTier(modelId)) {
    return TIER_TO_REASONING[effort] ?? (effort as ReasoningLevel)
  }

  return enabled ? 'high' : 'none'
}

/**
 * Build providerOptions for providers that can't use the top-level
 * `reasoning` parameter: Alibaba (enableThinking) and Zhipu (thinking toggle).
 *
 * Returns an empty object for providers that use top-level `reasoning`.
 */
export function getThinkingProviderOptions(
  modelId: string,
  enabled: boolean,
  effort?: string,
): Record<string, Record<string, unknown>> {
  const provider = providerOf(modelId)

  switch (provider) {
    case 'alibaba':
      return { alibaba: { enableThinking: enabled } }

    case 'zhipu':
      // Binary toggle via providerOptions for models that don't use tiers.
      // Tiered models get reasoning_effort injected by the fetch shim.
      if (effort && supportsReasoningTier(modelId)) {
        return { zhipu: { thinking: { type: 'enabled' } } }
      }
      return enabled ? { zhipu: { thinking: { type: 'enabled' } } } : { zhipu: { thinking: { type: 'disabled' } } }

    default:
      return {}
  }
}

/** Merge thinking-mode providerOptions into an existing providerOptions
 *  bag without clobbering unrelated keys (e.g. Anthropic cache-control).
 *  Per-provider entries are deep-merged at one level: x.thinking and
 *  x.cacheControl can coexist on `providerOptions.anthropic`. */
export function mergeThinkingOptions(
  base: Record<string, unknown> | undefined,
  thinking: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(base ?? {}) }
  for (const [provider, entry] of Object.entries(thinking)) {
    const existing = (merged[provider] as Record<string, unknown> | undefined) ?? {}
    merged[provider] = { ...existing, ...entry }
  }
  return merged
}
