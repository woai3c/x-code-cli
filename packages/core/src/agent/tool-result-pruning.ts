// @x-code-cli/core — Drop stale, fully-superseding tool results from context
//
// Some tools return a large payload that the NEXT call completely replaces: a
// browser accessibility snapshot is the whole page's tree, a screenshot is a
// full image. Only the most recent one is useful — older ones just sit in the
// conversation and get re-billed on every turn. For the browser sub-agent,
// which snapshots and screenshots repeatedly across many turns, that
// compounding dominates the token bill (a tree-only task can still burn tens of
// thousands of tokens just from accumulated snapshots).
//
// This collapses superseded or already-consumed results to short text
// placeholders in place before the request is built. Borrowed from gemini-cli's
// `supersedeSnapshots` (onBeforeTurn) idea. Browser sub-agents keep the newest
// full-page state; the root one-shot check is dropped as soon as a later
// assistant message proves the image has already been inspected.
import type { ModelMessage } from 'ai'

type ToolResultPartLike = {
  type?: string
  toolName?: string
  output?: { type?: string; value?: unknown }
}

function collapsePart(part: ToolResultPartLike, suffix: string, reason: string): void {
  const placeholder = `[${reason} ${suffix} result dropped to save context.]`
  const out = part.output
  if (out?.type === 'text' && out.value === placeholder) return
  part.output = { type: 'text', value: placeholder }
}

/** Replace the output of all-but-the-latest tool-result for each tool whose
 *  name ends with one of `toolSuffixes`. Suffix match (not equality) so a raw
 *  MCP name like 'browser_snapshot' still hits the server-mangled callable name
 *  'browser__browser_snapshot'. Idempotent: an already-collapsed result is left
 *  untouched so the cache prefix stays stable across turns. Mutates in place. */
export function collapseStaleToolResults(messages: ModelMessage[], toolSuffixes: readonly string[]): void {
  if (toolSuffixes.length === 0) return

  // Last message index carrying a result for each suffix — that one survives.
  const lastIdx = new Map<string, number>()
  messages.forEach((msg, i) => {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return
    for (const part of msg.content as ToolResultPartLike[]) {
      if (part.type !== 'tool-result') continue
      const name = part.toolName ?? ''
      for (const suf of toolSuffixes) if (name.endsWith(suf)) lastIdx.set(suf, i)
    }
  })

  messages.forEach((msg, i) => {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return
    for (const part of msg.content as ToolResultPartLike[]) {
      if (part.type !== 'tool-result') continue
      const name = part.toolName ?? ''
      const suf = toolSuffixes.find((s) => name.endsWith(s))
      if (!suf) continue
      if (lastIdx.get(suf) === i) continue // keep the most recent result intact

      collapsePart(part, suf, 'Older')
    }
  })
}

/** Collapse matching tool results that a later assistant message has already
 *  consumed. A result immediately awaiting the model has no later assistant
 *  message and remains intact for exactly the request that needs to see it. */
export function collapseConsumedToolResults(messages: ModelMessage[], toolSuffixes: readonly string[]): void {
  if (toolSuffixes.length === 0) return

  let latestAssistantIndex = -1
  messages.forEach((message, index) => {
    if (message.role === 'assistant') latestAssistantIndex = index
  })
  if (latestAssistantIndex < 0) return

  messages.forEach((message, index) => {
    if (index >= latestAssistantIndex || message.role !== 'tool' || !Array.isArray(message.content)) return
    for (const part of message.content as ToolResultPartLike[]) {
      if (part.type !== 'tool-result') continue
      const name = part.toolName ?? ''
      const suffix = toolSuffixes.find((candidate) => name.endsWith(candidate))
      if (suffix) collapsePart(part, suffix, 'Consumed')
    }
  })
}
