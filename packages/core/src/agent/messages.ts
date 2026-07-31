// @x-code-cli/core — Message types and helpers
import type { ModelMessage } from 'ai'

export interface ToolImage {
  data: string
  mediaType: string
}

/** Create a tool result message. When `images` are supplied (e.g. browser
 *  screenshots from an MCP tool) the output switches to the multimodal
 *  `content` form so a vision-capable model actually sees them; the text
 *  stays as a leading text part. AI SDK v7 uses `image-data` for inline
 *  base64 images in tool results; text-only providers get the media
 *  stripped/OCR'd upstream by downgradeBinaryPartsForProvider. The
 *  plain-string path is unchanged for the overwhelmingly-common text-only
 *  result. */
export function toolResultMessage(
  toolCallId: string,
  toolName: string,
  result: string,
  images?: readonly ToolImage[],
): ModelMessage {
  const output =
    images && images.length > 0
      ? {
          type: 'content' as const,
          value: [
            ...(result ? [{ type: 'text' as const, text: result }] : []),
            ...images.map((img) => ({ type: 'image-data' as const, data: img.data, mediaType: img.mediaType })),
          ],
        }
      : { type: 'text' as const, value: result }
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output,
      },
    ],
  }
}

/** Reattach tool-returned media for Chat Completions providers whose `tool`
 *  role is text-only. AI SDK's internal ImagePart expects raw base64 plus a
 *  media type; its provider converter adds the data-URL prefix on the wire. */
export function toolMediaUserMessage(images: readonly ToolImage[]): ModelMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'Attached media from tool result:' },
      ...images.map((image) => ({
        type: 'image' as const,
        image: image.data,
        mediaType: image.mediaType,
      })),
    ],
  }
}

/** Standard error string returned to the model from a tool. The "Error: "
 *  prefix is load-bearing — handleToolCall checks for it via
 *  isToolErrorString to flip the scrollback line to red, and the model
 *  itself learns to read it as a failure marker. */
export function toolErrorString(message: string): string {
  return `Error: ${message}`
}

/** Wrap a thrown / unknown value into the standard tool-error string. */
export function toolErrorFromUnknown(err: unknown): string {
  return toolErrorString(err instanceof Error ? err.message : String(err))
}

/** Match the result-string prefix produced by toolErrorString. */
export function isToolErrorString(value: string): boolean {
  return value.startsWith('Error:')
}
