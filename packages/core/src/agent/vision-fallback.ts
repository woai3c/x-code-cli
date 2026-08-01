// @x-code-cli/core — Vision sub-agent for text-only providers
//
// When the user attaches an image but the active model can't natively see
// images (DeepSeek today, custom by default), automatically borrow any
// other configured provider that DOES have a vision model and use it as
// a caption sub-agent. The caption is injected as a TextPart into the
// user message so the main model sees a description without ever
// receiving the binary.
//
// Why this exists: DeepSeek users were stuck with local tesseract OCR,
// which is fine for code screenshots but useless for UI mockups, diagrams,
// or photos. Most users who set up DeepSeek also have a key for at least
// one free-tier provider (Gemini or GLM-4V-Flash); detecting that and
// reusing it removes the need for a manual /model switch every time the
// user pastes a screenshot.
import fs from 'node:fs/promises'

import { generateText } from 'ai'

import { getAvailableProviders } from '../config/index.js'
import { createModelRegistry } from '../providers/registry.js'
import { debugLog } from '../utils.js'
import { ATTACH_BYTE_BUDGET, compressImage } from '../utils/image-compress.js'
import { LruCache, bufferFingerprint } from '../utils/lru-cache.js'
import { mediaTypeFor } from '../utils/media-type.js'

export interface VisionProvider {
  /** Provider id, e.g. "google" / "zhipu". */
  provider: string
  /** Full <provider>:<model> id passed to the AI SDK registry. */
  modelId: string
  /** Short label for UI notices ("Gemini 2.5 Flash"). */
  label: string
}

/** Vision-capable model id + display label per provider. Models picked to
 *  favor cheap / free-tier offerings — the goal is a quick caption, not
 *  deep analysis. */
const VISION_MODELS: Record<string, { modelId: string; label: string }> = {
  google: { modelId: 'google:gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  zhipu: { modelId: 'zhipu:glm-4.6v', label: 'GLM-4.6V' },
  alibaba: { modelId: 'alibaba:qwen3-vl-flash', label: 'Qwen3-VL Flash' },
  openai: { modelId: 'openai:gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  anthropic: { modelId: 'anthropic:claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  moonshotai: { modelId: 'moonshotai:kimi-k2.6', label: 'Kimi K2.6' },
  xai: { modelId: 'xai:grok-4.3', label: 'Grok 4.3' },
}

/** Order in which we try providers when picking a vision sub-agent.
 *  Free tiers and cheap-per-image models go first; heavier flagships
 *  last. Gemini 2.5 Flash leads because its free tier is the most
 *  generous (1500/day) and the model is also the strongest at the
 *  free price point. GLM-4.6V is second because it's cheap/free
 *  and reachable from China without a proxy. */
const VISION_PRIORITY = ['google', 'zhipu', 'alibaba', 'openai', 'anthropic', 'moonshotai', 'xai']

/**
 * Pick the best available vision sub-agent given the keys the user has
 * configured. Returns null if no vision-capable provider has a key —
 * caller should fall back to local OCR.
 */
export function pickVisionProvider(): VisionProvider | null {
  const available = new Set(getAvailableProviders())
  for (const provider of VISION_PRIORITY) {
    if (!available.has(provider)) continue
    const model = VISION_MODELS[provider]
    if (!model) continue
    return { provider, modelId: model.modelId, label: model.label }
  }
  return null
}

/** In-memory cache so re-attaching the same image (or the same image across
 *  multiple submits in one session) doesn't re-burn tokens on the sub-agent.
 *  Keyed by `${providerId}:${file size}:${first-64-bytes-base64}` — same
 *  cheap collision-resistant key strategy provider-compat.ts uses for OCR. */
const captionCache = new LruCache<string>({ maxEntries: 50 })

/** Default caption prompt: asks for both verbatim text AND visual elements
 *  (layout, colors, components) — OCR alone misses the latter, so the caption
 *  subsumes what OCR would have produced. Used for pasted-image ingest. */
const DEFAULT_CAPTION_PROMPT =
  'Describe this image in detail so a text-only AI can act on it. ' +
  'Include: (1) any visible text transcribed verbatim, ' +
  '(2) UI elements, layout, and visual hierarchy, ' +
  '(3) colors, icons, shapes, and other visual details, ' +
  '(4) inferred purpose or context. ' +
  'Be thorough and specific. Output plain text only — no markdown formatting.'

/**
 * Caption an in-memory image buffer via the chosen vision model. Lower-level
 * sibling of `captionImage` (which reads a file then delegates here). Used by
 * the MCP tool-result path to turn browser screenshots into text for providers
 * whose tool-result channel can't carry a real image (see
 * capabilities.toolImageTransport). `prompt` overrides the default caption
 * instruction so callers can ask for, e.g., pixel coordinates.
 */
export async function captionImageBuffer(
  buffer: Buffer,
  mediaType: string,
  modelId: string,
  opts: { prompt?: string; abortSignal?: AbortSignal } = {},
): Promise<string> {
  const key = `${modelId}:${bufferFingerprint(buffer)}`
  const cached = captionCache.get(key)
  if (cached != null) {
    debugLog('vision-fallback.cache-hit', `${modelId} ${buffer.length}B`)
    return cached
  }

  // Compress before sending to the vision sub-agent — same budget as
  // user-attached images. The sub-agent is a cheap caption model; there's
  // no point pushing multi-MB originals through it.
  const compressed = await compressImage(buffer, mediaType, { byteBudget: ATTACH_BYTE_BUDGET })
  const finalBuf = compressed.data
  const finalMime = compressed.changed ? compressed.mimeType : mediaType
  if (compressed.changed) {
    debugLog('vision-fallback.compressed', `${buffer.length}B → ${finalBuf.length}B (${finalMime})`)
  }

  const registry = createModelRegistry()
  const model = registry.languageModel(modelId as `${string}:${string}`)

  debugLog('vision-fallback.caption', `${modelId} ${finalBuf.length}B`)
  const { text } = await generateText({
    model,
    abortSignal: opts.abortSignal,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: opts.prompt ?? DEFAULT_CAPTION_PROMPT },
          { type: 'image', image: finalBuf, mediaType: finalMime },
        ],
      },
    ],
  })

  const caption = text.trim()
  captionCache.set(key, caption)
  return caption
}

/**
 * Generate a textual description of an image FILE via the chosen sub-agent.
 * Thin wrapper over `captionImageBuffer` that reads the file and derives the
 * media type from its extension; keeps the existing file-ingest call site
 * (and its cache key by file content) working unchanged.
 */
export async function captionImage(filePath: string, sub: VisionProvider): Promise<string> {
  const buffer = await fs.readFile(filePath)
  return captionImageBuffer(buffer, mediaTypeFor(filePath), sub.modelId)
}
