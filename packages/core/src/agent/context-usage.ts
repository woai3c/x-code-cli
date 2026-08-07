// @x-code-cli/core — Context composition breakdown
//
// Providers only ever report the TOTAL input-token count of a request —
// none of them split it into "how much was system prompt vs conversation".
// The /usage composition display therefore estimates each category locally
// (same bytes-per-token ratio as context-window.ts), then calibrates the
// split so the parts sum exactly to the real number the API reported.
//
// Category mapping (mirrors Cursor's Context Usage panel):
//   - system:        base system prompt + plan-mode overlay
//   - tools:         built-in tool JSON schemas sent in the request
//   - rules:         knowledge context (user AGENTS.md, memory profile,
//                    project AGENTS.md chain, AGENTS.local.md)
//   - skills:        the `## Available Skills` block
//   - mcp:           the `## MCP Tools` / `## Deferred Tools` block plus the
//                    schemas of MCP / dynamically-activated tools
//   - subagents:     the task tool's description (embeds the agent list)
//   - summary:       the `[Previous conversation summary]` compaction message
//   - conversation:  everything else in the message history
import type { ModelMessage } from 'ai'

import { zodToJsonSchema } from 'zod-to-json-schema'

import { toSystemPromptEntries } from '../mcp/tool-bridge.js'
import type { AgentOptions } from '../types/index.js'
import { estimateMessageTokenCount, estimateTextTokenCount } from './context-window.js'
import type { LoopState } from './loop-state.js'
import { buildTools } from './loop.js'
import { formatDeferredCapabilities, formatMcpCapabilities, formatSkillCapabilities } from './system-prompt.js'
import { composeTurnTools } from './tool-search/catalog.js'

export type ContextCategoryKey =
  | 'system'
  | 'tools'
  | 'rules'
  | 'skills'
  | 'mcp'
  | 'subagents'
  | 'summary'
  | 'conversation'

export interface ContextCategoryEstimate {
  key: ContextCategoryKey
  label: string
  /** Raw bytes-based estimate, NOT yet calibrated to the real API total. */
  estimatedTokens: number
}

export interface ContextBreakdown {
  /** Non-zero categories in display order (mirrors Cursor's panel order). */
  categories: ContextCategoryEstimate[]
  estimatedTotal: number
}

export interface CalibratedContextCategory extends ContextCategoryEstimate {
  /** Rounded to integers and adjusted so the sum equals `realTotal`. */
  tokens: number
}

export interface ContextBreakdownInput {
  /** The full byte-stable system prompt (`state.systemPromptCache`). */
  systemPrompt: string
  /** Knowledge context embedded at the end of the system prompt. */
  knowledgeContext?: string
  /** Recomputed `## Available Skills` block (may be just the install hint). */
  skillBlock?: string
  /** Recomputed `## MCP Tools` + `## Deferred Tools` blocks (may be ''). */
  mcpDeferredBlock?: string
  messages: ModelMessage[]
  /** The effective tool map for the next request (base + activated). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>
  /** Names of tools that are MCP-backed (or dynamically activated), counted
   *  under the mcp category instead of tools. */
  mcpToolNames?: ReadonlySet<string>
}

// Must stay byte-identical to compression.ts's private constant — the
// estimator relies on the same prefix to detect the compaction message.
const SUMMARY_PREFIX = '[Previous conversation summary]\n'

const CATEGORY_LABELS: Record<ContextCategoryKey, string> = {
  system: 'System prompt',
  tools: 'Tool definitions',
  rules: 'Rules',
  skills: 'Skills',
  mcp: 'MCP & dynamic tools',
  subagents: 'Subagent definitions',
  summary: 'Summarized conversation',
  conversation: 'Conversation',
}

/** Estimate one AI SDK tool definition's wire cost. The SDK serializes a
 *  tool as `{ description, parameters: <JSON schema> }`, so we mirror that
 *  shape. Two inputSchema flavours exist in this codebase:
 *   - zod schemas (built-ins) → convert via zodToJsonSchema. A plain
 *     JSON.stringify of a zod schema would count Zod's internal object
 *     structure instead of the wire payload.
 *   - raw JSON Schema wrapped in `ai`'s jsonSchema() (MCP tools via
 *     bridgeMcpTool) → the wrapper exposes the raw schema via a getter;
 *     use it directly. Feeding the wrapper to zodToJsonSchema throws. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolDefinitionTokens(def: any): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = def as any
  const payload: Record<string, unknown> = {}
  if (typeof t?.description === 'string') payload.description = t.description
  const schema = t?.inputSchema
  if (schema) {
    try {
      // ai's jsonSchema() wrapper: `{ [schemaSymbol]: true, get jsonSchema() {...} }`.
      // Accessing the getter yields the raw JSON Schema; zod schemas have no
      // such property and fall through to the zod conversion.
      const rawJsonSchema =
        typeof schema === 'object' && schema !== null ? (schema as { jsonSchema?: unknown }).jsonSchema : undefined
      if (rawJsonSchema && typeof rawJsonSchema === 'object') {
        payload.parameters = rawJsonSchema
      } else {
        payload.parameters = zodToJsonSchema(schema)
      }
    } catch {
      // Unknown schema flavour (future SDK shape) — count its own serialized
      // size rather than silently billing zero tokens.
      try {
        payload.parameters = JSON.stringify(schema)
      } catch {
        // Unstringifiable (circular) — leave parameters out.
      }
    }
  }
  const serialized = JSON.stringify(payload)
  return serialized === undefined ? 0 : estimateTextTokenCount(serialized)
}

/** Estimate the per-category token split of the next request's context.
 *  Returns an empty breakdown when the system prompt hasn't been built yet
 *  (nothing was ever sent to the model). */
export function estimateContextBreakdown(input: ContextBreakdownInput): ContextBreakdown {
  const systemTotal = estimateTextTokenCount(input.systemPrompt)
  const skillTokens = input.skillBlock ? estimateTextTokenCount(input.skillBlock) : 0
  const mcpBlockTokens = input.mcpDeferredBlock ? estimateTextTokenCount(input.mcpDeferredBlock) : 0
  const rulesTokens = input.knowledgeContext ? estimateTextTokenCount(input.knowledgeContext) : 0
  // The system prompt is a strict concatenation: base (with the capability
  // blocks substituted in) + '\n\n' + knowledge + plan overlay. Subtracting
  // the known sub-blocks isolates the base prompt + overlay exactly.
  const systemTokens = Math.max(0, systemTotal - skillTokens - mcpBlockTokens - rulesTokens)

  let toolsTokens = 0
  let subagentsTokens = 0
  let mcpToolTokens = 0
  for (const [name, def] of Object.entries(input.tools)) {
    if (name === 'task') {
      subagentsTokens += toolDefinitionTokens(def)
    } else if (input.mcpToolNames?.has(name)) {
      mcpToolTokens += toolDefinitionTokens(def)
    } else {
      toolsTokens += toolDefinitionTokens(def)
    }
  }

  let summaryTokens = 0
  let conversationTokens = 0
  const first = input.messages[0]
  const hasSummary =
    first?.role === 'user' && typeof first.content === 'string' && first.content.startsWith(SUMMARY_PREFIX)
  for (let i = 0; i < input.messages.length; i++) {
    const messageTokens = estimateMessageTokenCount(input.messages[i]!)
    if (i === 0 && hasSummary) summaryTokens += messageTokens
    else conversationTokens += messageTokens
  }

  const rawEntries: ContextCategoryEstimate[] = [
    { key: 'system', label: CATEGORY_LABELS.system, estimatedTokens: systemTokens },
    { key: 'tools', label: CATEGORY_LABELS.tools, estimatedTokens: toolsTokens },
    { key: 'rules', label: CATEGORY_LABELS.rules, estimatedTokens: rulesTokens },
    { key: 'skills', label: CATEGORY_LABELS.skills, estimatedTokens: skillTokens },
    { key: 'mcp', label: CATEGORY_LABELS.mcp, estimatedTokens: mcpBlockTokens + mcpToolTokens },
    { key: 'subagents', label: CATEGORY_LABELS.subagents, estimatedTokens: subagentsTokens },
    { key: 'summary', label: CATEGORY_LABELS.summary, estimatedTokens: summaryTokens },
    { key: 'conversation', label: CATEGORY_LABELS.conversation, estimatedTokens: conversationTokens },
  ]

  const categories = rawEntries.filter((entry) => entry.estimatedTokens > 0)

  return {
    categories,
    estimatedTotal: categories.reduce((sum, entry) => sum + entry.estimatedTokens, 0),
  }
}

/** Scale the raw estimates so their sum equals the real input-token count
 *  the provider reported (`realTotal`), absorbing tokenizer drift and
 *  provider-side prompt transforms. Rounding drift lands on the largest
 *  category so the displayed parts always add up to `realTotal`. */
export function calibrateContextBreakdown(breakdown: ContextBreakdown, realTotal: number): CalibratedContextCategory[] {
  if (breakdown.estimatedTotal <= 0 || realTotal <= 0) return []
  const scale = realTotal / breakdown.estimatedTotal
  const categories = breakdown.categories.map((category) => ({
    ...category,
    tokens: Math.round(category.estimatedTokens * scale),
  }))
  const sum = categories.reduce((total, category) => total + category.tokens, 0)
  const drift = realTotal - sum
  if (drift !== 0 && categories.length > 0) {
    const largest = categories.reduce((a, b) => (b.tokens > a.tokens ? b : a))
    largest.tokens = Math.max(0, largest.tokens + drift)
  }
  return categories
}

/** Assemble the estimator input from the live session state, mirroring what
 *  agentLoop actually sends on the next turn: the cached system prompt, the
 *  same capability blocks (recomputed with the same formatters), and the
 *  effective tool map (base + activated deferred tools). Returns null before
 *  the first turn, when no system prompt has been built yet. */
export function buildContextBreakdownInput(options: AgentOptions, state: LoopState): ContextBreakdownInput | null {
  if (!state.systemPromptCache) return null

  // buildTools is the loop's session-start routine and re-populates
  // state.deferredCatalog (deterministic — content-identical to the existing
  // catalog, but a NEW reference). This is a read-only report path: snapshot
  // and restore so live session state is never mutated by it.
  const catalogBefore = state.deferredCatalog
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let baseTools: Record<string, any>
  try {
    baseTools = buildTools(options, state)
  } finally {
    state.deferredCatalog = catalogBefore
  }
  const tools = composeTurnTools(baseTools, state.deferredCatalog, state.activatedTools, state.permissionMode)

  // Prefer the blocks snapshotted at prompt-build time (loop.ts): a
  // mid-session /skill or /mcp refresh changes what the registries would
  // produce NOW, which would no longer match what is embedded in
  // systemPromptCache. Fall back to recomputing for states that never went
  // through the prompt build (tests, resumed sessions before the next turn).
  const blocks = state.systemPromptBlocks
  const skillBlock = blocks?.skill ?? formatSkillCapabilities(options.skillRegistry?.list())
  const mcpDeferredBlock =
    blocks?.mcpDeferred ??
    (state.deferredCatalog
      ? formatDeferredCapabilities(
          state.deferredCatalog.map((entry) => ({
            name: entry.name,
            serverName: entry.serverName,
            source: entry.source,
          })),
        )
      : formatMcpCapabilities(options.mcpRegistry ? toSystemPromptEntries(options.mcpRegistry.list()) : undefined))

  // MCP-backed tools: alwaysLoad entries are registered directly in
  // buildTools, the rest arrive via the deferred catalog. The registry list
  // also covers the no-deferral fallback (weak model / tiny catalog) where
  // every MCP tool is injected full.
  const mcpToolNames = new Set<string>()
  for (const entry of state.deferredCatalog ?? []) {
    if (entry.source === 'mcp') mcpToolNames.add(entry.name)
  }
  for (const entry of options.mcpRegistry?.list() ?? []) {
    mcpToolNames.add(entry.callableName)
  }

  return {
    systemPrompt: state.systemPromptCache,
    knowledgeContext: blocks?.knowledge ?? state.knowledgeContext ?? '',
    skillBlock,
    mcpDeferredBlock,
    messages: state.messages,
    tools,
    mcpToolNames,
  }
}
