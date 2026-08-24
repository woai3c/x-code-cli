// @x-code-cli/core — Explicit vision compatibility helper
//
// Used by product surfaces that explicitly request a caption, such as tool
// image delivery. Ordinary local attachments never call this helper: they go
// only to the active vision model or stay local for OCR.
import fs from 'node:fs/promises'

import { generateText } from 'ai'
import type { LanguageModel, LanguageModelUsage } from 'ai'

import { getAvailableProviders } from '../config/index.js'
import {
  buildUnsupportedImageNotice,
  isModelAcceptedImageMime,
  normalizeImageMime,
  sniffImageMime,
} from '../providers/capabilities.js'
import { createModelRegistry } from '../providers/registry.js'
import { debugLog } from '../utils.js'
import {
  ATTACH_BYTE_BUDGET,
  MAX_EDGE_PX,
  buildImageProcessingFailureNotice,
  compressImage,
} from '../utils/image-compress.js'
import { LruCache, bufferFingerprint } from '../utils/lru-cache.js'
import { knownMediaTypeFor } from '../utils/media-type.js'
import { attributedModelId } from './usage.js'

export interface VisionProvider {
  /** Provider id, e.g. "google" / "zhipu". */
  provider: string
  /** Full <provider>:<model> id passed to the AI SDK registry. */
  modelId: string
  /** Short label for UI notices ("Gemini 2.5 Flash"). */
  label: string
}

export interface VisionUsageEvent {
  modelId: string
  usage: LanguageModelUsage
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
 *  The complete image SHA-256 is namespaced by model and prompt. */
const captionCache = new LruCache<string>({ maxEntries: 50 })

/** Cached registry + resolved model instances. The registry is expensive to
 *  create (initializes all configured provider SDK instances); caching it
 *  avoids re-allocation on every caption call in a browser-agent session
 *  where screenshots arrive every few seconds. */
let cachedRegistry: ReturnType<typeof createModelRegistry> | null = null
const resolvedModels = new Map<string, LanguageModel>()

function getVisionModel(modelId: string): LanguageModel {
  const existing = resolvedModels.get(modelId)
  if (existing) return existing
  if (!cachedRegistry) cachedRegistry = createModelRegistry()
  const model = cachedRegistry.languageModel(modelId as `${string}:${string}`)
  resolvedModels.set(modelId, model)
  return model
}

export function resetVisionModelProviders(): void {
  cachedRegistry = null
  resolvedModels.clear()
}

/** Default caption prompt asks for both verbatim text and visual elements. */
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
  opts: {
    prompt?: string
    maxOutputTokens?: number
    abortSignal?: AbortSignal
    onUsage?: (event: VisionUsageEvent) => void
  } = {},
): Promise<string> {
  const prompt = opts.prompt ?? DEFAULT_CAPTION_PROMPT
  const key = `${modelId}:${bufferFingerprint(buffer)}:${prompt}`
  const cached = captionCache.get(key)
  if (cached != null) {
    debugLog('vision-fallback.cache-hit', `${modelId} ${buffer.length}B`)
    return cached
  }

  // Compress before sending to the vision sub-agent — same budget as
  // user-attached images. The sub-agent is a cheap caption model; there's
  // no point pushing multi-MB originals through it.
  const compressed = await compressImage(buffer, mediaType, {
    byteBudget: ATTACH_BYTE_BUDGET,
    abortSignal: opts.abortSignal,
  })
  const finalBuf = compressed.data
  const finalMime = normalizeImageMime(compressed.mimeType)
  if (!isModelAcceptedImageMime(finalMime, modelId)) {
    throw new Error(buildUnsupportedImageNotice(finalMime, 'vision input', modelId))
  }
  if (
    compressed.failureReason ||
    finalBuf.length > ATTACH_BYTE_BUDGET ||
    compressed.width > MAX_EDGE_PX ||
    compressed.height > MAX_EDGE_PX
  ) {
    throw new Error(buildImageProcessingFailureNotice('vision input', compressed))
  }
  if (compressed.changed) {
    debugLog('vision-fallback.compressed', `${buffer.length}B → ${finalBuf.length}B (${finalMime})`)
  }

  const model = getVisionModel(modelId)

  debugLog('vision-fallback.caption', `${modelId} ${finalBuf.length}B`)
  const result = await generateText({
    model,
    abortSignal: opts.abortSignal,
    maxOutputTokens: opts.maxOutputTokens,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', image: finalBuf, mediaType: finalMime },
        ],
      },
    ],
  })
  opts.onUsage?.({ modelId: attributedModelId(modelId, result.response?.modelId), usage: result.usage })

  const caption = result.text.trim()
  captionCache.set(key, caption)
  return caption
}

/**
 * Generate a textual description of an image FILE via the chosen sub-agent.
 * Thin wrapper over `captionImageBuffer` that reads the file and derives the
 * media type from its extension; keeps the existing file-ingest call site
 * (and its cache key by file content) working unchanged.
 */
export async function captionImage(
  filePath: string,
  sub: VisionProvider,
  opts?: { abortSignal?: AbortSignal; onUsage?: (event: VisionUsageEvent) => void },
): Promise<string> {
  const buffer = await fs.readFile(filePath, { signal: opts?.abortSignal })
  const mediaType = (await sniffImageMime(buffer)) ?? knownMediaTypeFor(filePath)
  if (!mediaType?.startsWith('image/')) throw new Error('Unsupported or unrecognized image format')
  return captionImageBuffer(buffer, mediaType, sub.modelId, {
    abortSignal: opts?.abortSignal,
    onUsage: opts?.onUsage,
  })
}
