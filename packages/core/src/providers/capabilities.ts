// @x-code-cli/core — Provider multi-modal capability table
//
// Image capabilities drive model delivery. Legacy PDF/audio/file fields stay
// in the public type for compatibility but have no ingestion consumers.
//
// Provider capabilities describe the wire API. modelSupportsVision applies
// the curated per-model flag on top, so text-only Qwen/GLM variants still
// downgrade images even though their provider accepts multimodal content.
import { getOpenAIAuthContext } from '../auth/openai-chatgpt/auth-resolver.js'
import { MODEL_ALIASES } from './catalog.js'
import { getOpenAIChatGPTRuntimeModel, getProviderModels } from './openai-chatgpt-models.js'

export interface ProviderCapabilities {
  /** Provider can receive inline image parts (base64 or URL) in user messages. */
  image: boolean
  /** @deprecated File ingestion always processes PDFs locally. */
  pdf: boolean
  /** @deprecated File ingestion always transcribes audio locally. */
  audio: boolean
  /** @deprecated Generic file upload is not used by the ingestion pipeline. */
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
  anthropic: { image: true, pdf: true, audio: false, filesApi: true, toolImageTransport: 'tool-result' },
  openai: { image: true, pdf: true, audio: true, filesApi: true, toolImageTransport: 'tool-result' },
  google: { image: true, pdf: true, audio: true, filesApi: true, toolImageTransport: 'tool-result' },
  xai: { image: true, pdf: true, audio: false, filesApi: true, toolImageTransport: 'user-message' },
  moonshotai: { image: true, pdf: true, audio: false, filesApi: true, toolImageTransport: 'user-message' },
  alibaba: { image: true, pdf: true, audio: false, filesApi: true, toolImageTransport: 'user-message' },
  zhipu: { image: true, pdf: true, audio: false, filesApi: true, toolImageTransport: 'user-message' },
  deepseek: { image: false, pdf: false, audio: false, filesApi: false, toolImageTransport: 'unsupported' },
  custom: { image: false, pdf: false, audio: false, filesApi: false, toolImageTransport: 'unsupported' },
}

const NO_CAPABILITIES: ProviderCapabilities = {
  image: false,
  pdf: false,
  audio: false,
  filesApi: false,
  toolImageTransport: 'unsupported',
}

// ── Image format policy (session-poisoning defense) ───────────────────────
//
// Providers differ on both MIME and animation support. An unsupported part
// (including a valid-but-animated GIF where only static GIF is documented)
// is rejected with a 400 —
// and because messages persist in the session, every subsequent request
// fails too (Kimi CLI's image-format-policy calls this "session poisoning").
// These closed policies are the single source of truth; file-ingest gates at
// ingestion and the agent loop strips on a 400 so a bad image can never
// wedge a session. A new format is only ever sent once added here.

interface ImageFormatPolicy {
  mimes: ReadonlySet<string>
  animatedMimes: ReadonlySet<string>
}

const DEFAULT_IMAGE_POLICY: ImageFormatPolicy = {
  mimes: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  animatedMimes: new Set(),
}
const PROVIDER_IMAGE_POLICIES: Readonly<Record<string, ImageFormatPolicy>> = {
  alibaba: { mimes: new Set(['image/png', 'image/jpeg', 'image/webp']), animatedMimes: new Set() },
  xai: { mimes: new Set(['image/png', 'image/jpeg']), animatedMimes: new Set() },
}

/** Lowercase, drop MIME parameters, apply the `image/jpg` alias. */
export function normalizeImageMime(mime: string): string {
  const base = (mime.split(';', 1)[0] ?? '').trim().toLowerCase()
  return base === 'image/jpg' ? 'image/jpeg' : base
}

function imagePolicy(modelId?: string): ImageFormatPolicy {
  if (!modelId) return DEFAULT_IMAGE_POLICY
  const resolved = MODEL_ALIASES[modelId] ?? modelId
  return PROVIDER_IMAGE_POLICIES[providerOf(resolved)] ?? DEFAULT_IMAGE_POLICY
}

export function isModelAcceptedImageMime(mime: string, modelId?: string): boolean {
  return imagePolicy(modelId).mimes.has(normalizeImageMime(mime))
}

export function isModelAcceptedImage(mime: string, options: { modelId?: string; animated?: boolean } = {}): boolean {
  const normalized = normalizeImageMime(mime)
  const policy = imagePolicy(options.modelId)
  return policy.mimes.has(normalized) && (!options.animated || policy.animatedMimes.has(normalized))
}

/** Sniff the real MIME from magic bytes; null when unrecognized. Bytes are
 *  authoritative — a mislabeled file (AVIF renamed to .png) must be judged
 *  by what it IS, because the provider decodes bytes, not filenames. */
export async function sniffImageMime(buffer: Buffer): Promise<string | null> {
  try {
    const { fileTypeFromBuffer } = await import('file-type')
    const detected = await fileTypeFromBuffer(buffer)
    return detected?.mime ?? null
  } catch {
    return null
  }
}

/** Text notice standing in for a refused / stripped image so the model knows
 *  what happened and the session history stays free of parts the provider
 *  rejects. */
export function buildUnsupportedImageNotice(mime: string, name?: string, modelId?: string, animated = false): string {
  const kind = animated ? `animated ${mime}` : `unsupported image format ${mime}`
  const what = name ? `"${name}" uses ${kind}` : kind
  const policy = imagePolicy(modelId)
  const formats = [...policy.mimes]
    .map((value) => {
      const label = value.slice('image/'.length).replace('jpeg', 'JPEG').toUpperCase()
      return value === 'image/gif' && !policy.animatedMimes.has(value) ? `${label} (non-animated)` : label
    })
    .join(', ')
  return `[Image omitted: ${what}. The current model accepts only ${formats} — convert it to PNG or JPEG and try again.]`
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
  if (getOpenAIAuthContext().mode === 'chatgpt' && resolved.startsWith('openai:')) {
    return getOpenAIChatGPTRuntimeModel(resolved)?.vision ?? false
  }
  for (const models of Object.values(getProviderModels())) {
    for (const m of models) {
      if (m.id === resolved) return m.vision
    }
  }
  return capabilitiesOf(resolved).image
}
