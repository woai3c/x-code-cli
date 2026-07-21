// @x-code-cli/core — Per-provider extended-thinking / reasoning toggle
//
// Each provider exposes a different switch for "spend extra tokens reasoning
// before producing output". The defaults across the eight providers we
// support are inconsistent: Gemini defaults ON; Claude Sonnet, DeepSeek V4,
// Qwen, and most others default OFF.
// The user-facing `/thinking on|off` toggle is meant to give one uniform
// knob across all of them.
//
// We map the toggle to the closest equivalent in each provider's AI SDK:
//
//   anthropic   thinking: { type: 'enabled' | 'disabled', budgetTokens }  (binary)
//              effort: 'low' | 'medium' | 'high'                          (tier)
//   deepseek    thinking: { type: 'enabled' | 'disabled' }
//   moonshotai  thinking: { type: 'enabled' | 'disabled' }               (K2.x, binary)
//              reasoningEffort: 'low' | 'high' | 'max'                   (K3, tier)
//   alibaba     enableThinking: boolean
//   google      thinkingConfig: { thinkingBudget: -1 | 0 }               (Gemini 2.5, binary)
//              thinkingConfig: { thinkingLevel: 'LOW' | 'HIGH' }          (Gemini 3, tier)
//   xai         reasoningEffort: 'high' | 'low'                           (binary)
//              reasoningEffort: 'low' | 'high'                            (tier)
//   openai      reasoningEffort: 'high' | 'minimal'                      (binary)
//              reasoningEffort: 'minimal' | 'low' | 'medium' | 'high'    (tier)
//   zhipu       thinking: { type: 'enabled' | 'disabled' } (GLM-5/5.2;
//                 GLM-4-Plus ignores it silently)
//
// The numeric budget for Anthropic is set generous-but-not-unbounded:
// 8000 reasoning tokens covers everything short of the longest agent loops
// and stays well under the 1M context window budget. Users on Opus who want
// a wider budget can edit this and rebuild — exposing a `budget` slash arg
// is over-engineering for a feature most users will leave at "on" or "off".
import { PROVIDER_REASONING_TIERS } from '../types/index.js'
import { providerOf } from './capabilities.js'

const ANTHROPIC_BUDGET_TOKENS = 8000

/** Whether the model exposes a granular reasoning-effort tier (vs. the
 *  binary /thinking toggle). A provider has tiers but only some of its
 *  model families honor them (thinkingLevel is Gemini 3-only, Kimi's
 *  reasoningEffort is K3-only) — modelPattern in PROVIDER_REASONING_TIERS
 *  gates that. Drives both the /model tier picker and the effort branch
 *  in getThinkingProviderOptions. */
export function supportsReasoningTier(modelId: string): boolean {
  const config = PROVIDER_REASONING_TIERS[providerOf(modelId)]
  if (!config) return false
  return !config.modelPattern || config.modelPattern.test(modelId)
}

/**
 * Build the `providerOptions` entry needed to put the given model into the
 * desired thinking state. Returns an empty object when the model has no
 * thinking knob (so callers can spread/merge unconditionally).
 *
 * When `effort` is set (user picked a tier via /model), it takes priority
 * over the `enabled` flag — tier is the user's explicit choice. The /thinking
 * toggle is only used as a fallback for models without an explicit tier.
 *
 * `enabled` semantics (tier-less fallback):
 *   true  — opt INTO maximum reasoning the provider supports
 *   false — opt OUT (or pin to a low/disabled mode where the provider
 *           defaults to thinking-on and forces some always-on minimum,
 *           e.g. Gemini 2.5 Pro can't go below 128 tokens — we still
 *           ask for the lowest the SDK accepts)
 *
 * `effort` semantics (tiered model):
 *   For providers with granular reasoning control (OpenAI, Anthropic, Google,
 *   xAI, Moonshot), the effort string is mapped to the corresponding AI SDK key.
 *   Providers without tier support (deepseek, alibaba, zhipu)
 *   ignore `effort` and always use the binary `enabled` toggle.
 */
export function getThinkingProviderOptions(
  modelId: string,
  enabled: boolean,
  effort?: string,
): Record<string, Record<string, unknown>> {
  const provider = providerOf(modelId)

  // Tiered reasoning — user picked an explicit effort level AND the model
  // honors it. A stored tier for a model outside the tier's modelPattern
  // (e.g. kimi-k2.6, gemini-2.5-pro) falls through to the binary toggle so
  // /thinking keeps working there.
  if (effort && supportsReasoningTier(modelId)) {
    switch (provider) {
      case 'openai':
        return { openai: { reasoningEffort: effort } }
      case 'anthropic':
        return { anthropic: { effort } }
      case 'google':
        return { google: { thinkingConfig: { thinkingLevel: effort.toUpperCase() } } }
      case 'xai':
        return { xai: { reasoningEffort: effort } }
      case 'moonshotai':
        // Kimi K3 uses the top-level `reasoning_effort` field (low/high/max).
        return { moonshotai: { reasoningEffort: effort } }
      default:
        break
    }
  }

  // Binary /thinking toggle (no explicit tier, or provider without tiers).
  switch (provider) {
    case 'anthropic':
      return enabled
        ? { anthropic: { thinking: { type: 'enabled', budgetTokens: ANTHROPIC_BUDGET_TOKENS } } }
        : { anthropic: { thinking: { type: 'disabled' } } }

    case 'deepseek':
      // V4 family supports the toggle; the legacy `deepseek-chat` /
      // `deepseek-reasoner` ids ignore unknown providerOptions silently.
      return enabled
        ? { deepseek: { thinking: { type: 'enabled' } } }
        : { deepseek: { thinking: { type: 'disabled' } } }

    case 'moonshotai':
      return enabled
        ? { moonshotai: { thinking: { type: 'enabled' } } }
        : { moonshotai: { thinking: { type: 'disabled' } } }

    case 'alibaba':
      return { alibaba: { enableThinking: enabled } }

    case 'google':
      return enabled
        ? { google: { thinkingConfig: { thinkingBudget: -1 } } }
        : { google: { thinkingConfig: { thinkingBudget: 0 } } }

    case 'xai':
      return enabled ? { xai: { reasoningEffort: 'high' } } : { xai: { reasoningEffort: 'low' } }

    case 'openai':
      return enabled ? { openai: { reasoningEffort: 'high' } } : { openai: { reasoningEffort: 'minimal' } }

    case 'zhipu':
      return enabled ? { zhipu: { thinking: { type: 'enabled' } } } : { zhipu: { thinking: { type: 'disabled' } } }

    case 'custom':
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
