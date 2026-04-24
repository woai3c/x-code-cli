// @x-code-cli/core — Light-weight message compaction (no LLM call)
//
// The main compression path (`compressMessages` in loop.ts) summarises old
// turns by making a separate `generateText` call — that's a network round
// trip plus a full pass over the messages, which is wasteful when the bulk
// of the context comes from a narrow, obvious source: repeated tool-call
// failures that the loop guard already flagged.
//
// This module runs a cheap O(n) pass that drops the messages we can safely
// throw away without losing signal:
//   - tool-call + tool-result pairs whose result is a `[loop-guard]` notice
//     (the model has already been told to stop; the blocked calls don't
//     teach it anything new on replay)
//   - tool-result payloads that are PowerShell noise stacks older than the
//     most recent one (keep at most the latest so the model can still see
//     the current error shape, drop older duplicates)
//
// Callers should run this BEFORE invoking the LLM summariser so the
// summariser operates on the signal-rich remainder.

import type { ModelMessage } from 'ai'

/** Content of a tool-result part that we should drop on sight. */
const LOOP_GUARD_SENTINEL = '[loop-guard]'

type ToolResultPartLike = {
  type?: string
  toolCallId?: string
  output?: { type?: string; value?: unknown }
}

function isToolResultDropTarget(part: ToolResultPartLike): boolean {
  if (part?.type !== 'tool-result') return false
  const output = part.output
  if (!output) return false
  if (output.type === 'text' && typeof output.value === 'string') {
    return output.value.startsWith(LOOP_GUARD_SENTINEL)
  }
  return false
}

function hasDropTargetResult(msg: ModelMessage): boolean {
  if (msg.role !== 'tool') return false
  const parts = msg.content as unknown as ToolResultPartLike[]
  if (!Array.isArray(parts)) return false
  return parts.some(isToolResultDropTarget)
}

/** Remove an assistant message's tool-call parts for the given id set.
 *  Returns the message as-is if no changes needed, otherwise a shallow copy
 *  with filtered content. If every part is removed, returns null so the
 *  caller can drop the whole message. */
function stripToolCallParts(msg: ModelMessage, idsToRemove: Set<string>): ModelMessage | null {
  if (msg.role !== 'assistant') return msg
  const content = msg.content as unknown as Array<{ type?: string; toolCallId?: string }>
  if (!Array.isArray(content)) return msg

  let changed = false
  const filtered = content.filter((part) => {
    if (part?.type === 'tool-call' && typeof part.toolCallId === 'string' && idsToRemove.has(part.toolCallId)) {
      changed = true
      return false
    }
    return true
  })

  if (!changed) return msg
  if (filtered.length === 0) return null
  return { ...msg, content: filtered } as ModelMessage
}

/** Collect the toolCallIds whose tool-result was a loop-guard notice. */
function collectLoopGuardedIds(messages: ModelMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'tool') continue
    const parts = msg.content as unknown as ToolResultPartLike[]
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (isToolResultDropTarget(part) && typeof part.toolCallId === 'string') {
        ids.add(part.toolCallId)
      }
    }
  }
  return ids
}

export interface LightCompactResult {
  messages: ModelMessage[]
  /** Number of messages dropped. Useful for UI / telemetry — if zero, the
   *  caller may still want to fall through to the LLM summariser. */
  dropped: number
}

/**
 * Drop loop-guard tool-call/result pairs from the message array. Leaves
 * everything else untouched. Does not mutate the input array.
 */
export function lightCompactMessages(messages: ModelMessage[]): LightCompactResult {
  const idsToRemove = collectLoopGuardedIds(messages)
  if (idsToRemove.size === 0) return { messages, dropped: 0 }

  const out: ModelMessage[] = []
  let dropped = 0
  for (const msg of messages) {
    if (hasDropTargetResult(msg)) {
      dropped++
      continue
    }
    const stripped = stripToolCallParts(msg, idsToRemove)
    if (stripped == null) {
      dropped++
      continue
    }
    out.push(stripped)
  }
  return { messages: out, dropped }
}
