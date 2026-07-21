// @x-code-cli/core — Deferred-tool catalog for toolSearch
//
// The top-level agent used to advertise EVERY MCP tool's full JSON Schema in
// the streamText `tools` array, plus every non-core built-in. With a few
// connected MCP servers that's tens of thousands of tokens on EVERY request.
// Claude Code and Codex both solve this the same way: keep the core tools
// loaded, hide the rest behind a single `toolSearch` tool, and load a tool's
// real schema only once the model asks for it.
//
// This module builds the "catalog" of deferred tools — the things the model
// can discover via toolSearch but that are NOT in the request's tool list
// until activated. Each entry carries:
//   - a model-facing name (the callable name),
//   - a precomputed lowercase `searchText` haystack (name tokens + description
//     + MCP schema property names — same idea as Codex's BM25 document),
//   - the AI SDK tool definition to splice back in on activation.
//
// Deferral is a TOP-LEVEL-agent concern only. Sub-agents already run a
// curated, small tool set (via toolFilter) so they keep full injection —
// see buildTools in loop.ts.
import { listMcpResources, readMcpResource } from '../../mcp/resources.js'
import { bridgeMcpTool, truncateDescription } from '../../mcp/tool-bridge.js'
import { toolRegistry } from '../../tools/index.js'
import type { AgentOptions } from '../../types/index.js'

/** Approximate chars-per-token for catalog size estimation. Conservative
 *  (lower = over-counts) so the threshold errs toward enabling deferral. */
const CHARS_PER_TOKEN = 3.0

/** Percentage of context window below which we skip deferral entirely.
 *  Mirrors Claude Code's `tst-auto` DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE.
 *  When catalog total token weight is below this fraction, the overhead
 *  of one extra toolSearch round-trip outweighs the token savings. */
const DEFERRAL_THRESHOLD_PERCENT = 0.1

/** Model patterns whose instruction-following is too weak to reliably
 *  call toolSearch unprompted. These fall back to full injection. Patterns
 *  are matched case-insensitively against the full `provider:model` id. */
const WEAK_MODEL_PATTERNS = [
  'haiku', // Claude Haiku — limited tool_reference support
  'nano', // GPT-5.4-nano
  'glm-4v', // Zhipu vision-only captioners (glm-4v-*, glm-4.6v)
  'glm-5v', // Zhipu vision-only captioners (glm-5v-*)
] as const

/** Non-core built-in tools that are deferred (name-only until toolSearch loads
 *  them). The core editing / search / exec tools (readFile, writeFile, edit,
 *  shell, grep, glob, listDir) plus task / askUser / plan-mode controls stay
 *  directly loaded — they're used on nearly every task and hiding them behind a
 *  search round-trip would hurt far more than the few hundred tokens it saves.
 *  These five are genuinely occasional. Mirrors Claude Code, which marks
 *  WebSearch / WebFetch / TodoWrite (and background-shell-style helpers) as
 *  shouldDefer while keeping file / grep / exec direct. */
export const DEFERRED_BUILTIN_TOOLS = ['webSearch', 'webFetch', 'todoWrite', 'shellOutput', 'killShell'] as const

export interface DeferredToolEntry {
  /** Model-facing callable name — the catalog key, the name the model passes
   *  to `toolSearch` via `select:`, and the key that lands in activatedTools. */
  name: string
  /** Short human description, shown on the activation result line. Truncated. */
  description: string
  /** Lowercased search haystack: tokenized name + description + (for MCP) schema
   *  property names. Matched against by the keyword scorer in search.ts. */
  searchText: string
  source: 'builtin' | 'mcp'
  /** Owning MCP server (mcp source only) — groups the catalog in the system
   *  prompt listing. */
  serverName?: string
  /** The AI SDK tool definition spliced into the request `tools` map when this
   *  entry is activated. Built once here so activation is a cheap map insert. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  def: any
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function descriptionOf(def: any): string {
  const d = def?.description
  return typeof d === 'string' ? d : ''
}

/** Tokenize a tool name into searchable words: split `mcp__server__tool` on
 *  `__` / `_`, and CamelCase on the boundary. Lowercased, space-joined. */
function nameTokens(name: string): string {
  const withoutPrefix = name.startsWith('mcp__') ? name.slice(5) : name
  return withoutPrefix
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/__/g, ' ')
    .replace(/_/g, ' ')
    .toLowerCase()
}

/** Collect property names + nested descriptions from a raw JSON Schema so the
 *  scorer can match a query like "create issue title" against a tool whose
 *  description is terse but whose params are named `title` / `body`. Bounded
 *  recursion — MCP schemas are shallow in practice. */
function collectSchemaText(schema: unknown, out: string[], depth = 0): void {
  if (!schema || typeof schema !== 'object' || depth > 4) return
  const s = schema as Record<string, unknown>
  if (typeof s.description === 'string') out.push(s.description)
  const props = s.properties
  if (props && typeof props === 'object') {
    for (const [key, val] of Object.entries(props as Record<string, unknown>)) {
      out.push(key)
      collectSchemaText(val, out, depth + 1)
    }
  }
  if (s.items) collectSchemaText(s.items, out, depth + 1)
}

function builtinEntry(name: string, def: unknown): DeferredToolEntry {
  const raw = descriptionOf(def)
  const searchText = `${name} ${nameTokens(name)} ${raw}`.toLowerCase()
  return { name, description: truncateDescription(raw), searchText, source: 'builtin', def }
}

/** True when the model is too weak to reliably invoke toolSearch. */
export function isWeakModel(modelId: string): boolean {
  const lower = modelId.toLowerCase()
  return WEAK_MODEL_PATTERNS.some((p) => lower.includes(p))
}

/** Build the full deferred-tool catalog for the current session. Returns an
 *  empty array (= deferral disabled) when:
 *  - the model is in WEAK_MODEL_PATTERNS (can't reliably drive toolSearch), or
 *  - the total catalog weight is below DEFERRAL_THRESHOLD_PERCENT of context.
 *
 *  Order is stable (built-ins first, then MCP grouped by server in registry
 *  order) so the system-prompt listing and any cache prefix stay byte-stable. */
export function buildDeferredCatalog(options: AgentOptions, contextWindow: number): DeferredToolEntry[] {
  // Gate 1: weak models fall back to full injection — they may not call
  // toolSearch unprompted and the user loses access to deferred tools.
  if (options.modelId && isWeakModel(options.modelId)) return []

  const entries: DeferredToolEntry[] = []

  for (const name of DEFERRED_BUILTIN_TOOLS) {
    const def = (toolRegistry as Record<string, unknown>)[name]
    if (def) entries.push(builtinEntry(name, def))
  }

  if (options.mcpRegistry) {
    entries.push(builtinEntry('listMcpResources', listMcpResources))
    entries.push(builtinEntry('readMcpResource', readMcpResource))

    for (const e of options.mcpRegistry.list()) {
      // Gate 3: MCP tools with annotations.alwaysLoad skip deferral — the
      // server author declared this tool is critical enough to always be
      // directly available (e.g. a RAG search tool used on every task).
      if (e.annotations?.alwaysLoad === true) continue

      const schemaText: string[] = []
      collectSchemaText(e.inputSchema, schemaText)
      // Gate 5: searchHint from annotations enriches the search haystack.
      const hint = typeof e.annotations?.searchHint === 'string' ? (e.annotations.searchHint as string) : ''
      const searchText =
        `${e.callableName} ${nameTokens(e.callableName)} ${e.serverName} ${e.description} ${hint} ${schemaText.join(' ')}`.toLowerCase()
      entries.push({
        name: e.callableName,
        description: truncateDescription(e.description),
        searchText,
        source: 'mcp',
        serverName: e.serverName,
        def: bridgeMcpTool(e),
      })
    }
  }

  // Gate 2: if the total catalog schema weight is below the threshold
  // fraction of context, deferral isn't worth the extra round-trip.
  // Estimate using the full tool definition's serialised size (name +
  // description + JSON Schema) — NOT the searchText haystack, which is
  // much smaller than the actual wire payload sent to the API.
  if (entries.length > 0) {
    const totalChars = entries.reduce((sum, e) => {
      const defStr = typeof e.def === 'object' ? JSON.stringify(e.def) : ''
      return sum + e.name.length + defStr.length
    }, 0)
    const estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN)
    const threshold = Math.floor(contextWindow * DEFERRAL_THRESHOLD_PERCENT)
    if (estimatedTokens < threshold) return []
  }

  return entries
}

/** Splice every activated deferred tool's definition into the base tool set
 *  for one turn. Returns `base` unchanged (same reference) when nothing has
 *  been activated, so sessions that never search keep a stable tools prefix.
 *  Activated entries are appended after the stable base keys in insertion
 *  order, so the cached tool-schema prefix only changes at the tail. */
export function composeTurnTools(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  base: Record<string, any>,
  catalog: readonly DeferredToolEntry[] | undefined,
  activated: ReadonlySet<string>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  if (!catalog || activated.size === 0) return base
  const byName = new Map(catalog.map((e) => [e.name, e]))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = { ...base }
  for (const name of activated) {
    const e = byName.get(name)
    if (e) tools[name] = e.def
  }
  return tools
}
