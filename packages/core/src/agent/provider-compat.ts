// @x-code-cli/core — Provider-specific compatibility shims
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { ModelMessage } from 'ai'

import { capabilitiesOf } from '../providers/capabilities.js'
import { ocrImage } from './file-ingest.js'

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
  if (caps.image && caps.pdf) return

  for (const msg of messages) {
    // User messages — content may be an array of TextPart | ImagePart | FilePart.
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const rewritten: typeof msg.content = []
      for (const part of msg.content) {
        if (part.type === 'image' && !caps.image) {
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
          if (entry.type === 'image-data' && !caps.image) {
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
