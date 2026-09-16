// @x-code-cli/core — Per-provider extended-thinking / reasoning toggle
//
// AI SDK v7 provides a top-level `reasoning` parameter that works portably
// across most providers (OpenAI, Anthropic, Google, xAI, DeepSeek, Moonshot).
// We use it as the primary mechanism for reasoning control.
//
// Exceptions that still need providerOptions / fetch shim injection:
//   - deepseek: explicit tiers use native reasoningEffort so `max` does not
//     round-trip through portable `xhigh` and emit a compatibility warning.
//   - zhipu: goes through @ai-sdk/openai-compatible, SDK doesn't auto-translate
//     `reasoning` for it. We inject `reasoning_effort` via fetch shim.
//   - alibaba: uses `enableThinking` in providerOptions (no top-level support).
//   - native `max` controls for newer Anthropic/OpenAI models also travel via
//     providerOptions because the portable reasoning enum tops out at xhigh.
//
// The user-facing controls:
//   /thinking on|off — binary toggle (maps to 'high' / 'none')
//   /model tier picker — explicit effort level (low/high/max etc.)
//
// When `effort` is set (user picked a tier via /model), it takes priority
// over the `enabled` flag. The /thinking toggle is only used as a fallback
// for models without an explicit tier.
import { providerOf } from './capabilities.js'
import { PROVIDER_REASONING_PROFILES } from './catalog.js'
import type { ReasoningTierOption, ReasoningTierProfile } from './catalog.js'
import { getOpenAIChatGPTReasoningTiers, getOpenAIChatGPTRuntimeModel } from './openai-chatgpt-models.js'

/** Whether the model exposes a granular reasoning-effort tier (vs. the
 *  binary /thinking toggle). A provider has tiers but only some of its
 *  model families honor them — modelPattern in PROVIDER_REASONING_TIERS
 *  gates that. Drives both the /model tier picker and the effort branch
 *  in getReasoningLevel. */
function getReasoningTierProfile(modelId: string): ReasoningTierProfile | undefined {
  return PROVIDER_REASONING_PROFILES[providerOf(modelId)]?.find(
    (profile) => !profile.modelPattern || profile.modelPattern.test(modelId),
  )
}

/** Some fixed-reasoning xAI models reject the effort field entirely. The
 * public grok-4.20 alias is not recognized by the SDK's equivalent guard. */
export function acceptsReasoningControl(modelId: string): boolean {
  if (providerOf(modelId) !== 'xai') return true
  const providerModelId = modelId.slice(modelId.indexOf(':') + 1)
  return !/^grok-4\.20(?!-multi-agent(?:$|-))/.test(providerModelId)
}

export function supportsReasoningTier(modelId: string): boolean {
  const chatGPTTiers = getOpenAIChatGPTReasoningTiers(modelId)
  if (chatGPTTiers !== undefined) return chatGPTTiers.length > 0
  return getReasoningTierProfile(modelId) !== undefined
}

export function getReasoningTierOptions(modelId: string): readonly ReasoningTierOption[] | undefined {
  const chatGPTTiers = getOpenAIChatGPTReasoningTiers(modelId)
  if (chatGPTTiers !== undefined) return chatGPTTiers
  return getReasoningTierProfile(modelId)?.options
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

/** Resolve the provider-native effort after applying model support and the
 * minimum valid effort for models that cannot turn reasoning off. */
export function getReasoningEffort(modelId: string, enabled: boolean, effort?: string): string | undefined {
  const profile = getReasoningTierProfile(modelId)
  if (!profile) return undefined
  if (effort && profile.options.some((option) => option.value === effort)) return effort
  return !enabled ? profile.offValue : undefined
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
  const chatGPTTiers = getOpenAIChatGPTReasoningTiers(modelId)

  // These providers use separate mechanisms (providerOptions / fetch shim)
  if (provider === 'alibaba' || provider === 'zhipu' || provider === 'custom' || !acceptsReasoningControl(modelId)) {
    return undefined
  }

  if (chatGPTTiers !== undefined) {
    if (chatGPTTiers.length === 0) return undefined
    const supported = chatGPTTiers.map((tier) => tier.value)
    if (effort && supported.includes(effort)) return effort as ReasoningLevel
    if (!effort && !enabled && supported.includes('none')) return 'none'
    const declaredDefault = getOpenAIChatGPTRuntimeModel(modelId)?.defaultReasoningLevel
    if (declaredDefault && supported.includes(declaredDefault)) return declaredDefault as ReasoningLevel
    return chatGPTTiers[Math.floor((chatGPTTiers.length - 1) / 2)]?.value as ReasoningLevel
  }

  const effectiveEffort = getReasoningEffort(modelId, enabled, effort)
  // DeepSeek exposes provider-native low/high/max values. Sending the
  // portable max equivalent (`xhigh`) makes the SDK map it back to `max`
  // and emit a compatibility warning, so explicit tiers travel only through
  // providerOptions.deepseek.reasoningEffort.
  if (provider === 'deepseek' && effectiveEffort) return undefined
  if (effectiveEffort) {
    return TIER_TO_REASONING[effectiveEffort] ?? (effectiveEffort as ReasoningLevel)
  }

  return enabled ? 'high' : 'none'
}

/**
 * Build provider-native reasoning options where the portable top-level
 * `reasoning` value cannot express the exact provider control.
 */
export function getThinkingProviderOptions(
  modelId: string,
  enabled: boolean,
  effort?: string,
): Record<string, Record<string, unknown>> {
  const provider = providerOf(modelId)

  switch (provider) {
    case 'deepseek':
      const deepseekEffort = getReasoningEffort(modelId, enabled, effort)
      return deepseekEffort ? { deepseek: { reasoningEffort: deepseekEffort } } : {}

    case 'alibaba':
      return { alibaba: { enableThinking: enabled } }

    case 'zhipu':
      // Binary toggle via providerOptions for models that don't use tiers.
      // Tiered models get reasoning_effort injected by the fetch shim.
      const zhipuEffort = getReasoningEffort(modelId, enabled, effort)
      if (zhipuEffort) {
        return { zhipu: { thinking: { type: 'enabled' }, reasoningEffort: zhipuEffort } }
      }
      return enabled ? { zhipu: { thinking: { type: 'enabled' } } } : { zhipu: { thinking: { type: 'disabled' } } }

    case 'anthropic':
      return effort === 'max' && getReasoningTierOptions(modelId)?.some((option) => option.value === 'max')
        ? { anthropic: { thinking: { type: 'adaptive' }, effort: 'max' } }
        : {}

    case 'openai':
      return effort === 'max' && getReasoningTierOptions(modelId)?.some((option) => option.value === 'max')
        ? { openai: { reasoningEffort: 'max' } }
        : {}

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
