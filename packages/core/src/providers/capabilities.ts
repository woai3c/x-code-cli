// @x-code-cli/core — Provider multi-modal capability table
//
// Declares whether each provider's API can natively accept image / pdf
// content parts in user messages and tool results. Used by the file-ingest
// pipeline (to decide inline-vs-OCR) and provider-compat (to strip binary
// parts before sending to providers that would reject them).
//
// Provider capabilities describe the wire API. modelSupportsVision applies
// the curated per-model flag on top, so text-only Qwen/GLM variants still
// downgrade images even though their provider accepts multimodal content.
import { MODEL_ALIASES, PROVIDER_MODELS } from '../types/index.js'

export interface ProviderCapabilities {
  /** Provider can receive inline image parts (base64 or URL) in user messages. */
  image: boolean
  /** Provider can receive inline PDF file parts. */
  pdf: boolean
  /** Provider has a dedicated /files upload endpoint (file_id references). */
  filesApi: boolean
  /** How images returned by tools must be represented on this provider.
   *
   *  `tool-result`: the provider SDK preserves image content inside the tool
   *  result (Anthropic, OpenAI Responses, Gemini).
   *  `user-message`: the Chat Completions tool role is text-only, so keep the
   *  tool result textual and attach the image in a following user message.
   *  `unsupported`: the provider cannot receive images at all. */
  toolImageTransport: 'tool-result' | 'user-message' | 'unsupported'
}

const CAPS: Record<string, ProviderCapabilities> = {
  anthropic: { image: true, pdf: true, filesApi: true, toolImageTransport: 'tool-result' },
  openai: { image: true, pdf: true, filesApi: true, toolImageTransport: 'tool-result' },
  google: { image: true, pdf: true, filesApi: true, toolImageTransport: 'tool-result' },
  xai: { image: true, pdf: true, filesApi: true, toolImageTransport: 'user-message' },
  moonshotai: { image: true, pdf: true, filesApi: true, toolImageTransport: 'user-message' },
  alibaba: { image: true, pdf: true, filesApi: true, toolImageTransport: 'user-message' },
  zhipu: { image: true, pdf: true, filesApi: true, toolImageTransport: 'user-message' },
  deepseek: { image: false, pdf: false, filesApi: false, toolImageTransport: 'unsupported' },
  // Custom OpenAI-compatible endpoints are conservative-by-default —
  // users who know their endpoint supports vision can override via env
  // (X_CODE_CUSTOM_SUPPORTS_IMAGE=1) if we ever add that.
  custom: { image: false, pdf: false, filesApi: false, toolImageTransport: 'unsupported' },
}

const NO_CAPABILITIES: ProviderCapabilities = {
  image: false,
  pdf: false,
  filesApi: false,
  toolImageTransport: 'unsupported',
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
  return CAPS[providerOf(modelId)] ?? NO_CAPABILITIES
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
