import type { ModelMessage } from '../types/index.js'

type ContentPartLike = { type?: string; text?: string }

/** Pull plain text out of a ModelMessage's content. CoreMessage content
 *  is either a string or an array of typed parts; we only extract text
 *  parts (image / file / tool-call go through other paths). */
export function extractText(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as ContentPartLike[])
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
}
