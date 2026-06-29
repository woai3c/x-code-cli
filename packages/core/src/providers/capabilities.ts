// @x-code-cli/core — Provider multi-modal capability table
//
// Declares whether each provider's API can natively accept image / pdf
// content parts in user messages and tool results. Used by the file-ingest
// pipeline (to decide inline-vs-OCR) and provider-compat (to strip binary
// parts before sending to providers that would reject them).
//
// Provider-level, not model-level. Some providers (alibaba, zhipu) have
// separate vision-only model ids — users who pick a text-only Qwen/GLM
// variant and paste an image will still get API errors. That's a deliberate
// simplification: model-level capability tracking would require per-id
// tables that go stale quickly.
import { MODEL_ALIASES, PROVIDER_MODELS } from '../types/index.js'

export interface ProviderCapabilities {
  /** Provider can receive inline image parts (base64 or URL) in user messages. */
  image: boolean
  /** Provider can receive inline PDF file parts. */
  pdf: boolean
  /** Provider has a dedicated /files upload endpoint (file_id references). */
  filesApi: boolean
  /** Provider's API can carry image parts INSIDE tool-result messages (not just
   *  user messages). Only Anthropic does this cleanly: OpenAI Chat Completions
   *  — and therefore every OpenAI-compatible provider (DeepSeek / Moonshot /
   *  Alibaba / Zhipu / xAI / custom) — `JSON.stringify`s tool-result content,
   *  which turns an image part into a base64 STRING the model can't see and
   *  that explodes the token count (a 1 MB PNG ≈ 400k text tokens). Google's
   *  functionResponse is JSON-only too. So a screenshot returned from an MCP
   *  tool must be captioned to text for everyone except Anthropic — see
   *  tool-execution.ts `deliverToolImages`. */
  toolResultImage: boolean
}

const CAPS: Record<string, ProviderCapabilities> = {
  anthropic: { image: true, pdf: true, filesApi: true, toolResultImage: true },
  openai: { image: true, pdf: true, filesApi: true, toolResultImage: false },
  google: { image: true, pdf: true, filesApi: true, toolResultImage: false },
  xai: { image: true, pdf: true, filesApi: true, toolResultImage: false },
  moonshotai: { image: true, pdf: true, filesApi: true, toolResultImage: false },
  alibaba: { image: true, pdf: true, filesApi: true, toolResultImage: false },
  zhipu: { image: true, pdf: true, filesApi: true, toolResultImage: false },
  deepseek: { image: false, pdf: false, filesApi: false, toolResultImage: false },
  // Custom OpenAI-compatible endpoints are conservative-by-default —
  // users who know their endpoint supports vision can override via env
  // (X_CODE_CUSTOM_SUPPORTS_IMAGE=1) if we ever add that.
  custom: { image: false, pdf: false, filesApi: false, toolResultImage: false },
}

/** Extract `provider` from a `provider:model` id. Returns `unknown` if the
 *  separator is missing (defensive — shouldn't happen with resolved ids). */
export function providerOf(modelId: string): string {
  const idx = modelId.indexOf(':')
  return idx > 0 ? modelId.slice(0, idx) : 'unknown'
}

/** Look up capabilities for a model id. Unknown providers default to text-only
 *  — safer than assuming vision support. */
export function capabilitiesOf(modelId: string): ProviderCapabilities {
  return CAPS[providerOf(modelId)] ?? { image: false, pdf: false, filesApi: false, toolResultImage: false }
}

/** Can this specific MODEL natively see images? Unlike `capabilitiesOf` (which
 *  is provider-level — "does the API accept image parts"), this is per-model,
 *  because providers mix vision and text-only models under one id namespace
 *  (Qwen-VL vs Qwen-Max, GLM-4V vs GLM-5, kimi-k2.6 is multimodal but a plain
 *  DeepSeek is not). Used to gate the browser agent's `--caps vision` so a
 *  text-only model never gets screenshots it can't read.
 *
 *  Resolution: alias-expand, look the id up in the curated catalog and trust
 *  its explicit `vision` flag. For ids NOT in the catalog (user typed a custom
 *  variant), fall back to the provider-level image capability — permissive, so
 *  we don't block a vision model just because it isn't listed. */
export function modelSupportsVision(modelId: string): boolean {
  const resolved = MODEL_ALIASES[modelId] ?? modelId
  for (const models of Object.values(PROVIDER_MODELS)) {
    for (const m of models) {
      if (m.id === resolved) return m.vision
    }
  }
  return capabilitiesOf(resolved).image
}
