// @x-code-cli/core — Per-provider extended-thinking / reasoning toggle
//
// Each provider exposes a different switch for "spend extra tokens reasoning
// before producing output". The defaults across the eight providers we
// support are inconsistent: Gemini and Kimi default ON; Claude Sonnet,
// DeepSeek V4, Qwen, and most others default OFF; GPT-4.1/5.5 and
// Grok-4.3 have no thinking concept at all on those exact model ids.
// The user-facing `/thinking on|off` toggle is meant to give one uniform
// knob across all of them.
//
// We map the toggle to the closest equivalent in each provider's AI SDK:
//
//   anthropic   thinking: { type: 'enabled' | 'disabled', budgetTokens }
//   deepseek    thinking: { type: 'enabled' | 'disabled' }
//   moonshotai  thinking: { type: 'enabled' | 'disabled' }
//   alibaba     enableThinking: boolean
//   google      thinkingConfig: { thinkingBudget: -1 (dynamic) | 0 (off) }
//   xai         reasoningEffort: 'high' | 'low'         (grok-3-mini only)
//   openai      reasoningEffort: 'high' | 'minimal'      (o-series only)
//   zhipu       thinking: { type: 'enabled' | 'disabled' } (GLM-5/5.1;
//                 GLM-4-Plus ignores it silently)
//
// The numeric budget for Anthropic is set generous-but-not-unbounded:
// 8000 reasoning tokens covers everything short of the longest agent loops
// and stays well under the 1M context window budget. Users on Opus who want
// a wider budget can edit this and rebuild — exposing a `budget` slash arg
// is over-engineering for a feature most users will leave at "on" or "off".
import { providerOf } from './capabilities.js'

const ANTHROPIC_BUDGET_TOKENS = 8000

/**
 * Build the `providerOptions` entry needed to put the given model into the
 * desired thinking state. Returns an empty object when the model has no
 * thinking knob (so callers can spread/merge unconditionally).
 *
 * `enabled` semantics:
 *   true  — opt INTO maximum reasoning the provider supports
 *   false — opt OUT (or pin to a low/disabled mode where the provider
 *           defaults to thinking-on and forces some always-on minimum,
 *           e.g. Gemini 2.5 Pro can't go below 128 tokens — we still
 *           ask for the lowest the SDK accepts)
 */
export function getThinkingProviderOptions(modelId: string, enabled: boolean): Record<string, Record<string, unknown>> {
  const provider = providerOf(modelId)
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
      // kimi-k2.5 is a thinking model by default; explicit `disabled`
      // turns reasoning off on the provider side.
      return enabled
        ? { moonshotai: { thinking: { type: 'enabled' } } }
        : { moonshotai: { thinking: { type: 'disabled' } } }

    case 'alibaba':
      // Hybrid Qwen ids honour `enableThinking` per-request; the
      // dedicated reasoning ids (qwq-plus, qwen3-*-thinking-*) ignore
      // an `enableThinking: false` request and keep thinking on.
      return { alibaba: { enableThinking: enabled } }

    case 'google':
      // Gemini 2.5 Pro can't be fully turned off (min budget 128) — we
      // still send `thinkingBudget: 0` for OFF and let the SDK clamp;
      // 2.5 Flash and Lite respect 0 as "no thinking". `-1` is the SDK's
      // sentinel for "dynamic budget — model decides", which is what
      // Pro uses by default and what we want for ON anywhere.
      return enabled
        ? { google: { thinkingConfig: { thinkingBudget: -1 } } }
        : { google: { thinkingConfig: { thinkingBudget: 0 } } }

    case 'xai':
      // Only grok-3-mini and grok-4-mini honour `reasoningEffort`; grok-3
      // and grok-4 ignore it. Sending the option is harmless on the
      // ignoring models — the SDK passes it through and the API silently
      // discards it.
      return enabled ? { xai: { reasoningEffort: 'high' } } : { xai: { reasoningEffort: 'low' } }

    case 'openai':
      // Only o-series and gpt-5 reasoning models use `reasoningEffort`;
      // gpt-4.1 ignores it. Same harmless pass-through as xAI.
      return enabled ? { openai: { reasoningEffort: 'high' } } : { openai: { reasoningEffort: 'minimal' } }

    case 'zhipu':
      // GLM-5/5.1 support thinking via the same pattern as DeepSeek;
      // GLM-4-Plus does not. Sending the option is harmless on the
      // non-supporting models — the API silently ignores it.
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
