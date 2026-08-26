// @x-code-cli/core — Provider-specific compatibility shims
import type { ModelMessage } from 'ai'

import {
  buildUnsupportedImageNotice,
  capabilitiesOf,
  isModelAcceptedImage,
  isModelAcceptedImageMime,
  modelSupportsVision,
  normalizeImageMime,
  sniffImageMime,
} from '../providers/capabilities.js'
import { truncateUtf8 } from '../utils.js'
import {
  ATTACH_BYTE_BUDGET,
  MAX_EDGE_PX,
  buildImageProcessingFailureNotice,
  compressImage,
} from '../utils/image-compress.js'
import { LruCache, bufferFingerprint } from '../utils/lru-cache.js'
import { ocrImage } from './image-ocr.js'
import { toolMediaUserMessage } from './messages.js'
import type { ToolImage } from './messages.js'

// ── Image/PDF downgrade for text-only providers ───────────────────────────
//
// If the active provider can't receive image/file parts (DeepSeek today,
// plus `custom` unless the user opts in), walk every message that would be
// sent on the next turn and replace each binary part with something the
// provider CAN accept.
//
// Two flavors:
//   - User messages: ImagePart / FilePart → TextPart with OCR'd text.
//   - Tool result messages: `content` value array with tagged image `file`
//     entries (plus legacy `image-data`) → same content array but with image entries replaced by
//     `text` entries (OCR'd).
//
// OCR runs locally via tesseract.js. Results are memoized by a content
// hash so repeatedly sending the same image across turns doesn't re-run
// OCR on every turn.

type MaybeOutput = { type?: string; value?: unknown; filename?: string }

interface ToolContentEntry {
  type?: string
  data?: string | { type?: string; data?: unknown }
  mediaType?: string
  text?: string
  filename?: string
  [key: string]: unknown
}

function isToolImageEntry(entry: ToolContentEntry): boolean {
  if (entry.type === 'file') {
    const mediaType = entry.mediaType?.toLowerCase() ?? ''
    return mediaType === 'image' || mediaType.startsWith('image/')
  }
  return entry.type === 'image-data' || (entry.type === 'media' && (entry.mediaType?.startsWith('image/') ?? false))
}

function toolImageBase64(entry: ToolContentEntry): string | undefined {
  if (entry.type === 'file') {
    if (typeof entry.data === 'string') return entry.data
    return entry.data?.type === 'data' && typeof entry.data.data === 'string' ? entry.data.data : undefined
  }
  return typeof entry.data === 'string' ? entry.data : undefined
}

function withToolImageData(
  entry: ToolContentEntry,
  data: string,
  mediaType: string,
  filename?: string,
): ToolContentEntry {
  return entry.type === 'file'
    ? { ...entry, data: { type: 'data', data }, mediaType, filename }
    : { ...entry, data, mediaType, filename }
}

/**
 * Move image parts out of tool results for multimodal Chat Completions
 * providers. Their `tool` role accepts only text, while the following `user`
 * role accepts typed image content. This also catches AI-SDK auto-executed
 * tools such as readFile, which bypass deliverToolImages.
 *
 * Images from one contiguous tool-result group become one user message after
 * the whole group, preserving strict assistant -> all tool results ordering.
 * Returns a request-only projection without mutating canonical history, so
 * stale screenshot pruning can still remove old binary payloads.
 */
export function reattachToolResultImagesForProvider(messages: ModelMessage[], modelId: string): ModelMessage[] {
  const caps = capabilitiesOf(modelId)
  if (caps.toolImageTransport !== 'user-message' || !caps.image || !modelSupportsVision(modelId)) {
    return messages
  }

  const rewritten: ModelMessage[] = []
  let pendingImages: ToolImage[] = []
  let movedAny = false

  const flushImages = () => {
    if (pendingImages.length === 0) return
    rewritten.push(toolMediaUserMessage(pendingImages))
    pendingImages = []
  }

  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) {
      flushImages()
      rewritten.push(message)
      continue
    }

    let changed = false
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result') return part
      const output = (part as { output?: MaybeOutput }).output
      if (!output || output.type !== 'content' || !Array.isArray(output.value)) return part

      const retained: unknown[] = []
      for (const entry of output.value as ToolContentEntry[]) {
        const data = toolImageBase64(entry)
        if (isToolImageEntry(entry) && data && typeof entry.mediaType === 'string') {
          pendingImages.push({ data, mediaType: entry.mediaType })
          movedAny = true
        } else {
          retained.push(entry)
        }
      }

      if (retained.length === output.value.length) return part
      changed = true
      let nextOutput: MaybeOutput
      if (
        retained.length > 0 &&
        retained.every(
          (entry) => typeof entry === 'object' && entry !== null && (entry as { type?: string }).type === 'text',
        )
      ) {
        nextOutput = {
          ...output,
          type: 'text',
          value: retained
            .map((entry) => (entry as { text?: string }).text ?? '')
            .filter(Boolean)
            .join('\n'),
        }
      } else if (retained.length > 0) {
        nextOutput = { ...output, value: retained }
      } else {
        nextOutput = {
          ...output,
          type: 'text',
          value: '[Tool returned media attached in the following message]',
        }
      }
      return { ...part, output: nextOutput }
    })

    rewritten.push(changed ? ({ ...message, content } as ModelMessage) : message)
  }

  flushImages()
  return movedAny ? rewritten : messages
}

const ocrCache = new LruCache<string>({ maxEntries: 50 })
const MAX_COMPAT_IMAGE_SOURCE_BYTES = 25 * 1024 * 1024
const MAX_COMPAT_OCR_BYTES = 256 * 1024

type CompatImageProjection =
  | { ok: true; data: Buffer; mimeType: string; changed: boolean }
  | { ok: false; notice: string }

const compatImageCache = new LruCache<CompatImageProjection>({ maxEntries: 20 })

async function normalizeCompatImage(
  buffer: Buffer,
  modelId: string,
  abortSignal?: AbortSignal,
): Promise<CompatImageProjection> {
  abortSignal?.throwIfAborted()
  if (buffer.length > MAX_COMPAT_IMAGE_SOURCE_BYTES) {
    return {
      ok: false,
      notice: `[image omitted: legacy payload exceeds the ${MAX_COMPAT_IMAGE_SOURCE_BYTES / (1024 * 1024)} MB local image limit]`,
    }
  }

  // Compatibility validation runs on every request projection. A full digest
  // lets repeated session images reuse the decoded result without allowing
  // same-size, same-header payloads to share a security decision.
  const key = `${modelId}:${bufferFingerprint(buffer)}`
  const cached = compatImageCache.get(key)
  if (cached) return cached

  const sniffedMime = await sniffImageMime(buffer)
  if (!sniffedMime?.startsWith('image/')) {
    return { ok: false, notice: '[image omitted: legacy payload is not a recognized image]' }
  }
  const compressed = await compressImage(buffer, sniffedMime, {
    byteBudget: ATTACH_BYTE_BUDGET,
    abortSignal,
  })
  const mimeType = normalizeImageMime(compressed.mimeType)
  let result: CompatImageProjection
  if (!isModelAcceptedImage(mimeType, { modelId, animated: compressed.animated })) {
    result = {
      ok: false,
      notice: buildUnsupportedImageNotice(mimeType, 'legacy session payload', modelId, compressed.animated),
    }
  } else if (
    compressed.failureReason ||
    compressed.data.length > ATTACH_BYTE_BUDGET ||
    compressed.width > MAX_EDGE_PX ||
    compressed.height > MAX_EDGE_PX
  ) {
    result = { ok: false, notice: buildImageProcessingFailureNotice('legacy session payload', compressed) }
  } else {
    result = { ok: true, data: compressed.data, mimeType, changed: compressed.changed }
  }
  compatImageCache.set(key, result)
  return result
}

function normalizedImageFilename(filename: string | undefined, mimeType: string): string | undefined {
  if (!filename) return undefined
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length)
  const stem = filename.replace(/\.[^./\\]+$/, '')
  return `${stem}.${extension}`
}

async function ocrBuffer(buffer: Buffer, abortSignal?: AbortSignal): Promise<string> {
  if (buffer.length > MAX_COMPAT_IMAGE_SOURCE_BYTES) {
    return `[image omitted: legacy payload exceeds the ${MAX_COMPAT_IMAGE_SOURCE_BYTES / (1024 * 1024)} MB local OCR limit]`
  }
  const key = bufferFingerprint(buffer)
  const cached = ocrCache.get(key)
  if (cached != null) return cached
  const sniffedMime = await sniffImageMime(buffer)
  if (!sniffedMime?.startsWith('image/')) return '[image omitted: legacy payload is not a recognized image]'
  const compressed = await compressImage(buffer, sniffedMime, {
    byteBudget: ATTACH_BYTE_BUDGET,
    abortSignal,
  })
  const finalMime = normalizeImageMime(compressed.mimeType)
  if (
    compressed.failureReason ||
    !isModelAcceptedImageMime(finalMime) ||
    compressed.data.length > ATTACH_BYTE_BUDGET ||
    compressed.width > MAX_EDGE_PX ||
    compressed.height > MAX_EDGE_PX
  ) {
    return buildImageProcessingFailureNotice('legacy session payload', compressed)
  }
  const rawText = await ocrImage(compressed.data, { abortSignal })
  const text =
    Buffer.byteLength(rawText, 'utf-8') <= MAX_COMPAT_OCR_BYTES
      ? rawText
      : truncateUtf8(rawText, MAX_COMPAT_OCR_BYTES) + '\n[Local OCR output truncated at 256 KB.]'
  ocrCache.set(key, text)
  return text
}

function filePartToBuffer(part: { data?: unknown }): Buffer | null {
  const unwrap = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || value instanceof Uint8Array) return value
    if (value instanceof ArrayBuffer || value instanceof URL) return value
    const tagged = value as { type?: string; data?: unknown }
    return tagged.type === 'data' ? tagged.data : value
  }
  const data = unwrap(part.data)
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (typeof data !== 'string') return null
  const commaIdx = data.indexOf(',')
  const payload = data.startsWith('data:') && commaIdx > 0 ? data.slice(commaIdx + 1) : data
  try {
    return Buffer.from(payload, 'base64')
  } catch {
    return null
  }
}

function cloneRequestValue<T>(value: T): T {
  if (Buffer.isBuffer(value)) return Buffer.from(value) as T
  if (value instanceof Uint8Array) return new Uint8Array(value) as T
  if (value instanceof ArrayBuffer) return value.slice(0) as T
  if (value instanceof URL) return new URL(value.href) as T
  if (Array.isArray(value)) return value.map((entry) => cloneRequestValue(entry)) as T
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, cloneRequestValue(entry)]),
  ) as T
}

function imagePartToBuffer(part: { image: unknown; mediaType?: string }): Buffer | null {
  const img = part.image
  if (Buffer.isBuffer(img)) return img
  if (img instanceof Uint8Array) return Buffer.from(img)
  if (typeof img === 'string') {
    // Could be base64 or a data URL. Strip the `data:...;base64,` prefix if present.
    const commaIdx = img.indexOf(',')
    const data = img.startsWith('data:') && commaIdx > 0 ? img.slice(commaIdx + 1) : img
    try {
      return Buffer.from(data, 'base64')
    } catch {
      return null
    }
  }
  return null
}

/** Replace EVERY binary part in the conversation with a text notice, in
 *  place. This is the 400-recovery path in the agent loop: when a provider
 *  rejects an image (corrupt bytes, size limit, a format that slipped past
 *  the ingestion gate), the offending part stays in history and would fail
 *  EVERY later request — session poisoning. Strip all binary parts once and
 *  retry the turn. Returns true only when something actually changed, so the
 *  caller can tell "retry is worthwhile" from "the bad part isn't in a shape
 *  we recognize — report the error instead of looping". */
export function stripBinaryPartsFromMessages(messages: ModelMessage[]): boolean {
  let changed = false
  const fileNotice = (mediaType?: string) =>
    `[File attachment omitted (${mediaType ?? 'binary'}) — the provider rejected it; removed so the session can continue.]`
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    if (msg.role === 'user' || msg.role === 'assistant') {
      let msgChanged = false
      const rewritten = (msg.content as Array<{ type: string; mediaType?: string }>).map((part) => {
        if (part.type === 'image') {
          msgChanged = true
          return { type: 'text', text: buildUnsupportedImageNotice(part.mediaType ?? 'unknown') }
        }
        if (part.type === 'file') {
          msgChanged = true
          return { type: 'text', text: fileNotice(part.mediaType) }
        }
        return part
      })
      if (msgChanged) {
        changed = true
        ;(msg as { content: unknown }).content = rewritten
      }
    } else if (msg.role === 'tool') {
      for (const part of msg.content) {
        if (part.type !== 'tool-result') continue
        const output = (part as { output?: MaybeOutput }).output
        if (!output || output.type !== 'content' || !Array.isArray(output.value)) continue
        const entries = output.value as Array<{ type?: string; mediaType?: string }>
        if (!entries.some((e) => e?.type !== 'text' && e?.type !== 'custom')) continue
        output.value = entries.map((entry) => {
          if (entry?.type === 'text' || entry?.type === 'custom') return entry
          changed = true
          return { type: 'text', text: buildUnsupportedImageNotice(entry?.mediaType ?? 'unknown') }
        }) as never
      }
    }
  }
  return changed
}

/** Build a request-only projection that removes legacy non-image files and
 * OCRs images for text-only models. Canonical session messages are never
 * mutated by this compatibility pass. */
export async function downgradeBinaryPartsForProvider(
  messages: ModelMessage[],
  modelId: string,
  abortSignal?: AbortSignal,
): Promise<ModelMessage[]> {
  const caps = capabilitiesOf(modelId)
  const acceptsImages = caps.image && modelSupportsVision(modelId)
  const projected = cloneRequestValue(messages)

  for (const msg of projected) {
    // User messages — content may be an array of TextPart | ImagePart | FilePart.
    if ((msg.role === 'user' || msg.role === 'assistant') && Array.isArray(msg.content)) {
      const rewritten: unknown[] = []
      for (const part of msg.content) {
        if (part.type === 'image') {
          const buffer = imagePartToBuffer(part as { image: unknown; mediaType?: string })
          if (!acceptsImages) {
            const text = buffer ? await ocrBuffer(buffer, abortSignal) : '[image omitted]'
            rewritten.push({
              type: 'text',
              text: `[Image replaced by local OCR — the current model cannot natively see images. Visual content is NOT visible.]\n${text}`,
            })
            continue
          }
          if (!buffer) {
            rewritten.push({ type: 'text', text: '[image omitted: legacy payload could not be decoded]' })
            continue
          }
          const normalized = await normalizeCompatImage(buffer, modelId, abortSignal)
          if (!normalized.ok) {
            rewritten.push({ type: 'text', text: normalized.notice })
            continue
          }
          const declaredMime = normalizeImageMime((part as { mediaType?: string }).mediaType ?? '')
          rewritten.push(
            !normalized.changed && declaredMime === normalized.mimeType
              ? part
              : {
                  ...part,
                  image: normalized.data.toString('base64'),
                  mediaType: normalized.mimeType,
                },
          )
          continue
        }
        if (part.type === 'file') {
          const file = part as { data?: unknown; filename?: string; mediaType?: string }
          const mediaType = file.mediaType?.toLowerCase() ?? ''
          const isImage = mediaType === 'image' || mediaType.startsWith('image/')
          if (isImage && acceptsImages) {
            const buffer = filePartToBuffer(file)
            if (!buffer) {
              rewritten.push({ type: 'text', text: '[image omitted: legacy payload could not be decoded]' })
              continue
            }
            const normalized = await normalizeCompatImage(buffer, modelId, abortSignal)
            if (!normalized.ok) {
              rewritten.push({ type: 'text', text: normalized.notice })
              continue
            }
            const declaredMime = normalizeImageMime(mediaType)
            rewritten.push(
              !normalized.changed && declaredMime === normalized.mimeType
                ? part
                : {
                    ...file,
                    data: { type: 'data', data: normalized.data.toString('base64') },
                    mediaType: normalized.mimeType,
                    filename: normalizedImageFilename(file.filename, normalized.mimeType),
                  },
            )
            continue
          }
          if (isImage) {
            const buffer = filePartToBuffer(file)
            const text = buffer ? await ocrBuffer(buffer, abortSignal) : '[image omitted]'
            rewritten.push({
              type: 'text',
              text: `[Image replaced by local OCR — the current model cannot natively see images. Visual content is NOT visible.]\n${text}`,
            })
            continue
          }
          rewritten.push({
            type: 'text',
            text: `[Legacy file attachment omitted: ${file.filename ?? (mediaType || 'unknown')} — reattach or read the original path to process it locally.]`,
          })
          continue
        }
        rewritten.push(part)
      }
      ;(msg as { content: unknown }).content = rewritten
      continue
    }

    // Tool result messages — content is always an array of tool-result parts.
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type !== 'tool-result') continue
        const output = (part as { output?: MaybeOutput }).output
        if (!output || output.type !== 'content' || !Array.isArray(output.value)) continue

        const rewritten: unknown[] = []
        for (const entry of output.value as ToolContentEntry[]) {
          // New sessions use tagged image FileParts; legacy sessions may still
          // contain image-data/media. OCR for text-only providers so they do
          // not reject the binary tool output.
          const isImageEntry = isToolImageEntry(entry)
          const imageData = toolImageBase64(entry)
          if (isImageEntry && (entry.mediaType?.startsWith('image/') ?? true) && acceptsImages) {
            const buffer = Buffer.from(imageData ?? '', 'base64')
            const normalized = await normalizeCompatImage(buffer, modelId, abortSignal)
            if (!normalized.ok) {
              rewritten.push({ type: 'text', text: normalized.notice })
              continue
            }
            const declaredMime = normalizeImageMime(entry.mediaType ?? '')
            rewritten.push(
              !normalized.changed && declaredMime === normalized.mimeType
                ? entry
                : withToolImageData(
                    entry,
                    normalized.data.toString('base64'),
                    normalized.mimeType,
                    normalizedImageFilename(entry.filename, normalized.mimeType),
                  ),
            )
            continue
          }
          if (isImageEntry && (entry.mediaType?.startsWith('image/') ?? true)) {
            const data = imageData ?? ''
            let text = '[image omitted]'
            try {
              const buffer = Buffer.from(data, 'base64')
              text = await ocrBuffer(buffer, abortSignal)
            } catch {
              // fall through with placeholder
            }
            rewritten.push({
              type: 'text',
              text: `[Image replaced by local OCR — the current model cannot natively see images.]\n${text}`,
            })
            continue
          }
          const isLegacyFileEntry =
            entry.type === 'file' ||
            entry.type === 'file-data' ||
            entry.type === 'file-url' ||
            entry.type === 'file-id' ||
            (entry.type === 'media' && !entry.mediaType?.startsWith('image/'))
          if (isLegacyFileEntry) {
            rewritten.push({
              type: 'text',
              text: `[Legacy file attachment omitted (${entry.filename ?? entry.mediaType ?? 'binary'}) — reattach or read the original path to process it locally.]`,
            })
            continue
          }
          rewritten.push(entry)
        }
        ;(output as MaybeOutput).value = rewritten
      }
    }
  }
  return projected
}
