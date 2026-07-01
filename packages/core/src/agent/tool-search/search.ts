// @x-code-cli/core — Keyword search over the deferred-tool catalog
//
// Deterministic keyword scoring, NO embeddings — a faithful port of Claude
// Code's searchToolsWithKeywords. The model typically queries with a server
// name ("github"), an action word ("create", "list"), or a capability phrase
// ("search the web"); we tokenize the tool name and score term overlap against
// the name parts and the precomputed searchText haystack (which already folds
// in the description and MCP schema property names).
//
// The `select:<name>` exact-load path lives in tool.ts — this file only does
// the fuzzy keyword path. Precision here is not the critical path: the model
// sees exact deferred-tool names in the system prompt and can always `select:`
// them; keyword scoring is just the fallback for when it isn't sure of a name.
import type { DeferredToolEntry } from './catalog.js'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface ParsedName {
  parts: string[]
  full: string
  isMcp: boolean
}

/** Split a tool name into searchable parts: `mcp__server__tool` on `__`/`_`,
 *  regular names on CamelCase + `_`. Lowercased. */
function parseToolName(name: string): ParsedName {
  if (name.startsWith('mcp__')) {
    const withoutPrefix = name.slice(5).toLowerCase()
    const parts = withoutPrefix
      .split('__')
      .flatMap((p) => p.split('_'))
      .filter(Boolean)
    return { parts, full: withoutPrefix.replace(/__/g, ' ').replace(/_/g, ' '), isMcp: true }
  }
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  return { parts, full: parts.join(' '), isMcp: false }
}

/** Keyword search over the deferred catalog. Returns matched callable names,
 *  best first, capped at `maxResults`. */
export function searchDeferredTools(
  query: string,
  catalog: readonly DeferredToolEntry[],
  maxResults: number,
): string[] {
  const queryLower = query.toLowerCase().trim()
  if (!queryLower) return []

  // Fast path: query IS an exact tool name (model used a bare name instead of
  // select:) — return it directly.
  const exact = catalog.find((e) => e.name.toLowerCase() === queryLower)
  if (exact) return [exact.name]

  // mcp__server prefix — model searching by server with the mcp__ prefix.
  if (queryLower.startsWith('mcp__') && queryLower.length > 5) {
    const prefix = catalog
      .filter((e) => e.name.toLowerCase().startsWith(queryLower))
      .slice(0, maxResults)
      .map((e) => e.name)
    if (prefix.length > 0) return prefix
  }

  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 0)

  // `+term` marks a required term — candidates must match all of them.
  const requiredTerms: string[] = []
  const optionalTerms: string[] = []
  for (const t of queryTerms) {
    if (t.startsWith('+') && t.length > 1) requiredTerms.push(t.slice(1))
    else optionalTerms.push(t)
  }
  const scoringTerms = requiredTerms.length > 0 ? [...requiredTerms, ...optionalTerms] : queryTerms

  // Pre-compile word-boundary patterns once (tools × terms reuse them).
  const patterns = new Map<string, RegExp>()
  for (const t of scoringTerms) {
    if (!patterns.has(t)) patterns.set(t, new RegExp(`\\b${escapeRegExp(t)}\\b`))
  }

  let candidates = catalog
  if (requiredTerms.length > 0) {
    candidates = catalog.filter((e) => {
      const parsed = parseToolName(e.name)
      return requiredTerms.every((term) => {
        const p = patterns.get(term)!
        return parsed.parts.includes(term) || parsed.parts.some((part) => part.includes(term)) || p.test(e.searchText)
      })
    })
  }

  const scored = candidates.map((e) => {
    const parsed = parseToolName(e.name)
    let score = 0
    for (const term of scoringTerms) {
      const p = patterns.get(term)!
      // Exact name-part match weighs highest (MCP names are the strongest
      // signal — the model usually knows the server/action it wants).
      if (parsed.parts.includes(term)) score += parsed.isMcp ? 12 : 10
      else if (parsed.parts.some((part) => part.includes(term))) score += parsed.isMcp ? 6 : 5
      // Full-name fallback for edge cases where part-splitting missed it.
      if (parsed.full.includes(term) && score === 0) score += 3
      // Description / schema-property match — word boundary avoids false hits.
      if (p.test(e.searchText)) score += 2
    }
    return { name: e.name, score }
  })

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((x) => x.name)
}
