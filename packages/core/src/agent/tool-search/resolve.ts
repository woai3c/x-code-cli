// @x-code-cli/core — Resolve a toolSearch query against the deferred catalog
//
// Activation model (differs from Claude Code / Codex): they rely on a
// provider-side `defer_loading` + tool_reference / tool_search_output handshake
// to expand a discovered tool's schema server-side. We go through the Vercel AI
// SDK across many providers, which exposes none of that — so we simply splice
// the matched tools into the request `tools` map (see composeTurnTools) and
// they become callable on the NEXT step. Same end result, provider-agnostic, at
// the cost of one extra round-trip per first-use.
//
// This function is PURE: the caller (tool-execution.ts) owns the
// activatedTools mutation and the tool_result push.
import type { DeferredToolEntry } from './catalog.js'
import { searchDeferredTools } from './search.js'

export interface ToolSearchResult {
  /** Model-facing tool_result text. */
  text: string
  /** Callable names to add to LoopState.activatedTools. */
  activated: string[]
}

/** Resolve a toolSearch query against the catalog. Handles both the `select:`
 *  exact-load path and the keyword path. `pendingServers` (if provided) is
 *  surfaced when no match is found — tells the model some MCP servers are
 *  still connecting and it should retry shortly. */
export function runToolSearch(
  query: string,
  maxResults: number,
  catalog: readonly DeferredToolEntry[],
  pendingServers?: readonly string[],
): ToolSearchResult {
  const byName = new Map(catalog.map((e) => [e.name, e]))

  // ── select:<name>,<name> — exact load by name ──
  const selectMatch = query.match(/^select:(.+)$/i)
  if (selectMatch) {
    const requested = selectMatch[1]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const matched: string[] = []
    const missing: string[] = []
    for (const r of requested) {
      const e = byName.get(r) ?? catalog.find((c) => c.name.toLowerCase() === r.toLowerCase())
      if (e) {
        if (!matched.includes(e.name)) matched.push(e.name)
      } else {
        missing.push(r)
      }
    }
    if (matched.length === 0) {
      return {
        text: noMatchText(
          `No deferred tools matched select: ${missing.join(', ')}. Check the exact names under "## Deferred Tools" in the system prompt.`,
          pendingServers,
        ),
        activated: [],
      }
    }
    return { text: formatLoaded(matched, byName, missing), activated: matched }
  }

  // ── bare tool name(s) — implicit select ──
  // The model often lists exact tool names AS the query ("webSearch,webFetch"
  // or "webSearch webFetch") instead of using select:. Fuzzy keyword scoring
  // drops these — a concatenated name like "websearch" doesn't match the split
  // name parts "web"/"search" — so the search returns nothing and the model
  // burns a round-trip re-calling with select:. If EVERY token resolves to a
  // known deferred tool, treat the whole query as an implicit select.
  const bareTokens = query
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (bareTokens.length > 0) {
    const bareMatched: string[] = []
    let allResolved = true
    for (const t of bareTokens) {
      const e = byName.get(t) ?? catalog.find((c) => c.name.toLowerCase() === t.toLowerCase())
      if (!e) {
        allResolved = false
        break
      }
      if (!bareMatched.includes(e.name)) bareMatched.push(e.name)
    }
    if (allResolved) return { text: formatLoaded(bareMatched, byName, []), activated: bareMatched }
  }

  // ── keyword search ──
  const matched = searchDeferredTools(query, catalog, maxResults)
  if (matched.length === 0) {
    return {
      text: noMatchText(
        `No matching deferred tools for "${query}". Browse the "## Deferred Tools" list in the system prompt and retry with different keywords, or use select:<exact_name>.`,
        pendingServers,
      ),
      activated: [],
    }
  }
  return { text: formatLoaded(matched, byName, []), activated: matched }
}

function formatLoaded(matched: string[], byName: Map<string, DeferredToolEntry>, missing: string[]): string {
  const lines = matched.map((n) => {
    const e = byName.get(n)
    return e?.description ? `- ${n}: ${e.description}` : `- ${n}`
  })
  let text = `Loaded ${matched.length} tool(s) — now callable directly on your next step:\n${lines.join('\n')}`
  if (missing.length > 0) text += `\n(not found: ${missing.join(', ')})`
  return text
}

function noMatchText(base: string, pendingServers?: readonly string[]): string {
  if (pendingServers && pendingServers.length > 0) {
    return `${base}\n\nNote: some MCP servers are still connecting (${pendingServers.join(', ')}). Their tools will become available shortly — try searching again.`
  }
  return base
}
