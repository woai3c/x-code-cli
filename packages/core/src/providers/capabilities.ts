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

export interface ProviderCapabilities {
  /** Provider can receive inline image parts (base64 or URL) in user messages. */
  image: boolean
  /** Provider can receive inline PDF file parts. */
  pdf: boolean
  /** Provider has a dedicated /files upload endpoint (file_id references). */
  filesApi: boolean
}

const CAPS: Record<string, ProviderCapabilities> = {
  anthropic: { image: true, pdf: true, filesApi: true },
  openai: { image: true, pdf: true, filesApi: true },
  google: { image: true, pdf: true, filesApi: true },
  xai: { image: true, pdf: true, filesApi: true },
  moonshotai: { image: true, pdf: true, filesApi: true },
  alibaba: { image: true, pdf: true, filesApi: true },
  zhipu: { image: true, pdf: true, filesApi: true },
  deepseek: { image: false, pdf: false, filesApi: false },
  // Custom OpenAI-compatible endpoints are conservative-by-default —
  // users who know their endpoint supports vision can override via env
  // (X_CODE_CUSTOM_SUPPORTS_IMAGE=1) if we ever add that.
  custom: { image: false, pdf: false, filesApi: false },
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
  return CAPS[providerOf(modelId)] ?? { image: false, pdf: false, filesApi: false }
}
