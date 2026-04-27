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

/** Synthesize a tool-result message for a tool_call whose input failed
 *  Zod validation (or otherwise didn't execute). Without this, the
 *  assistant message ends up with an orphan tool_call — the next API
 *  request fails with provider errors like
 *  "tool must be a response to a preceding message with tool_calls".
 *  Wire-shape mirrors how the AI SDK normally emits tool results. */
function synthesizeToolErrorResult(toolCallId: string, toolName: string, errorMessage: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'text', value: `Error: ${errorMessage}` },
      } as never, // AI SDK's narrow union doesn't admit the partial we construct here; wire-shape is correct.
    ],
  } as ModelMessage
}

/**
 * Walk `messages` and append synthetic tool-result entries for any
 * assistant tool_call that lacks a matching tool result. Models can emit
 * malformed tool inputs (e.g. todoWrite with missing required fields) —
 * the SDK validates, fails, and emits a tool-error event but in some
 * cases doesn't push a paired tool-result into response.messages. The
 * orphan tool_call would then poison every subsequent API request
 * because providers strictly require tool_call ↔ tool_result pairing.
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

  // Collect every tool_call_id that's already covered by a tool-result.
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

  // Append synthetic results for orphans, preserving overall ordering
  // (orphans always go at the end — they never had a real result, so
  // their position is purely a placeholder for the next API request).
  for (const id of expected) {
    if (fulfilled.has(id)) continue
    const name = toolNameById.get(id) ?? 'unknown'
    messages.push(
      synthesizeToolErrorResult(
        id,
        name,
        'Tool input failed validation (likely missing required fields). The assistant should retry with the correct schema.',
      ),
    )
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
