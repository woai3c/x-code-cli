// @x-code-cli/core — Public type definitions
import type { LanguageModel, ModelMessage } from 'ai'

import type { EditDiffPayload } from '../agent/diff.js'
import type { SubAgentRegistry } from '../agent/sub-agents/registry.js'
import type { SubAgentEvent } from '../agent/sub-agents/types.js'
import type { CommandRegistry } from '../commands/registry.js'
import type { HookBus } from '../hooks/bus.js'
import type { MemoryService } from '../knowledge/memory/service.js'
import type { MemoryWriteNotice } from '../knowledge/memory/types.js'
import type { McpPermissionStore } from '../mcp/permissions.js'
import type { McpRegistry } from '../mcp/registry.js'
import type { PeerService } from '../peers/service.js'
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

// ─── Execution authority and transcript provenance ───

export interface PeerOrigin {
  instanceId: string
  nameAtReceipt: string
  messageId: string
}

export interface PeerOriginSummary {
  items: PeerOrigin[]
  totalCount: number
  digest: string
  truncated: boolean
}

export type MessageAuthority = 'user' | 'peer' | 'internal'

export interface MessageProvenance {
  authority: MessageAuthority
  derivedFromPeer: boolean
  peerOrigins?: PeerOriginSummary
}

export interface TrackedModelMessage {
  entryId: string
  message: ModelMessage
  provenance: MessageProvenance
}

export interface ContextSecurityState {
  peerInfluenceActive: boolean
  firstTaintedEntryId?: string
  peerOrigins?: PeerOriginSummary
  integrityFailure?: boolean
}

export interface ExecutionAuthority {
  source: 'user' | 'peer'
  peerTainted: boolean
  peerOrigins?: PeerOriginSummary
}

export type ToolCapability =
  | 'pure-compute'
  | 'session-metadata-read'
  | 'content-read'
  | 'sensitive-read'
  | 'network-egress'
  | 'peer-egress'
  | 'opaque-mcp'
  | 'local-mutation'
  | 'configuration-change'
  | 'unknown'

export interface AuthorityApprovalPreview {
  toolName: string
  serverId?: string
  paths?: string[]
  destination?: string
  summary: string
  outboundPayload?: {
    format: 'text' | 'canonical-json' | 'shell-command'
    canonical: string
    byteLength: number
    sha256: string
  }
  complete: boolean
  approvable: boolean
  reason?: string
  authorityHash: string
  canonicalCallSha256: string
}

export interface ClassifiedToolCall {
  capabilities: readonly ToolCapability[]
  approvalPreview: AuthorityApprovalPreview
}

export type AuthorityDecision =
  | {
      kind: 'allow'
      basis: 'pure-compute' | 'session-metadata' | 'user-authority' | 'user-approval-once'
    }
  | { kind: 'ask'; reason: string; preview: AuthorityApprovalPreview }
  | { kind: 'deny'; reason: string }

export interface AuthorityApproval {
  decision: 'allow-once' | 'deny'
  viewedComplete: boolean
  canonicalPayloadSha256?: string
  canonicalCallSha256: string
  authorityHash: string
}

export interface PublicPeer {
  name: string
  address: `peer:${string}`
  cwd: string
  status: 'idle' | 'busy' | 'waiting'
  busyKind?: 'interactive-turn' | 'goal' | 'maintenance'
  startedAt: string
  sessionId?: string
}

export type QueuedAgentInput =
  | { id: string; source: 'user'; display: string; content: string }
  | {
      id: string
      source: 'peer'
      display: string
      content: string
      peer: PublicPeer
      messageId: string
      /** Service-owned inbound ledger key. Kept internal to queue/lifecycle
       *  handoff and never included in model-visible content. */
      inboxKey?: string
    }

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
  kind?: 'command-echo' | 'command-result' | 'peer-message' | 'peer-status'
  peer?: {
    name: string
    address: string
    summary?: string
  }
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
  /** Peer-influenced calls use a separate allow-once-only surface. The
   *  callback must prove that the complete canonical payload was rendered;
   *  absence of this callback is a fail-closed denial. */
  onAskAuthority?: (request: {
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
    preview: AuthorityApprovalPreview
  }) => Promise<AuthorityApproval>
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
  /** Transient stream reconnect status. A null event means provider data has
   *  resumed or the retry sequence ended. */
  onStreamRetry?: (event: StreamRetryEvent | null) => void
  onError: (error: Error) => void
  /** Fired by the sub-agent runner to stream progress from child agent loops.
   *  The CLI UI uses these events to build the collapsed/expanded task block. */
  onSubAgentEvent?: (event: SubAgentEvent) => void
  /** Optional programmatic telemetry from the durable memory worker. The CLI
   *  intentionally leaves this unset so background persistence stays silent. */
  onMemoryWrite?: (notice: MemoryWriteNotice) => void
}

export interface StreamRetryEvent {
  attempt: number
  maxAttempts: number
  delayMs: number
  reason: 'network' | 'idle-timeout'
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
  /** Experimental tool-surface policy. Defaults to full; standard is honored
   *  only for an explicit allowlist of validated strong models. */
  toolProfile?: 'full' | 'standard'
  /** Whether the root agent may run one-shot local browser visual checks.
   *  Defaults true and is independent from the interactive browser sub-agent. */
  browserVisualCheckEnabled?: boolean
  /** Initial permission mode for the session. Defaults to 'default'.
   *  Set from `--plan` CLI flag or `loadUserConfig().permissionMode`. */
  permissionMode?: PermissionMode
  systemPromptExtra?: string
  abortSignal?: AbortSignal
  /** Explicit invocation authority. The loop always applies the persistent
   *  context taint as a ceiling, even if a caller accidentally passes a clean
   *  value here. */
  executionAuthority?: ExecutionAuthority
  /** Application-level retry budget for a dropped provider stream. */
  streamMaxRetries?: number
  /** Silence between stream chunks before the request is treated as stale.
   *  Zero disables the watchdog. */
  streamIdleTimeoutMs?: number

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

  // ── Mid-turn user message queue (steering) ──

  /** Drain callback for user messages queued while the loop is running.
   *  The agent loop calls this at safe boundaries — after a tool batch
   *  finishes (before the next API request) and on a `stop` finish — and
   *  injects any returned texts as ONE merged user message (wrapped with
   *  a "sent while you were working" marker) into `state.messages`.
   *  MUST have drain semantics: return the current queue contents and
   *  clear it atomically, so a message is never injected twice. Return
   *  undefined/empty when nothing is queued. Absent ⇒ mid-turn queueing
   *  disabled (sub-agents, --print). Mirrors Codex's steer_input and
   *  Claude Code's priority-'next' queue consumption. */
  consumeQueuedInputs?: () => QueuedAgentInput[] | undefined

  /** Process-owned peer service. Present only on the root agent when
   *  cross-session messaging was explicitly enabled at startup. */
  peerService?: PeerService

  /** Global Memory v2 service. Present only on the root agent. */
  memoryService?: MemoryService
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
  sonnet: 'anthropic:claude-sonnet-5',
  opus: 'anthropic:claude-opus-4-8',
  haiku: 'anthropic:claude-haiku-4-5',
  gpt5: 'openai:gpt-5.6-sol',
  gemini: 'google:gemini-3.5-flash',
  deepseek: 'deepseek:deepseek-v4-flash',
  'deepseek-pro': 'deepseek:deepseek-v4-pro',
  qwen: 'alibaba:qwen3.7-max',
  glm: 'zhipu:glm-5.2',
  kimi: 'moonshotai:kimi-k3',
}

// ─── Provider detection order (for smart defaults) ───

export const PROVIDER_DETECTION_ORDER = [
  { envKey: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek:deepseek-v4-flash' },
  { envKey: 'ANTHROPIC_API_KEY', defaultModel: 'anthropic:claude-sonnet-5' },
  { envKey: 'OPENAI_API_KEY', defaultModel: 'openai:gpt-5.6-sol' },
  { envKey: 'ALIBABA_API_KEY', defaultModel: 'alibaba:qwen3.7-max' },
  { envKey: 'GOOGLE_GENERATIVE_AI_API_KEY', defaultModel: 'google:gemini-3.5-flash' },
  { envKey: 'XAI_API_KEY', defaultModel: 'xai:grok-4.5' },
  { envKey: 'ZHIPU_API_KEY', defaultModel: 'zhipu:glm-5.2' },
  { envKey: 'MOONSHOT_API_KEY', defaultModel: 'moonshotai:kimi-k3' },
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
      id: 'anthropic:claude-sonnet-5',
      label: 'Sonnet 5',
      description: 'Best balance, near-Opus coding at $3/$15, 1M context',
      vision: true,
    },
    {
      id: 'anthropic:claude-haiku-4-5',
      label: 'Haiku 4.5',
      description: 'Fastest, cheapest — $1/$5, shorter replies',
      vision: true,
    },
  ],
  openai: [
    {
      id: 'openai:gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      description: 'Flagship, top reasoning + coding, $5/$30, 1M context',
      vision: true,
    },
    {
      id: 'openai:gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      description: 'Balanced tier, $2.50/$15, 1M context',
      vision: true,
    },
    {
      id: 'openai:gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      description: 'Budget tier, $1/$6, 1M context',
      vision: true,
    },
    {
      id: 'openai:gpt-5.4-mini',
      label: 'GPT-5.4 Mini',
      description: 'Cheap mini model, $0.75/$4.50',
      vision: true,
    },
    {
      id: 'openai:gpt-5.4-nano',
      label: 'GPT-5.4 Nano',
      description: 'Cheapest, $0.20/$1.25',
      vision: true,
    },
  ],
  deepseek: [
    {
      id: 'deepseek:deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      description: 'Fast, efficient general-purpose, $0.14/$0.28, 1M context (text-only)',
      vision: false,
    },
    {
      id: 'deepseek:deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      description: 'Flagship, stronger reasoning, $0.44/$0.87, 1M context (text-only)',
      vision: false,
    },
  ],
  alibaba: [
    {
      id: 'alibaba:qwen3.7-max',
      label: 'Qwen3.7 Max',
      description: 'Latest flagship, 1M context, reasoning-native',
      vision: false,
    },
    {
      id: 'alibaba:qwen3.7-plus',
      label: 'Qwen3.7 Plus',
      description: 'Mid-tier, balanced cost/quality',
      vision: false,
    },
    {
      id: 'alibaba:qwen3-coder-plus',
      label: 'Qwen3 Coder Plus',
      description: 'Coding-focused, 1M context',
      vision: false,
    },
    {
      id: 'alibaba:qwq-plus',
      label: 'QwQ Plus',
      description: 'Dedicated reasoning model',
      vision: false,
    },
    {
      id: 'alibaba:qwen3-vl-plus',
      label: 'Qwen3-VL Plus',
      description: 'Vision-language flagship',
      vision: true,
    },
    {
      id: 'alibaba:qwen3-vl-flash',
      label: 'Qwen3-VL Flash',
      description: 'Cheap/fast vision-language model',
      vision: true,
    },
  ],
  google: [
    {
      id: 'google:gemini-3.5-flash',
      label: 'Gemini 3.5 Flash',
      description: 'Latest flagship, agentic + coding, 1M context',
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
    {
      id: 'xai:grok-4.5',
      label: 'Grok 4.5',
      description: 'Flagship, agentic coding, $2/$6, 500k context',
      vision: true,
    },
    {
      id: 'xai:grok-4.3',
      label: 'Grok 4.3',
      description: 'General-purpose, $1.25/$2.50, 1M context',
      vision: true,
    },
  ],
  zhipu: [
    {
      id: 'zhipu:glm-5.2',
      label: 'GLM-5.2',
      description: 'Latest flagship, $1.40/$4.40, 1M context',
      vision: false,
    },
    {
      id: 'zhipu:glm-5',
      label: 'GLM-5',
      description: 'Agentic engineering model, $1/$3.20, 200k context',
      vision: false,
    },
    {
      id: 'zhipu:glm-4.7',
      label: 'GLM-4.7',
      description: 'Cost-efficient, $0.60/$2.20, 128k context',
      vision: false,
    },
    {
      id: 'zhipu:glm-5v-turbo',
      label: 'GLM-5V Turbo',
      description: 'Vision model, $1.20/$4',
      vision: true,
    },
    {
      id: 'zhipu:glm-4.6v',
      label: 'GLM-4.6V',
      description: 'Cheap vision model, $0.30/$0.90',
      vision: true,
    },
  ],
  moonshotai: [
    {
      id: 'moonshotai:kimi-k3',
      label: 'Kimi K3',
      description: 'Flagship, 2.8T params, 1M context, native multimodal',
      vision: true,
    },
    {
      id: 'moonshotai:kimi-k2.7-code',
      label: 'Kimi K2.7 Code',
      description: 'Dedicated coding model, 256k context',
      vision: true,
    },
    {
      id: 'moonshotai:kimi-k2.6',
      label: 'Kimi K2.6',
      description: 'Multimodal general-purpose, 256k context',
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

// ─── Multi-base-URL providers ───
//
// Providers that serve multiple endpoints for the same API (regional
// platforms, plan-specific gateways, etc.). When a user picks a model from
// such a provider, the /model flow shows a picker so they can choose the
// right endpoint. The chosen URL is persisted in UserConfig.baseUrls and
// is the single source of truth — no env var involved.

export const PROVIDER_BASE_URLS: Record<string, { options: readonly { label: string; url: string }[] }> = {
  moonshotai: {
    options: [
      { label: 'api.kimi.com/coding (Coding Plan)', url: 'https://api.kimi.com/coding/v1' },
      { label: 'api.moonshot.cn (China)', url: 'https://api.moonshot.cn/v1' },
      { label: 'api.moonshot.ai (International)', url: 'https://api.moonshot.ai/v1' },
    ],
  },
}

// ─── Per-provider reasoning-effort tiers ───
//
// Providers that expose a granular reasoning-effort knob (beyond binary
// on/off). After picking a model from such a provider, /model shows a
// second picker so the user can choose the effort level. The chosen level
// is persisted per-model in UserConfig.modelReasoningEffort.
//
// Providers with no entry here (alibaba) only support the binary
// /thinking toggle — skip the tier picker.
//
// `modelPattern` gates the tier to the models that actually honor it:
// within a provider, only some model families expose the granular knob
// (e.g. thinkingLevel is Gemini 3-only, Kimi's reasoningEffort is K3-only).
// Models that don't match fall back to the binary /thinking toggle.

export const PROVIDER_REASONING_TIERS: Record<
  string,
  { modelPattern?: RegExp; options: readonly { label: string; value: string; description: string }[] }
> = {
  openai: {
    options: [
      { label: 'Minimal', value: 'minimal', description: 'Bare-minimum reasoning' },
      { label: 'Low', value: 'low', description: 'Fast, concise reasoning' },
      { label: 'Medium', value: 'medium', description: 'Balanced (default)' },
      { label: 'High', value: 'high', description: 'Thorough reasoning' },
    ],
  },
  anthropic: {
    options: [
      { label: 'Low', value: 'low', description: 'Minimal reasoning, fastest' },
      { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
      { label: 'High', value: 'high', description: 'Thorough reasoning (default)' },
    ],
  },
  google: {
    // thinkingLevel is a Gemini 3 feature; Gemini 2.5 uses thinkingBudget.
    modelPattern: /gemini-3/,
    options: [
      { label: 'Low', value: 'low', description: 'Lower latency, lower cost' },
      { label: 'High', value: 'high', description: 'Deeper reasoning, higher quality' },
    ],
  },
  xai: {
    options: [
      { label: 'Low', value: 'low', description: 'Faster, cheaper responses' },
      { label: 'High', value: 'high', description: 'Deeper reasoning' },
    ],
  },
  moonshotai: {
    // reasoning_effort is K3-only; K2.x uses the binary thinking switch.
    modelPattern: /kimi-k3/,
    options: [
      { label: 'Low', value: 'low', description: 'Faster, concise reasoning' },
      { label: 'High', value: 'high', description: 'Deeper reasoning' },
      { label: 'Max', value: 'max', description: 'Maximum reasoning (default)' },
    ],
  },
  deepseek: {
    // V4 Flash and Pro both support low/high/max; medium/xhigh map to high server-side.
    modelPattern: /deepseek-v4/,
    options: [
      { label: 'Low', value: 'low', description: 'Faster, less reasoning' },
      { label: 'High', value: 'high', description: 'Standard reasoning (default)' },
      { label: 'Max', value: 'max', description: 'Maximum reasoning depth' },
    ],
  },
  zhipu: {
    // reasoning_effort is GLM-5.2+; earlier models use the binary thinking switch.
    modelPattern: /glm-5\.2/,
    options: [
      { label: 'High', value: 'high', description: 'Enhanced reasoning' },
      { label: 'Max', value: 'max', description: 'Deep reasoning (default)' },
    ],
  },
}

// ─── Re-export AI SDK types ───

export type { ModelMessage, LanguageModel }

// ─── Re-export sub-agent types ───

export type { SubAgentEvent, SubAgentDefinition, SubAgentTrace } from '../agent/sub-agents/types.js'
export type { SubAgentRegistry } from '../agent/sub-agents/registry.js'
