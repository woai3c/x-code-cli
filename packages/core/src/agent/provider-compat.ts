// @x-code-cli/core — Provider-specific compatibility shims
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { ModelMessage } from 'ai'

import { capabilitiesOf, modelSupportsVision } from '../providers/capabilities.js'
import { ocrImage } from './file-ingest.js'
import { toolMediaUserMessage } from './messages.js'
import type { ToolImage } from './messages.js'

/**
 * Ensure all assistant messages have a reasoning content part.
 *
 * DeepSeek V4 models in thinking mode require the `reasoning_content` field on
 * every assistant message during tool-call chains. The upstream
 * `@ai-sdk/deepseek` converter sets `reasoning_content: undefined` when no
 * reasoning part exists, and `JSON.stringify` strips `undefined` values —
 * causing the DeepSeek API to reject the request with a 400
 * "Missing reasoning_content" error.
 *
 * This helper injects an empty `{ type: 'reasoning', text: '' }` part into any
 * assistant message that lacks one, so the converter always produces
 * `"reasoning_content": ""` in the JSON body.
 */
export function ensureReasoningContentParts(messages: ModelMessage[], modelId: string): void {
  if (!modelId.includes('deepseek-v4')) return

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue

    const content = msg.content
    if (!Array.isArray(content)) continue

    const hasReasoning = (content as Array<{ type: string }>).some((p) => p.type === 'reasoning')
    if (!hasReasoning) {
      ;(content as Array<{ type: string; text?: string }>).unshift({ type: 'reasoning', text: '' })
    }
  }
}

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

// Cap OCR cache so a long session that pages through many distinct images
// doesn't grow the heap unboundedly. Map preserves insertion order, so we
// can evict the oldest entry by reading `keys().next()` — that's our LRU.
// Re-inserting a hit (via delete+set) bumps it to the most-recent slot.
const OCR_CACHE_LIMIT = 50
const ocrCache = new Map<string, string>()

function ocrCacheGet(key: string): string | undefined {
  const hit = ocrCache.get(key)
  if (hit === undefined) return undefined
  // Touch: move to most-recent slot.
  ocrCache.delete(key)
  ocrCache.set(key, hit)
  return hit
}

function ocrCacheSet(key: string, value: string): void {
  if (ocrCache.has(key)) ocrCache.delete(key)
  ocrCache.set(key, value)
  if (ocrCache.size > OCR_CACHE_LIMIT) {
    const oldest = ocrCache.keys().next().value
    if (oldest !== undefined) ocrCache.delete(oldest)
  }
}

async function ocrBuffer(buffer: Buffer): Promise<string> {
  const key = `${buffer.length}:${buffer.subarray(0, 64).toString('base64')}`
  const cached = ocrCacheGet(key)
  if (cached != null) return cached

  // tesseract.js takes a path, URL, or Buffer. Buffers work but some
  // versions have edge cases — writing to a tmp file is universally safe.
  const tmp = path.join(os.tmpdir(), `xcc-ocr-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
  try {
    await fs.writeFile(tmp, buffer)
    const text = await ocrImage(tmp)
    ocrCacheSet(key, text)
    return text
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }
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
          // In a ModelMessage tool-result the image part is `{ type: 'media',
          // data, mediaType }` (AI SDK lowers it to provider-level
          // `image-data` only when building the request). We run on
          // state.messages, before that lowering — so match 'media' (and keep
          // 'image-data' as a belt-and-suspenders guard) and OCR for
          // text-only providers so they don't 400 on the binary.
          const isImageEntry = entry.type === 'media' || entry.type === 'image-data'
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
