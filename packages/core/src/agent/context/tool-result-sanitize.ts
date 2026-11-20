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

import { truncateToolResult } from '../../tools/truncate.js'
import type { TruncateOptions } from '../../tools/truncate.js'
import type { TrackedModelMessage } from '../../types/index.js'
import { createTrackedMessage, mergeProvenance } from '../provenance.js'

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
 * Walk `entries` and reconcile tool_call ↔ tool_result pairing in BOTH
 * directions while preserving provenance. Providers strictly require:
 *   - every assistant tool_call to have a paired tool_result
 *   - every tool_result to be preceded by an assistant tool_call with
 *     the matching toolCallId
 * Either kind of orphan will poison the next API request.
 *
 * Structural moves and removals operate on whole tracked entries; rewritten
 * content keeps the original entryId and provenance, and synthetic results
 * inherit the matching assistant calls.
 */
export function repairOrphanTrackedToolCalls(entries: TrackedModelMessage[]): boolean {
  let changed = false
  for (let i = 0; i < entries.length; i++) {
    const message = entries[i]?.message
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const hasToolCall = (message.content as Array<{ type?: string }>).some((part) => part?.type === 'tool-call')
    if (!hasToolCall) continue
    let cursor = i + 1
    const displaced: number[] = []
    while (cursor < entries.length) {
      const role = entries[cursor]?.message.role
      if (role === 'tool') {
        cursor++
        continue
      }
      if (role === 'user') {
        displaced.push(cursor)
        cursor++
        continue
      }
      break
    }
    if (displaced.length === 0) continue
    const extracted = displaced.map((index) => entries[index]!)
    for (let index = displaced.length - 1; index >= 0; index--) entries.splice(displaced[index]!, 1)
    const insertAt = cursor - displaced.length
    entries.splice(insertAt, 0, ...extracted)
    changed = true
    i = insertAt + extracted.length - 1
  }

  const expected = new Set<string>()
  const toolNameById = new Map<string, string>()
  const sourceById = new Map<string, TrackedModelMessage>()
  for (const entry of entries) {
    const message = entry.message
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const part of message.content as Array<{ type?: string; toolCallId?: string; toolName?: string }>) {
      if (part?.type !== 'tool-call' || typeof part.toolCallId !== 'string') continue
      expected.add(part.toolCallId)
      sourceById.set(part.toolCallId, entry)
      if (typeof part.toolName === 'string') toolNameById.set(part.toolCallId, part.toolName)
    }
  }

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    const message = entry.message
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue
    const parts = message.content as Array<{ type?: string; toolCallId?: string }>
    const kept = parts.filter(
      (part) => part?.type !== 'tool-result' || typeof part.toolCallId !== 'string' || expected.has(part.toolCallId),
    )
    if (kept.length === 0) {
      const previous = entries[i - 1]?.message
      const next = entries[i + 1]?.message
      if (entry.provenance.derivedFromPeer || (previous?.role === 'assistant' && next?.role === 'assistant')) {
        entries[i] = {
          ...entry,
          message: {
            role: 'user',
            content: [{ type: 'text', text: '[Stale tool result discarded — no matching tool_call in history.]' }],
          } as ModelMessage,
        }
      } else {
        entries.splice(i, 1)
      }
      changed = true
    } else if (kept.length !== parts.length) {
      entries[i] = { ...entry, message: { ...message, content: kept } as ModelMessage }
      changed = true
    }
  }

  const fulfilled = new Set<string>()
  for (const entry of entries) {
    const message = entry.message
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue
    for (const part of message.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') fulfilled.add(part.toolCallId)
    }
  }

  const orphanParts: Array<{
    type: 'tool-result'
    toolCallId: string
    toolName: string
    output: { type: 'text'; value: string }
  }> = []
  const provenanceSources: TrackedModelMessage[] = []
  for (const id of expected) {
    if (fulfilled.has(id)) continue
    const source = sourceById.get(id)
    if (source) provenanceSources.push(source)
    orphanParts.push({
      type: 'tool-result',
      toolCallId: id,
      toolName: toolNameById.get(id) ?? 'unknown',
      output: {
        type: 'text',
        value:
          'Error: Tool input failed validation (likely missing required fields). The assistant should retry with the correct schema.',
      },
    })
  }
  if (orphanParts.length === 0) return changed
  const tail = entries[entries.length - 1]
  if (tail?.message.role === 'tool' && Array.isArray(tail.message.content)) {
    entries[entries.length - 1] = {
      ...tail,
      message: {
        ...tail.message,
        content: [...(tail.message.content as unknown[]), ...(orphanParts as unknown[])],
      } as ModelMessage,
    }
  } else {
    entries.push(
      createTrackedMessage(
        { role: 'tool', content: orphanParts as never } as ModelMessage,
        mergeProvenance(provenanceSources),
      ),
    )
  }
  return true
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
