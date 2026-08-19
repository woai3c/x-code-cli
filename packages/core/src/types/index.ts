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

/** User decision returned by the permission prompt. The object form is a
 *  denial carrying the user's free-text feedback (kimi-cli's "reject with
 *  feedback") — the core appends it to the denial tool result so the
 *  model can adapt its next attempt instead of guessing why it was
 *  refused. */
export type PermissionDecision = 'yes' | 'always' | 'no' | { kind: 'deny'; feedback: string }

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
  }) => Promise<PermissionDecision>
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
  /** Experimental tool-surface policy. Defaults to full. */
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

// ─── Re-export AI SDK types ───

export type { ModelMessage, LanguageModel }

// ─── Re-export sub-agent types ───

export type { SubAgentEvent, SubAgentDefinition, SubAgentTrace } from '../agent/sub-agents/types.js'
export type { SubAgentRegistry } from '../agent/sub-agents/registry.js'
