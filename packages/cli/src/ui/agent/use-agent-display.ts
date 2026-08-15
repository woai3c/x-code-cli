// @x-code-cli/cli — ModelMessage → DisplayMessage conversion.
//
// Extracted from use-agent.ts so the hook body stays focused on state
// management. This module is UI-only — it never touches the core
// agent loop.
import type { DisplayMessage, DisplayToolCall, ModelMessage } from '@x-code-cli/core'
import { TOOL_SEARCH_TOOL_NAME, extractText } from '@x-code-cli/core'

type ContentPartLike = {
  type?: string
  text?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
}

/** Pull a string output out of a tool-result part. AI SDK normalises
 *  tool outputs to `{ type: 'text' | 'error-text' | ..., value: string }`,
 *  but older / provider-specific shapes also pass through, so we
 *  defensively coerce. */
function readToolOutput(part: ContentPartLike): { output: string; isError: boolean } {
  const out = part.output as { type?: string; value?: unknown } | string | undefined
  if (typeof out === 'string') return { output: out, isError: false }
  if (out && typeof out === 'object') {
    const isError = out.type === 'error-text' || out.type === 'error-json'
    const value = out.value
    if (typeof value === 'string') return { output: value, isError }
    if (value !== undefined) return { output: JSON.stringify(value), isError }
  }
  return { output: '', isError: false }
}

/** Convert a loaded ModelMessage[] back into the DisplayMessage[] shape
 *  that ChatInput renders. Splits each assistant message with N
 *  tool-calls into N+1 DisplayMessages (one text-only when there's
 *  text, then one per tool-call) so the live agent flow's rendering
 *  pattern is preserved verbatim — multiple parallel tool calls in a
 *  single turn still appear as separate `⎿` rows.
 *
 *  Tool messages don't become DisplayMessages of their own; their
 *  output is stitched onto the matching tool-call DisplayMessage by
 *  `toolCallId`. */
export function modelMessagesToDisplay(messages: ModelMessage[]): DisplayMessage[] {
  const toolResults = new Map<string, { output: string; isError: boolean }>()
  for (const msg of messages) {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue
    for (const part of msg.content as ContentPartLike[]) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        toolResults.set(part.toolCallId, readToolOutput(part))
      }
    }
  }
  const out: DisplayMessage[] = []
  let counter = 0
  const baseTs = Date.now() - messages.length
  for (const msg of messages) {
    counter++
    if (msg.role === 'system' || msg.role === 'tool') continue
    const id = `hydrated-${counter}`
    const ts = baseTs + counter
    if (msg.role === 'user') {
      const text = extractText(msg.content)
      if (text) out.push({ id, role: 'user', content: text, timestamp: ts })
      continue
    }
    // assistant
    const text = extractText(msg.content)
    if (text) out.push({ id: `${id}-text`, role: 'assistant', content: text, timestamp: ts })
    if (Array.isArray(msg.content)) {
      let tcIdx = 0
      for (const part of msg.content as ContentPartLike[]) {
        if (part?.type !== 'tool-call' || typeof part.toolCallId !== 'string') continue
        // toolSearch is hidden from scrollback in the live flow (see
        // use-agent.ts) — skip it here too so a resumed session doesn't
        // suddenly surface the tool-search calls the live view hid.
        if (part.toolName === TOOL_SEARCH_TOOL_NAME) continue
        if (
          part.toolName === 'shellOutput' &&
          (!part.input ||
            typeof part.input !== 'object' ||
            !('chars' in (part.input as Record<string, unknown>)) ||
            (part.input as Record<string, unknown>).chars === '')
        ) {
          continue
        }
        tcIdx++
        const result = toolResults.get(part.toolCallId)
        const tc: DisplayToolCall = {
          id: `${id}-tc-${tcIdx}`,
          toolName: part.toolName ?? 'unknown',
          input: (part.input as Record<string, unknown>) ?? {},
          output: result?.output,
          status: result ? (result.isError ? 'error' : 'completed') : 'pending',
        }
        out.push({
          id: `${id}-tcm-${tcIdx}`,
          role: 'assistant',
          content: '',
          toolCalls: [tc],
          timestamp: ts,
        })
      }
    }
  }
  return out
}

export function previewSubInput(input: Record<string, unknown>): string {
  const val =
    (input.filePath as string) ??
    (input.command as string) ??
    (input.pattern as string) ??
    (input.query as string) ??
    (input.dirPath as string) ??
    (input.path as string) ??
    ''
  return val.length > 80 ? val.slice(0, 77) + '...' : val
}
