import path from 'node:path'

import type { FilePart, TextPart } from 'ai'

export type StandardImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export type ProcessedLocalPart =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      data: Buffer
      mediaType: StandardImageMediaType
      filename?: string
      source?: { filePath: string; page?: number }
    }

export const BUILT_IN_MEDIA_ANALYSIS_NOTE =
  '[Built-in local media processing succeeded. Analyze the supplied content directly. ' +
  'Do not invoke shell, Node.js, Python, FFmpeg, or other external programs merely to re-read, parse, OCR, ' +
  'transcribe, or independently validate values from this attachment. Use external programs only if the built-in ' +
  'pipeline reports a failure, or the user explicitly asks for conversion, codec diagnostics, or independent validation.]'

export function escapeMediaAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
}

export function openMediaTag(tag: string, attributes: Record<string, string | number | undefined>): string {
  const rendered = Object.entries(attributes)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}="${escapeMediaAttribute(String(value))}"`)
  return rendered.length > 0 ? `<<${tag} ${rendered.join(' ')}>>` : `<<${tag}>>`
}

export function wrapLocalText(
  tag: string,
  text: string,
  attributes: Record<string, string | number | undefined>,
): string {
  return `${openMediaTag(tag, attributes)}\n${text}\n<<\/${tag}>>`
}

export function toUserContentParts(parts: ProcessedLocalPart[]): Array<TextPart | FilePart> {
  return parts.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    return {
      type: 'file',
      data: { type: 'data', data: part.data.toString('base64') },
      mediaType: part.mediaType,
      filename: part.filename ?? (part.source ? path.basename(part.source.filePath) : undefined),
    }
  })
}

export function toToolResultContent(parts: ProcessedLocalPart[]): {
  type: 'content'
  value: Array<
    | { type: 'text'; text: string }
    | { type: 'file'; data: { type: 'data'; data: string }; mediaType: string; filename?: string }
  >
} {
  return {
    type: 'content',
    value: parts.map((part) =>
      part.type === 'text'
        ? { type: 'text', text: part.text }
        : {
            type: 'file',
            data: { type: 'data', data: part.data.toString('base64') },
            mediaType: part.mediaType,
            filename: part.filename,
          },
    ),
  }
}
