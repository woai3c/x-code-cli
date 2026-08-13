// @x-code-cli/core — Provider-specific compatibility shims
import type { ModelMessage } from 'ai'

import { buildUnsupportedImageNotice, capabilitiesOf, modelSupportsVision } from '../providers/capabilities.js'
import { LruCache, bufferFingerprint } from '../utils/lru-cache.js'
import { ocrImage } from './file-ingest.js'
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
//   - Tool result messages: `content` value array with `image-data`
//     entries → same content array but with image entries replaced by
//     `text` entries (OCR'd).
//
// OCR runs locally via tesseract.js. Results are memoized by a content
// hash so repeatedly sending the same image across turns doesn't re-run
// OCR on every turn.

type MaybeOutput = { type?: string; value?: unknown; filename?: string }

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
      for (const entry of output.value as Array<{
        type?: string
        data?: string
        mediaType?: string
        text?: string
      }>) {
        const isImage = entry.type === 'image-data' || (entry.type === 'media' && entry.mediaType?.startsWith('image/'))
        if (isImage && typeof entry.data === 'string' && typeof entry.mediaType === 'string') {
          pendingImages.push({ data: entry.data, mediaType: entry.mediaType })
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

async function ocrBuffer(buffer: Buffer): Promise<string> {
  const key = bufferFingerprint(buffer)
  const cached = ocrCache.get(key)
  if (cached != null) return cached

  const text = await ocrImage(buffer)
  ocrCache.set(key, text)
  return text
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

/**
 * Strip binary content parts from the conversation history in-place so that
 * the next `streamText` call doesn't 400 on a provider that can't accept
 * them. Replaces images with OCR'd text annotated as a fallback so the
 * model knows it's looking at text, not the image itself.
 */
export async function downgradeBinaryPartsForProvider(messages: ModelMessage[], modelId: string): Promise<void> {
  const caps = capabilitiesOf(modelId)
  const acceptsImages = caps.image && modelSupportsVision(modelId)
  if (acceptsImages && caps.pdf) return

  for (const msg of messages) {
    // User messages — content may be an array of TextPart | ImagePart | FilePart.
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const rewritten: typeof msg.content = []
      for (const part of msg.content) {
        if (part.type === 'image' && !acceptsImages) {
          const buffer = imagePartToBuffer(part as { image: unknown; mediaType?: string })
          const text = buffer ? await ocrBuffer(buffer) : '[image omitted]'
          rewritten.push({
            type: 'text',
            text: `[Image replaced by local OCR — the current model cannot natively see images. Visual content is NOT visible.]\n${text}`,
          })
          continue
        }
        if (part.type === 'file' && !caps.pdf) {
          rewritten.push({
            type: 'text',
            text: `[File omitted: ${(part as { filename?: string }).filename ?? 'unknown'} — current model does not accept file attachments.]`,
          })
          continue
        }
        rewritten.push(part)
      }
      ;(msg as { content: typeof rewritten }).content = rewritten
      continue
    }

    // Tool result messages — content is always an array of tool-result parts.
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type !== 'tool-result') continue
        const output = (part as { output?: MaybeOutput }).output
        if (!output || output.type !== 'content' || !Array.isArray(output.value)) continue

        const rewritten: unknown[] = []
        for (const entry of output.value as Array<{
          type: string
          data?: string
          mediaType?: string
          text?: string
          filename?: string
        }>) {
          // In a ModelMessage tool-result the image part is `{ type: 'image-data',
          // data, mediaType }`. OCR for text-only providers so they don't 400
          // on the binary.
          const isImageEntry = entry.type === 'image-data'
          if (isImageEntry && (entry.mediaType?.startsWith('image/') ?? true) && !acceptsImages) {
            const data = entry.data ?? ''
            let text = '[image omitted]'
            try {
              const buffer = Buffer.from(data, 'base64')
              text = await ocrBuffer(buffer)
            } catch {
              // fall through with placeholder
            }
            rewritten.push({
              type: 'text',
              text: `[Image replaced by local OCR — the current model cannot natively see images.]\n${text}`,
            })
            continue
          }
          if ((entry.type === 'file-data' || entry.type === 'file-url' || entry.type === 'file-id') && !caps.pdf) {
            rewritten.push({
              type: 'text',
              text: `[File attachment omitted (${entry.filename ?? entry.mediaType ?? 'binary'}) — current model does not accept file attachments.]`,
            })
            continue
          }
          rewritten.push(entry)
        }
        ;(output as MaybeOutput).value = rewritten
      }
    }
  }
}
