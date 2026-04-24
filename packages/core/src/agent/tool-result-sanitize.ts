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
