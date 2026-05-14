// @x-code-cli/core — Truncate tool-result parts inside ModelMessage arrays
//
// AI SDK auto-executed tools (readFile / grep / glob / listDir / webFetch /
// webSearch) return their results inside `response.messages` as tool-result
// parts. The manual tool path in `tool-execution.ts` runs every output
// through `truncateToolResult`, but auto-executed results bypass that path
// and land in `state.messages` at full size. This module walks the messages
// produced by a completed stream and applies the same per-tool truncation
// policy in-place before they persist into the conversation state.
//
// Policy is per-tool:
//   - shell / edit / writeFile: manual path already truncated
//   - readFile: head-tail (preserve file start + file end)
//   - grep / glob / listDir: head-only (lexical order is meaningful; the tail
//     carries no additional signal once the head is representative)
//   - webFetch: head-tail (pages often have navigation cruft at top + bottom,
//     but the meaningful content is usually the middle. head-tail still beats
//     head-only because it preserves the final anchors)
//   - default: head-tail
import type { ModelMessage } from 'ai'

import { truncateToolResult } from '../tools/truncate.js'
import type { TruncateOptions } from '../tools/truncate.js'

const PER_TOOL_POLICY: Record<string, TruncateOptions> = {
  readFile: { direction: 'head-tail' },
  grep: { direction: 'head', maxLines: 500 },
  glob: { direction: 'head', maxLines: 500 },
  listDir: { direction: 'head', maxLines: 500 },
  webFetch: { direction: 'head-tail' },
  webSearch: { direction: 'head-tail' },
  shell: { direction: 'head' },
}

function policyFor(toolName: string | undefined): TruncateOptions {
  if (!toolName) return { direction: 'head-tail' }
  return PER_TOOL_POLICY[toolName] ?? { direction: 'head-tail' }
}

/** Narrow typing — AI SDK tool-result parts look roughly like this on the
 *  wire. We only mutate the subset we know about and leave anything else
 *  alone. */
type ToolResultLike = {
  type: 'tool-result'
  toolName?: string
  output?: {
    type?: 'text' | 'content' | string
    value?: unknown
  }
}

/**
 * Walk `messages` and reconcile tool_call ↔ tool_result pairing in BOTH
 * directions. Providers strictly require:
 *   - every assistant tool_call to have a paired tool_result
 *   - every tool_result to be preceded by an assistant tool_call with
 *     the matching toolCallId
 * Either kind of orphan will poison the next API request with a
 * "tool must be a response to a preceding message with tool_calls"
 * (or the converse) error.
 *
 * How the orphans arise:
 *   - Forward (tool_call without result): models occasionally emit
 *     malformed tool input (e.g. todoWrite with required fields
 *     missing). The SDK validates, fails, emits a tool-error event,
 *     and in some cases doesn't push a paired tool-result into
 *     response.messages. We synthesise an error result.
 *   - Reverse (tool_result without preceding tool_call): when the SDK
 *     emits `tool-error` mid-stream because the model's tool input
 *     failed validation, the SDK may exclude the tool_call from
 *     response.messages — but our `processToolCalls` still drains the
 *     `result.toolCalls` promise and runs the tool, pushing a
 *     tool_result into state.messages. We drop that orphan.
 *
 * Mutates `messages` in place. Idempotent (running twice is a no-op).
 */
export function repairOrphanToolCalls(messages: ModelMessage[]): void {
  // Collect every tool_call_id that appears in an assistant message.
  const expected = new Set<string>()
  const toolNameById = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string; toolName?: string }>) {
      if (part?.type === 'tool-call' && typeof part.toolCallId === 'string') {
        expected.add(part.toolCallId)
        if (typeof part.toolName === 'string') toolNameById.set(part.toolCallId, part.toolName)
      }
    }
  }

  // Drop tool-result parts whose toolCallId never appeared in an
  // assistant tool_call (reverse-orphan). When all parts of a tool
  // message are orphans, drop the whole message; when only some are,
  // filter the parts in place.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue
    const parts = msg.content as Array<{ type?: string; toolCallId?: string }>
    const kept = parts.filter((part) => {
      if (part?.type !== 'tool-result') return true
      if (typeof part.toolCallId !== 'string') return true
      return expected.has(part.toolCallId)
    })
    if (kept.length === 0) {
      // Splicing the whole tool message can leave assistant→assistant
      // adjacent (the common shape is assistant tool_calls → tool
      // results → assistant continuation). Anthropic strictly requires
      // user/assistant alternation, and although the @ai-sdk/anthropic
      // converter currently merges consecutive same-role messages for
      // us, we don't want the sanitizer's correctness to depend on
      // downstream SDK behavior. When both neighbors are assistant,
      // replace with a user-text placeholder instead so the boundary
      // stays. Otherwise (one or both neighbors are user/tool/absent),
      // dropping is safe.
      const prev = messages[i - 1]
      const next = messages[i + 1]
      if (prev?.role === 'assistant' && next?.role === 'assistant') {
        messages[i] = {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '[Stale tool result discarded — no matching tool_call in history.]',
            },
          ],
        } as ModelMessage
      } else {
        messages.splice(i, 1)
      }
    } else if (kept.length !== parts.length) {
      // AI SDK's narrow union typings forbid the partial part shape we
      // operate on at the type level — we already narrowed at runtime
      // above, so a structural cast is safe here.
      ;(msg as { content: unknown }).content = kept
    }
  }

  // Collect every tool_call_id that's already covered by a tool-result
  // (after the reverse-orphan pass above).
  const fulfilled = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        fulfilled.add(part.toolCallId)
      }
    }
  }

  // Append synthetic results for forward-orphans, preserving overall
  // ordering (forward-orphans always go at the end — they never had a
  // real result, so their position is purely a placeholder for the
  // next API request). Collect all orphan parts into ONE tool message
  // rather than pushing one per id: the AI SDK's Anthropic converter
  // happens to merge consecutive same-role messages today, but the
  // Google converter does not, and OpenAI-compat splits per tool_call_id
  // anyway — emitting a single tool ModelMessage is wire-equivalent for
  // the splitters and strictly safer for the non-merging providers.
  const orphanParts: Array<{
    type: 'tool-result'
    toolCallId: string
    toolName: string
    output: { type: 'text'; value: string }
  }> = []
  for (const id of expected) {
    if (fulfilled.has(id)) continue
    const name = toolNameById.get(id) ?? 'unknown'
    orphanParts.push({
      type: 'tool-result',
      toolCallId: id,
      toolName: name,
      output: {
        type: 'text',
        value:
          'Error: Tool input failed validation (likely missing required fields). The assistant should retry with the correct schema.',
      },
    })
  }
  if (orphanParts.length > 0) {
    // Defense in depth: if some other code path already left a trailing
    // tool message (e.g. processToolCalls pushed real results that we
    // didn't touch above), merge orphan parts into it rather than
    // emitting a second adjacent tool ModelMessage.
    const tail = messages[messages.length - 1]
    if (tail && tail.role === 'tool' && Array.isArray(tail.content)) {
      ;(tail.content as unknown[]).push(...(orphanParts as unknown[]))
    } else {
      messages.push({
        role: 'tool',
        content: orphanParts as never,
      } as ModelMessage)
    }
  }
}

/**
 * Walk `messages` in place and truncate any oversized tool-result parts. Only
 * mutates the `output.value` field; the rest of the message structure is
 * preserved exactly as the provider returned it.
 */
export function truncateToolResultsInMessages(messages: ModelMessage[]): void {
  for (const msg of messages) {
    if (msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue

    for (const part of msg.content as unknown as ToolResultLike[]) {
      if (part?.type !== 'tool-result') continue
      const output = part.output
      if (!output) continue

      // Text output: `{ type: 'text', value: string }`
      if (output.type === 'text' && typeof output.value === 'string') {
        const truncated = truncateToolResult(output.value, policyFor(part.toolName))
        if (truncated.length !== output.value.length) {
          output.value = truncated
        }
        continue
      }

      // Content output: `{ type: 'content', value: Array<{ type: string, text?: string, ... }> }`
      // Only the text entries are mutable — image-data / file-data / file-url
      // are binary payloads that the provider-compat layer handles elsewhere.
      if (output.type === 'content' && Array.isArray(output.value)) {
        const entries = output.value as Array<{ type?: string; text?: string }>
        for (const entry of entries) {
          if (entry?.type === 'text' && typeof entry.text === 'string') {
            const truncated = truncateToolResult(entry.text, policyFor(part.toolName))
            if (truncated.length !== entry.text.length) {
              entry.text = truncated
            }
          }
        }
      }
    }
  }
}
