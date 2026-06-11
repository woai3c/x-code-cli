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
import path from 'node:path'

import { generateText } from 'ai'

import { getAvailableProviders } from '../config/index.js'
import { createModelRegistry } from '../providers/registry.js'
import { debugLog } from '../utils.js'
import { LruCache } from '../utils/lru-cache.js'
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
  zhipu: { modelId: 'zhipu:glm-4v-flash', label: 'GLM-4V Flash' },
  alibaba: { modelId: 'alibaba:qwen-vl-plus', label: 'Qwen-VL Plus' },
  openai: { modelId: 'openai:gpt-4o-mini', label: 'GPT-4o Mini' },
  anthropic: { modelId: 'anthropic:claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  moonshotai: {
    modelId: 'moonshotai:moonshot-v1-32k-vision-preview',
    label: 'Moonshot Vision Preview',
  },
  xai: { modelId: 'xai:grok-4.3', label: 'Grok 4.3' },
}

/** Order in which we try providers when picking a vision sub-agent.
 *  Free tiers and cheap-per-image models go first; heavier flagships
 *  last. Gemini 2.5 Flash leads because its free tier is the most
 *  generous (1500/day) and the model is also the strongest at the
 *  free price point. GLM-4V-Flash is second because it's truly free
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

async function cacheKey(filePath: string, providerModelId: string): Promise<string> {
  const buffer = await fs.readFile(filePath)
  return `${providerModelId}:${buffer.length}:${buffer.subarray(0, 64).toString('base64')}`
}

/**
 * Generate a textual description of an image via the chosen sub-agent.
 * The prompt asks for both verbatim text AND visual elements (layout,
 * colors, components) — OCR alone misses the latter, so we want the
 * caption to subsume what OCR would have produced.
 */
export async function captionImage(filePath: string, sub: VisionProvider): Promise<string> {
  const key = await cacheKey(filePath, sub.modelId)
  const cached = captionCache.get(key)
  if (cached != null) {
    debugLog('vision-fallback.cache-hit', `${sub.modelId} ${path.basename(filePath)}`)
    return cached
  }

  const buffer = await fs.readFile(filePath)
  const registry = createModelRegistry()
  // The registry's languageModel() type is `${string}:${string}` but our
  // VISION_MODELS entries are typed as plain string. Cast at the boundary —
  // we control both ends and every entry is of the form "provider:model".
  const model = registry.languageModel(sub.modelId as `${string}:${string}`)

  debugLog('vision-fallback.caption', `${sub.modelId} ${path.basename(filePath)} ${buffer.length}B`)
  const { text } = await generateText({
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Describe this image in detail so a text-only AI can act on it. ' +
              'Include: (1) any visible text transcribed verbatim, ' +
              '(2) UI elements, layout, and visual hierarchy, ' +
              '(3) colors, icons, shapes, and other visual details, ' +
              '(4) inferred purpose or context. ' +
              'Be thorough and specific. Output plain text only — no markdown formatting.',
          },
          { type: 'image', image: buffer, mediaType: mediaTypeFor(filePath) },
        ],
      },
    ],
  })

  const caption = text.trim()
  captionCache.set(key, caption)
  return caption
}
