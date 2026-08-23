// @x-code-cli/core — Light-weight message compaction (no LLM call)
//
// The main compression path (`compressMessages` in compression.ts) summarises old
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

import type { TrackedModelMessage } from '../types/index.js'

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

export interface TrackedLightCompactResult {
  trackedMessages: TrackedModelMessage[]
  dropped: number
}

/** Tracked variant used by the agent. Tainted loop-guard pairs are retained:
 * ordinary compaction is not a decontamination operation and must never
 * remove the final peer-derived evidence from the active transcript. */
export function lightCompactTrackedMessages(entries: readonly TrackedModelMessage[]): TrackedLightCompactResult {
  const messages = entries.map((entry) => entry.message)
  const candidateIds = collectLoopGuardedIds(messages)
  if (candidateIds.size === 0) return { trackedMessages: entries.slice(), dropped: 0 }

  const taintedIds = new Set<string>()
  for (const entry of entries) {
    if (!entry.provenance.derivedFromPeer || !Array.isArray(entry.message.content)) continue
    for (const part of entry.message.content as Array<{ type?: string; toolCallId?: string }>) {
      if (
        (part?.type === 'tool-call' || part?.type === 'tool-result') &&
        typeof part.toolCallId === 'string' &&
        candidateIds.has(part.toolCallId)
      ) {
        taintedIds.add(part.toolCallId)
      }
    }
  }
  const idsToRemove = new Set([...candidateIds].filter((id) => !taintedIds.has(id)))
  if (idsToRemove.size === 0) return { trackedMessages: entries.slice(), dropped: 0 }

  const out: TrackedModelMessage[] = []
  let dropped = 0
  for (const entry of entries) {
    const message = entry.message
    if (hasDropTargetResult(message)) {
      const ids = Array.isArray(message.content)
        ? (message.content as ToolResultPartLike[])
            .filter(isToolResultDropTarget)
            .map((part) => part.toolCallId)
            .filter((id): id is string => typeof id === 'string')
        : []
      if (ids.some((id) => idsToRemove.has(id))) {
        dropped++
        continue
      }
    }
    const stripped = stripToolCallParts(message, idsToRemove)
    if (stripped == null) {
      dropped++
      continue
    }
    out.push(stripped === message ? entry : { ...entry, message: stripped })
  }
  return { trackedMessages: out, dropped }
}

// ── Smart tool-result truncation ──
//
// Intermediate compaction layer between the loop-guard dropper above and the
// expensive LLM summariser in compression.ts. Replaces old, large tool_result
// payloads with short stubs that preserve what-was-done metadata while
// recovering the majority of the tokens. Stubs include the tool name, key
// input parameters, output size, and a short preview so the model can decide
// whether to re-run the tool.
//
// Designed to delay full compaction — which invalidates the entire prompt
// cache — by freeing context without rewriting the message structure.

/** Tools whose results represent decisions or are already compact — never truncate. */
const NEVER_TRUNCATE_TOOLS = new Set([
  'edit',
  'writeFile',
  'task',
  'activateSkill',
  'todoWrite',
  'askUser',
  'enterPlanMode',
  'exitPlanMode',
])

/** Only truncate results whose text is longer than this (chars). */
const MIN_TRUNCATABLE_CHARS = 500

/** Number of recent messages to protect from truncation. */
const KEEP_RECENT_MESSAGES = 10

/** Max chars to keep from the original output as a preview in the stub. */
const PREVIEW_LINES = 3

const RECOVERABLE_SHELL_TOOLS = new Set(['shell', 'shellOutput', 'killShell'])

function buildStub(toolName: string | undefined, value: string): string {
  const lines = value.split('\n')
  const lineCount = lines.length
  const preview = lines.slice(0, PREVIEW_LINES).join('\n')
  const name = toolName ?? 'unknown'
  const fullOutputLine = RECOVERABLE_SHELL_TOOLS.has(name)
    ? lines.find((line) => line.startsWith('Full output: '))
    : undefined
  return (
    `[Truncated: ${name} output — ${lineCount} lines, ${value.length} chars. ` +
    `Content removed to save context. Re-run the tool if you need the full output.]\n` +
    preview +
    (fullOutputLine ? `\n${fullOutputLine}` : '')
  )
}

export interface TruncateOldToolResultsResult {
  messages: ModelMessage[]
  truncatedCount: number
  charsSaved: number
}

/**
 * Replace old, large tool_result text with compact stubs. Mutates the
 * messages in-place for efficiency (this runs on `state.messages` which is
 * already mutable). Returns stats for the caller to decide whether to
 * proceed to full compaction.
 */
export function truncateOldToolResults(messages: ModelMessage[]): TruncateOldToolResultsResult {
  const protectedStart = Math.max(0, messages.length - KEEP_RECENT_MESSAGES)
  let truncatedCount = 0
  let charsSaved = 0

  for (let i = 0; i < protectedStart; i++) {
    const msg = messages[i]
    if (!msg || msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue

    for (const part of msg.content as unknown as ToolResultPartLike[]) {
      if (part?.type !== 'tool-result') continue
      const output = part.output
      if (!output) continue

      const toolName = (part as { toolName?: string }).toolName
      if (toolName && NEVER_TRUNCATE_TOOLS.has(toolName)) continue

      if (output.type === 'text' && typeof output.value === 'string') {
        if (output.value.length < MIN_TRUNCATABLE_CHARS) continue
        if (output.value.startsWith('[Truncated:')) continue
        const original = output.value
        output.value = buildStub(toolName, original)
        charsSaved += original.length - (output.value as string).length
        truncatedCount++
      }
    }
  }

  return { messages, truncatedCount, charsSaved }
}

export function truncateOldTrackedToolResults(entries: readonly TrackedModelMessage[]): TruncateOldToolResultsResult {
  const messages = entries.map((entry) => entry.message)
  return truncateOldToolResults(messages)
}
