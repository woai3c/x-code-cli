// @x-code-cli/core — Public type definitions
import type { LanguageModel, ModelMessage } from 'ai'

import type { EditDiffPayload } from '../agent/diff.js'
import type { SubAgentRegistry } from '../agent/sub-agents/registry.js'
import type { SubAgentEvent } from '../agent/sub-agents/types.js'
import type { CommandRegistry } from '../commands/registry.js'
import type { HookBus } from '../hooks/bus.js'
import type { McpPermissionStore } from '../mcp/permissions.js'
import type { McpRegistry } from '../mcp/registry.js'
import type { PluginRegistry } from '../plugins/registry.js'
import type { SkillRegistry } from '../skills/registry.js'

// ─── Permission ───

export type PermissionLevel = 'always-allow' | 'ask' | 'deny'

/** Approval mode for the current session.
 *
 *    'default'      — normal flow: write tools ask, model can call anything.
 *    'plan'         — read-only mode: the model is told (via system-prompt
 *                     overlay) to explore + write a plan to a session-local
 *                     plan file but make no other edits. Enforcement is
 *                     prompt-based — matching Claude Code, no hard
 *                     permission-layer block — so a non-compliant model
 *                     would still hit the regular `ask` prompt for
 *                     write/edit/shell.
 *    'acceptEdits'  — write tools (writeFile / edit) auto-approve without
 *                     asking; shell still goes through normal classification
 *                     (always-allow / ask / deny) so destructive commands
 *                     stay gated. Useful right after a plan is approved —
 *                     the user already vetted the plan, having to click
 *                     "Yes" on every writeFile during implementation is
 *                     pure friction. exitPlanMode auto-switches into this
 *                     mode on approval. */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan'

// ─── Todo list (TodoWrite tool) ───

/** A single entry on the model's working checklist.
 *
 *    content    — imperative phrasing of the task ("Update auth handler")
 *    activeForm — present-continuous phrasing for the live indicator
 *                 ("Updating auth handler"); shown in UI while status is
 *                 'in_progress' so the user sees what the agent is doing
 *                 right now.
 *    status     — 'pending' | 'in_progress' | 'completed'.
 *
 *  Mirrors Claude Code's TodoWrite payload shape verbatim. Persisted
 *  in-memory only (LoopState.todos), per-session, no disk. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  activeForm: string
  status: TodoStatus
}

// ─── Token usage ───

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** Cached prompt tokens read (Anthropic cache_read, OpenAI cached_tokens, etc.).
   *  Billed at a fraction of normal input rate — ratio depends on the provider.
   *  Already counted in `inputTokens`; this field is purely informational. */
  cacheReadTokens: number
  /** Tokens written to provider-side cache (Anthropic cache_creation_input_tokens).
   *  Billed at a premium over normal input rate but unlocks cheap reads on
   *  subsequent turns. Zero on providers that don't separate creation from read. */
  cacheCreationTokens: number
  /** Current context-window occupancy — `input_tokens + output_tokens` of
   *  the MOST RECENT API response (`inputTokens` already includes cache_read
   *  + cache_write since AI SDK v6 normalises them into one field). Unlike
   *  the cumulative fields above, this is a SNAPSHOT — overwritten each
   *  turn, not accumulated. Drives the footer "N / M · X%" indicator.
   *
   *  Why input + output (matching every provider's definition):
   *  every major LLM API — Anthropic, OpenAI, Google Gemini, DeepSeek,
   *  Moonshot, Alibaba, xAI — defines "context window" as the shared
   *  budget pool of input + output, with `input + output ≤ context_window`
   *  as the architectural constraint (single KV-cache cap). Showing input
   *  alone in the footer would be a different number than what users see
   *  when reading provider docs about model context windows. The cumulative
   *  fields above remain for `/usage` billing summaries. */
  currentContextTokens: number
}

// ─── Display messages ───

export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: DisplayToolCall[]
  timestamp: number
  /** True for assistant text chunks emitted mid-stream (one per newline).
   *  Rendered WITHOUT the trailing blank line that regular messages append,
   *  so consecutive chunks join into a single paragraph visually. Keeps
   *  streaming text out of the bottom cell buffer (avoids row-shift jitter)
   *  by sending each complete line directly to scrollback. */
  streamingChunk?: boolean
  /** Compact slash-command rendering, matching Claude Code's 2-line block:
   *    > /model
   *      ⎿  Set model to Sonnet 4.6
   *  'command-echo' (user role) drops the trailing blank that regular user
   *  messages append; 'command-result' (assistant role) renders with the
   *  ⎿ prefix and a single trailing newline instead of markdown + \n\n.
   *  Used only for short, single-line command responses. Long multi-line
   *  output (/help, /usage) keeps the regular assistant-message path. */
  kind?: 'command-echo' | 'command-result'
}

export interface DisplayToolCall {
  id: string
  toolName: string
  input: Record<string, unknown>
  output?: string
  /** `error` marks a tool that finished but with a non-zero exit / thrown
   *  exception — the stdout-writer renders its result body in red so
   *  failures stand out in scrollback. `denied` is reserved for the
   *  permission-denial path. */
  status: 'pending' | 'running' | 'completed' | 'denied' | 'error'
  /** How long the tool call took to execute (milliseconds) */
  durationMs?: number
  /** Structured patch produced by writeFile / edit — drives the colored
   *  diff block under the tool bullet in scrollback. Absent for non-edit
   *  tools, hydrated history (we don't recompute on session resume), and
   *  edits that actually had no effect (oldContent === newContent). */
  editPayload?: EditDiffPayload
}

// ─── Agent callbacks (core → UI bridge) ───

export interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onToolCall: (toolCallId: string, toolName: string, input: Record<string, unknown>) => void
  /** Streamed progress messages emitted by a tool while it runs (e.g.
   *  "Searching: query" → "Found 5 results"). Only the LATEST message is
   *  shown in the live UI; the final summary comes through onToolResult. */
  onToolProgress: (toolCallId: string, message: string) => void
  onToolResult: (toolCallId: string, result: string, isError?: boolean) => void
  /** Optional. Fired right BEFORE `onToolResult` for a successful
   *  writeFile / edit, carrying the structured patch + line counts so the
   *  UI can render a diff block under the tool bullet. Skipped for
   *  permission-denied / errored writes (the file wasn't actually changed)
   *  and for no-op edits that produced an identical file. */
  onFileEdit?: (toolCallId: string, payload: EditDiffPayload) => void
  onAskPermission: (toolCall: {
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
  }) => Promise<'yes' | 'always' | 'no'>
  onAskUser: (question: string, options: { label: string; description: string }[]) => Promise<string>
  /** Triggered by `exitPlanMode`. Resolve `true` to leave plan mode and
   *  let the model start implementing; resolve `false` to reject the plan
   *  and keep the model in plan mode for further iteration. */
  onPlanApprovalRequest: (planText: string) => Promise<boolean>
  /** Fired whenever permissionMode flips so the UI can resync the bottom
   *  indicator and (when persisting) write the new value to user config. */
  onPlanModeChange: (mode: PermissionMode) => void
  /** Fired after the model calls `todoWrite` so the UI can show the
   *  current checklist. The full list is passed every call (todoWrite
   *  is a full-replacement tool, not a delta) — UI just stores it. */
  onTodosUpdate: (todos: TodoItem[]) => void
  onShellOutput: (chunk: string) => void
  onUsageUpdate: (usage: TokenUsage) => void
  onContextCompressed: (summary: string) => void
  /** Fired at each phase boundary during context compression so the UI
   *  can show a spinner label that tracks progress. */
  onCompressionProgress?: (description: string) => void
  onError: (error: Error) => void
  /** Fired by the sub-agent runner to stream progress from child agent loops.
   *  The CLI UI uses these events to build the collapsed/expanded task block. */
  onSubAgentEvent?: (event: SubAgentEvent) => void
  /** Optional. Fired by the post-turn memory extractor for each fact it
   *  commits to AutoMemory. Surfaces "Remembered: …" in scrollback so the
   *  user can see what the silent extractor saved. The extractor is
   *  fire-and-forget (runs after agentLoop returns), so this callback may
   *  fire AFTER `submit()` resolved and even into the next turn — keep
   *  the closure free of per-turn state. */
  onMemoryWrite?: (notice: MemoryWriteNotice) => void
}

// ─── Agent options ───

export interface AgentOptions {
  modelId: string
  trustMode: boolean
  /** Hard cap on iterations within a single `agentLoop` invocation. When
   *  omitted, the loop runs without a turn cap — the user's Esc / Ctrl+C
   *  is the only stop. Sub-agents and `--print` mode are the two real
   *  callers that pass a value; interactive sessions leave it unset. */
  maxTurns?: number
  printMode: boolean
  /** When true, the agent loop opts into the maximum reasoning each
   *  provider supports (see providers/thinking.ts for the mapping).
   *  Persisted in `~/.x-code/config.json` as `thinking: boolean`,
   *  toggled at runtime via `/thinking on|off`. Defaults to false. */
  thinking?: boolean
  /** Initial permission mode for the session. Defaults to 'default'.
   *  Set from `--plan` CLI flag or `loadUserConfig().permissionMode`. */
  permissionMode?: PermissionMode
  systemPromptExtra?: string
  abortSignal?: AbortSignal

  // ── Sub-agent support ──

  /** Provider registry for resolving sub-agent model overrides.
   *  Injected by the CLI at startup. Absent = sub-agents inherit the
   *  parent model (no independent model selection). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modelRegistry?: { languageModel: (...args: any[]) => LanguageModel }
  /** Sub-agent registry. Injected by the CLI at startup after scanning
   *  built-in + custom agent definitions. Absent = task tool is not
   *  registered (no sub-agent support). */
  subAgentRegistry?: SubAgentRegistry
  /** Tool allow/deny filter. Used by sub-agent loops to restrict
   *  which tools the child can call. `task` is always in `deny`. */
  toolFilter?: { allow?: string[]; deny?: string[] }
  /** Shell command keywords to deny before permission checks. Used by
   *  sub-agents whose tool surface includes shell but must remain read-only. */
  shellRestrictions?: readonly string[]
  /** Deny non-read-only shell commands without prompting. Used by
   *  independent verifier agents that must never mutate inspected state. */
  shellReadOnlyOnly?: boolean

  /** Tool-name suffixes whose older results get collapsed to a placeholder
   *  before each request (keeping only the latest), to stop large
   *  fully-superseding payloads — browser accessibility snapshots and
   *  screenshots — from re-billing every turn. Set by the browser sub-agent;
   *  unset (the default) means no collapsing. Matched as a suffix so a raw MCP
   *  name like 'browser_snapshot' hits the mangled callable name. */
  collapseStaleToolResults?: readonly string[]

  // ── Skill support ──

  /** Skill registry, populated at CLI startup by createSkillRegistry.
   *  Absent means no skills are configured — activateSkill tool is not
   *  registered and the `## Available Skills` section is omitted from
   *  the system prompt. */
  skillRegistry?: SkillRegistry

  // ── MCP support ──

  /** MCP registry, populated at CLI startup by loadMcpServers. Absent
   *  means MCP is disabled entirely (no servers configured) — agent
   *  loop short-circuits all MCP machinery. The registry itself is
   *  immutable for the session lifetime; `/mcp refresh` replaces the
   *  whole object on the next agentLoop entry. */
  mcpRegistry?: McpRegistry
  /** Permission store for MCP tool calls. Created once per CLI process,
   *  caches the persisted always-allow list + session-scoped allows.
   *  Absent ⇒ tool-execution falls back to ask-every-time semantics. */
  mcpPermissionStore?: McpPermissionStore
  /** Fired by the CLI when background MCP connections finish (async
   *  startup Phase 2). The agent layer uses this to invalidate
   *  `systemPromptCache` + `deferredCatalog` so the next turn picks
   *  up newly-available MCP tools. */
  onMcpReady?: () => void

  // ── Plugin support ──

  /** Plugin registry, populated at CLI startup by loadAllPlugins. Holds
   *  every successfully-loaded plugin (enabled + disabled), exposed so
   *  the `/plugin ...` slash command family can list / inspect / toggle
   *  without re-scanning the cache. Plugin contributions (skills /
   *  agents / mcp) are already merged into their respective registries
   *  by the CLI startup wiring — this field is only the metadata
   *  surface for the slash command UI. Absent ⇒ plugins disabled
   *  (`--no-plugins`) or no plugins installed. */
  pluginRegistry?: PluginRegistry

  /** Hook bus built from enabled plugins' `hooks` contributions. The
   *  agent loop emits SessionStart / UserPromptSubmit / TurnComplete /
   *  SessionEnd events through it; tool-execution adds PreToolUse /
   *  PostToolUse. Absent ⇒ no hook emission (the agent loop skips
   *  emit-sites entirely). Use `emptyHookBus()` for tests / sub-agents
   *  that should be allowed to call into the emit-sites but have no
   *  listeners. */
  hookBus?: HookBus

  /** File-based slash command registry built from plugin-contributed
   *  `commands/` directories. The App.tsx default slash dispatcher
   *  checks this after the built-in command list and skill registry;
   *  matching a name here expands the command body (with $ARGUMENTS
   *  / ${CLAUDE_PLUGIN_ROOT} substitution) and submits as a model
   *  prompt. Absent ⇒ no plugin commands available. */
  commandRegistry?: CommandRegistry
}

// ─── Knowledge ───

/**
 * Category taxonomy for auto memory entries. Categories describe the TYPE of
 * knowledge (who it's about, how it was learned) rather than the topic —
 * this mirrors the taxonomy Claude Code uses and produces sharper memories
 * because each category has distinct trigger conditions for the agent.
 *
 * - user:      Facts about the human user — role, expertise, goals, constraints
 * - feedback:  Corrections or validated approaches ("don't mock the db", "yes, that was right")
 * - project:   Ongoing work, initiatives, decisions, non-obvious project state
 * - reference: Pointers to external systems (Linear project, Grafana dashboard, etc.)
 */
export type KnowledgeCategory = 'user' | 'feedback' | 'project' | 'reference'

export interface KnowledgeFact {
  key: string
  fact: string
  category: KnowledgeCategory
  date: string
}

/** Surface event emitted by the post-turn memory extractor when it commits
 *  a fact to AutoMemory. Lets the UI render a "Remembered: …" line in
 *  scrollback so the user has visibility into otherwise-silent writes. */
export interface MemoryWriteNotice {
  scope: 'project' | 'user'
  category: KnowledgeCategory
  key: string
  fact: string
}

export interface SessionSummary {
  id: string
  title: string
  startedAt: string
  endedAt: string
  status: 'completed' | 'in_progress' | 'abandoned'
  summary: string
  keyResults: string[]
  pendingWork: string[]
  filesModified: string[]
  decisions: string[]
}

// ─── Model aliases ───

export const MODEL_ALIASES: Record<string, string> = {
  fable: 'anthropic:claude-fable-5',
  sonnet: 'anthropic:claude-sonnet-4-6',
  opus: 'anthropic:claude-opus-4-8',
  haiku: 'anthropic:claude-haiku-4-5',
  gpt5: 'openai:gpt-5.5',
  gpt4: 'openai:gpt-4.1',
  gemini: 'google:gemini-3.5-flash',
  deepseek: 'deepseek:deepseek-v4-flash',
  'deepseek-pro': 'deepseek:deepseek-v4-pro',
  qwen: 'alibaba:qwen3.7-max',
  glm: 'zhipu:glm-5.1',
  kimi: 'moonshotai:kimi-k2.6',
}

// ─── Provider detection order (for smart defaults) ───

export const PROVIDER_DETECTION_ORDER = [
  { envKey: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek:deepseek-v4-flash' },
  { envKey: 'ANTHROPIC_API_KEY', defaultModel: 'anthropic:claude-sonnet-4-6' },
  { envKey: 'OPENAI_API_KEY', defaultModel: 'openai:gpt-5.5' },
  { envKey: 'ALIBABA_API_KEY', defaultModel: 'alibaba:qwen3.7-max' },
  { envKey: 'GOOGLE_GENERATIVE_AI_API_KEY', defaultModel: 'google:gemini-3.5-flash' },
  { envKey: 'XAI_API_KEY', defaultModel: 'xai:grok-4.3' },
  { envKey: 'ZHIPU_API_KEY', defaultModel: 'zhipu:glm-5.1' },
  { envKey: 'MOONSHOT_API_KEY', defaultModel: 'moonshotai:kimi-k2.6' },
] as const

// ─── Curated model catalog per provider (for interactive /model picker) ───

export interface ProviderModel {
  /** Full `<provider>:<model>` id passed to AI SDK */
  id: string
  /** Short display label shown in the picker */
  label: string
  /** One-line description shown under the label */
  description: string
  /** True if this specific model can natively SEE images (multimodal), not
   *  just whether its provider's API accepts image parts. Drives the browser
   *  agent's visual gating (modelSupportsVision) so a text-only model never
   *  gets `--caps vision` / screenshots. Set per-model because providers mix
   *  vision and text-only models under one id namespace (e.g. Qwen-VL vs
   *  Qwen-Max, GLM-4V vs GLM-5). */
  vision: boolean
}

/**
 * Hand-curated models per provider, shown in the interactive `/model` picker.
 * Every entry carries a `vision` flag (does this model natively see images),
 * which `modelSupportsVision` reads to gate the browser agent's visual mode.
 * Vision-language variants are listed alongside the text flagships rather than
 * omitted, so picking a vision model is one keystroke. Users can still type any
 * full id into `/model <provider>:<model>` for variants not listed here.
 *
 * Vision flags reflect model FAMILY: Claude / GPT / Gemini / Grok flagships and
 * Kimi K2.x are multimodal; DeepSeek and the Qwen-Max / GLM text flagships are
 * text-only; the dedicated *-VL / GLM-4V / *-vision-preview models see images.
 * (GLM text-flagship vision is marked conservatively as false — they could not
 * be verified live; the GLM-4V entries cover the confirmed-vision path.)
 */
export const PROVIDER_MODELS: Record<string, readonly ProviderModel[]> = {
  anthropic: [
    {
      id: 'anthropic:claude-fable-5',
      label: 'Fable 5',
      description: 'Most capable model, strongest reasoning + agentic, 1M context',
      vision: true,
    },
    {
      id: 'anthropic:claude-opus-4-8',
      label: 'Opus 4.8',
      description: 'Top Opus-tier, complex reasoning + agentic coding, 1M context',
      vision: true,
    },
    {
      id: 'anthropic:claude-sonnet-4-6',
      label: 'Sonnet 4.6',
      description: 'Balanced speed + intelligence, 1M context',
      vision: true,
    },
    {
      id: 'anthropic:claude-haiku-4-5',
      label: 'Haiku 4.5',
      description: 'Fastest, cheapest — shorter replies',
      vision: true,
    },
  ],
  openai: [
    { id: 'openai:gpt-5.5', label: 'GPT-5.5', description: 'Flagship, complex reasoning + coding', vision: true },
    {
      id: 'openai:gpt-5.4-mini',
      label: 'GPT-5.4 Mini',
      description: 'Strong mini model, coding + agents',
      vision: true,
    },
    { id: 'openai:gpt-4.1', label: 'GPT-4.1', description: 'General-purpose, 1M context window', vision: true },
    { id: 'openai:gpt-4.1-mini', label: 'GPT-4.1 Mini', description: 'Cheaper tier of 4.1, 1M context', vision: true },
    { id: 'openai:o3', label: 'o3', description: 'Reasoning model — retiring Aug 2026', vision: true },
    { id: 'openai:o4-mini', label: 'o4-mini', description: 'Smaller reasoning model', vision: true },
  ],
  deepseek: [
    {
      id: 'deepseek:deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      description: 'Fast, efficient general-purpose, 1M context (text-only)',
      vision: false,
    },
    {
      id: 'deepseek:deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      description: 'Flagship, stronger reasoning, 1M context (text-only)',
      vision: false,
    },
  ],
  alibaba: [
    { id: 'alibaba:qwen3.7-max', label: 'Qwen3.7 Max', description: 'Latest flagship, strongest Qwen', vision: false },
    {
      id: 'alibaba:qwen3-coder-plus',
      label: 'Qwen3 Coder Plus',
      description: 'Tuned for coding tasks, 1M context',
      vision: false,
    },
    { id: 'alibaba:qwq-plus', label: 'QwQ Plus', description: 'Reasoning model', vision: false },
    { id: 'alibaba:qwen3-max', label: 'Qwen3 Max', description: 'Previous flagship, 256k context', vision: false },
    { id: 'alibaba:qwen-plus', label: 'Qwen Plus', description: 'Balanced cost/quality', vision: false },
    { id: 'alibaba:qwen-turbo', label: 'Qwen Turbo', description: 'Cheapest, fast, 1M context', vision: false },
    {
      id: 'alibaba:qwen3-vl-plus',
      label: 'Qwen3-VL Plus',
      description: 'Vision-language flagship — reads images + text',
      vision: true,
    },
    {
      id: 'alibaba:qwen3-vl-flash',
      label: 'Qwen3-VL Flash',
      description: 'Cheap/fast vision-language model',
      vision: true,
    },
    {
      id: 'alibaba:qwen-vl-max',
      label: 'Qwen-VL Max',
      description: 'Strongest prev-gen vision-language model',
      vision: true,
    },
    {
      id: 'alibaba:qwen-vl-plus',
      label: 'Qwen-VL Plus',
      description: 'Balanced cost vision-language model',
      vision: true,
    },
  ],
  google: [
    {
      id: 'google:gemini-3.5-flash',
      label: 'Gemini 3.5 Flash',
      description: 'Latest flagship, agentic + coding',
      vision: true,
    },
    {
      id: 'google:gemini-2.5-pro',
      label: 'Gemini 2.5 Pro',
      description: '1M context, strong long-doc handling',
      vision: true,
    },
    {
      id: 'google:gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
      description: 'Cheaper/faster tier, 1M context',
      vision: true,
    },
  ],
  xai: [
    { id: 'xai:grok-4.3', label: 'Grok 4.3', description: 'Latest flagship, 1M context', vision: true },
    { id: 'xai:grok-3', label: 'Grok 3', description: 'Previous gen (alias → grok-4.3)', vision: true },
  ],
  zhipu: [
    {
      id: 'zhipu:glm-5.1',
      label: 'GLM-5.1',
      description: 'Latest flagship, 200k context, strong coding',
      vision: false,
    },
    { id: 'zhipu:glm-5', label: 'GLM-5', description: 'Agentic engineering model, 200k context', vision: false },
    { id: 'zhipu:glm-4-plus', label: 'GLM-4 Plus', description: 'Previous gen, 128k context', vision: false },
    {
      id: 'zhipu:glm-4v-plus',
      label: 'GLM-4V Plus',
      description: 'Vision model — reads images, charts, UI',
      vision: true,
    },
    {
      id: 'zhipu:glm-4v-flash',
      label: 'GLM-4V Flash',
      description: 'Free vision model, reachable from China',
      vision: true,
    },
  ],
  moonshotai: [
    {
      id: 'moonshotai:kimi-k2.6',
      label: 'Kimi K2.6',
      description: 'Latest, strongest coding + agents, native multimodal (sees images)',
      vision: true,
    },
    {
      id: 'moonshotai:kimi-k2.5',
      label: 'Kimi K2.5',
      description: 'Previous gen, 131k context, multimodal',
      vision: true,
    },
    {
      id: 'moonshotai:moonshot-v1-32k-vision-preview',
      label: 'Moonshot v1 32k Vision',
      description: 'Dedicated vision model, 32k context',
      vision: true,
    },
    {
      id: 'moonshotai:moonshot-v1-128k-vision-preview',
      label: 'Moonshot v1 128k Vision',
      description: 'Dedicated vision model, 128k context',
      vision: true,
    },
  ],
}

// ─── Provider API key URLs ───

export const PROVIDER_KEY_URLS: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/',
  openai: 'https://platform.openai.com/api-keys',
  google: 'https://aistudio.google.com/apikey',
  xai: 'https://console.x.ai/',
  deepseek: 'https://platform.deepseek.com/api_keys',
  alibaba: 'https://dashscope.console.aliyun.com/apiKey',
  zhipu: 'https://open.bigmodel.cn/usercenter/apikeys',
  moonshotai: 'https://platform.moonshot.ai/console/api-keys',
}

// ─── Re-export AI SDK types ───

export type { ModelMessage, LanguageModel }

// ─── Re-export sub-agent types ───

export type { SubAgentEvent, SubAgentDefinition, SubAgentTrace } from '../agent/sub-agents/types.js'
export type { SubAgentRegistry } from '../agent/sub-agents/registry.js'
