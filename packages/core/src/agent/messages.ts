// @x-code-cli/core — Message types and helpers
import type { ModelMessage } from 'ai'

/** Create a tool result message. When `images` are supplied (e.g. browser
 *  screenshots from an MCP tool) the output switches to the multimodal
 *  `content` form so a vision-capable model actually sees them; the text
 *  stays as a leading text part. AI SDK converts `media` → provider-level
 *  `image-data`; text-only providers get the media stripped/OCR'd upstream
 *  by downgradeBinaryPartsForProvider. The plain-string path is unchanged
 *  for the overwhelmingly-common text-only result. */
export function toolResultMessage(
  toolCallId: string,
  toolName: string,
  result: string,
  images?: ReadonlyArray<{ data: string; mediaType: string }>,
): ModelMessage {
  const output =
    images && images.length > 0
      ? {
          type: 'content' as const,
          value: [
            ...(result ? [{ type: 'text' as const, text: result }] : []),
            ...images.map((img) => ({ type: 'media' as const, data: img.data, mediaType: img.mediaType })),
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
