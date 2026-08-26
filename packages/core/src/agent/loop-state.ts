// @x-code-cli/core — Shared agent loop state
import type { ModelMessage } from 'ai'

import type { MemoryRecallAttachment, MemoryRecallTombstone, MemoryRecallTrace } from '../knowledge/memory/types.js'
import type { ReadFileCache } from '../tools/read-file.js'
import { UnifiedShellSessionManager } from '../tools/shell-session/manager.js'
import type { ManagedShellProvider } from '../tools/shell-session/provider.js'
import { getManagedShellProvider } from '../tools/shell-session/providers/index.js'
import type { ShellSessionController } from '../tools/shell-session/types.js'
import type {
  ContextSecurityState,
  ExecutionAuthority,
  PermissionMode,
  TodoItem,
  TokenUsage,
  TrackedModelMessage,
} from '../types/index.js'
import { generateTimestampId } from '../utils.js'
import { createCacheMissSummary } from './cache-stats.js'
import type { CacheMissReason, CacheMissSummary, ProviderTurnUsage } from './cache-stats.js'
import type { GoalInput, GoalState } from './goal/types.js'
import type { CheckpointEntry } from './snapshot.js'
import type { DeferredToolEntry } from './tool-search/catalog.js'
import { createModelMessageView, replaceTrackedMessages } from './tracked-messages.js'
import { createUsageBreakdown } from './usage.js'
import type { UsageBreakdown } from './usage.js'

/** Per-user-submit token snapshot. Each `agentLoop` invocation pushes one
 *  entry recording the delta tokens and tool calls for that step. Persisted
 *  to the session jsonl so `/resume` restores the full step history. */
export interface StepStats {
  /** First 80 chars of the user message */
  prompt: string
  /** Input tokens consumed by this step (delta, not cumulative) */
  inputTokens: number
  /** Output tokens consumed by this step (delta, not cumulative) */
  outputTokens: number
  /** Number of API turns (streamText rounds) in this step */
  turnCount: number
  /** Number of tool calls dispatched in this step */
  toolCallCount: number
  /** ISO timestamp when the step started */
  startedAt: string
}

export interface CheckpointFileCacheEntry {
  size: number
  mtimeMs: number
  hash: string
}

export interface LoopState {
  /** Canonical transcript. Message objects and their provenance always move
   * together; `messages` below is a storage-free compatibility projection. */
  trackedMessages: TrackedModelMessage[]
  messages: ModelMessage[]
  contextSecurity: ContextSecurityState
  executionAuthority: ExecutionAuthority
  /** Last fully committed transcript epoch. Undefined means a new or legacy
   * transcript whose first mutation must be a root snapshot. */
  committedTranscriptEpochId?: string
  transcriptIntegrity: 'clean' | 'legacy' | 'failed'
  transcriptRequiresSnapshot: boolean
  /** Manual tool bodies are captured when buildTools strips `execute`; this
   * guarantees authority evaluation happens before every data-bearing tool. */
  manualToolExecutors: Map<
    string,
    (input: Record<string, unknown>, options: { toolCallId: string; abortSignal?: AbortSignal }) => Promise<unknown>
  >
  tokenUsage: TokenUsage
  /** Cumulative usage indexed two ways. Source and model are parallel views
   *  over the same requests and must never be added together. */
  usageBreakdown: UsageBreakdown
  /** Real input-token count from the most recent API response, used to trigger compression. */
  lastInputTokens: number
  sessionId: string
  /** CLI invocation cwd captured for this runtime. Shell cwd resolution and permission storage use this stable root. */
  projectCwd: string
  /** Exact transcript path. Null for new sessions until appendHeader pins
   *  the timestamp-only path; hydrated legacy sessions preserve their
   *  original slug-prefixed path so resume keeps appending in place. */
  sessionFilePath: string | null
  startedAt: string
  filesModified: Set<string>
  /** Files changed during the current agentLoop invocation, including paths
   *  that were already modified by an earlier submit in this session. */
  turnFilesModified: Set<string>
  /** Rolling record of recently executed tool calls, keyed by a hash of the
   *  tool name + stable-stringified input. Used by the doom-loop guard to
   *  detect when the model is looping on the same failing call. */
  recentToolCalls: Array<{ toolName: string; hash: string }>
  /** Visual-check attempts during the current submit since the most recent
   *  successful file mutation. This gives screenshot QA a bounded circuit
   *  breaker without preventing the normal edit → re-check workflow. */
  visualCheckCallsSinceMutation: number
  /** Cached system prompt text — rebuilt once per session so the prefix
   *  stays byte-stable across turns, enabling automatic prefix-caching on
   *  OpenAI-compatible providers (DeepSeek, Moonshot, Alibaba, …).
   *  Invalidated (set to null) on `permissionMode` change so the next turn
   *  rebuilds it with / without the plan-mode overlay. */
  systemPromptCache: string | null
  /** Exact capability blocks embedded in the cached system prompt, snapshotted
   *  at build time. The context-composition estimator (context-usage.ts)
   *  subtracts these from the prompt to isolate per-category token counts —
   *  recomputing them later would mismatch after a mid-session /skill or
   *  /mcp refresh. Set together with systemPromptCache; undefined for
   *  sub-agents and pre-first-turn states. */
  systemPromptBlocks?: { knowledge: string; skill: string; mcpDeferred: string }
  /** Current approval mode — flips between 'default' and 'plan' via
   *  the /plan slash command (user) or the enterPlanMode/exitPlanMode
   *  tools (model). Read by tool-execution to decide which system
   *  prompt overlay applies and which tools are advertised. */
  permissionMode: PermissionMode
  /** Path to the plan file when in plan mode (`.x-code/plans/{sessionId}.md`),
   *  null otherwise. Created lazily the first time the model calls
   *  `enterPlanMode` and re-used for the remainder of that plan-mode
   *  session. Cleared on exit. */
  currentPlanPath: string | null
  /** Lowercase-hyphen slug derived locally from the user's first message.
   *  Used for readable plan filenames and retained in session metadata for
   *  legacy resume lookups; transcript filenames are timestamp-only. */
  taskSlug: string
  /** Current checklist maintained by the model via the `todoWrite`
   *  tool. Full-replacement semantics — every todoWrite call rewrites
   *  this array. In-memory only, never persisted. Auto-cleared back
   *  to [] when the model submits a list with all items completed.
   *  Cleared on `/clear` and `/resume` (the new LoopState starts
   *  fresh with []); preserved across `/compact` so a multi-step
   *  task survives history summarisation. */
  todos: TodoItem[]
  /** Per-user-message snapshots backing the `/rewind` command. Pushed by
   *  `createCheckpoint` (snapshot.ts) right after each user message lands
   *  in `messages`. In-memory: ring-buffered at 100 entries. Cleared by
   *  `markBoundaryAndReflush` — compaction rewrites the message array
   *  in place, invalidating every prior `messageCount` anchor. Persisted
   *  to the jsonl as `meta:checkpoint` lines; the loader's
   *  "everything-after-last-boundary wins" rule naturally drops pre-
   *  compaction entries on resume. */
  checkpoints: CheckpointEntry[]
  /** Last successfully hashed metadata for files covered by `/rewind`.
   *  Unchanged files reuse their content hash in the next checkpoint. */
  checkpointFileCache: Map<string, CheckpointFileCacheEntry>
  /** Number of messages already persisted to the session jsonl file.
   *  The agent loop calls `flushPendingMessages` at turn boundaries,
   *  which appends `state.messages.slice(persistedMessageCount)` and
   *  bumps the counter. Reset to `state.messages.length` after any
   *  compaction (light or deep) — those rewritten messages get
   *  re-flushed after a `compact-boundary` line so the loader's
   *  "everything-after-last-boundary wins" rule reconstructs the same
   *  in-memory state on resume. See `agent/session-store.ts`. */
  persistedMessageCount: number
  /** Tail of the LoopState-level transcript transaction chain. Both state
   *  derivation (parent epoch/message range) and durable I/O run inside this
   *  chain, so concurrent turn-final and exit-time flushes cannot create
   *  sibling epochs. `saveSession` awaits this full state commit. */
  pendingFlush: Promise<void> | null

  // ── Cache break detection ──

  /** Per-turn cache-read token count from the previous turn. Used to
   *  detect unexpected cache misses (e.g. a code change that broke
   *  system prompt byte-stability). */
  prevTurnCacheRead: number
  /** When true, the next turn's cache-read drop is expected (e.g. after
   *  compaction or permissionMode change) and should not trigger a
   *  warning. Automatically cleared after one turn. */
  expectCacheMiss: boolean
  /** Structured reasons consumed by the next main provider request. */
  expectedCacheMissReasons: Set<CacheMissReason>
  /** Main-request samples only; auxiliary usage snapshots never enter this list. */
  providerTurns: ProviderTurnUsage[]
  /** Incrementally maintained diagnostic summary. Updating it only compares
   *  the newest provider turn with its immediate predecessor. */
  cacheMissSummary: CacheMissSummary

  // ── Sub-agent support (set once in agentLoop, read by tool-execution) ──

  /** Cached knowledge context for sub-agent system prompts. Set once in
   *  agentLoop after buildKnowledgeContext resolves; transparent to
   *  sub-agent loops (they don't call buildKnowledgeContext themselves). */
  knowledgeContext?: string
  /** Whether cwd is a git repo. Cached for sub-agent system prompts. */
  isGitRepo?: boolean

  /** Session-scoped read de-dup cache (absolute path → last-delivered mtime+size).
   *  readFile returns a short stub instead of re-sending full content when a
   *  file is re-read unchanged, saving context tokens. Sub-agents get their
   *  own (fresh LoopState) so caches never cross agents. In-memory only. */
  readFileCache: ReadFileCache

  /** Unified runtime-only shell manager. Its managerInstanceId is regenerated on every create/hydrate. */
  shellSessions: ShellSessionController

  /** Session-scoped durable goal. Mutated by /goal and by getGoal/updateGoal
   *  tools. Dynamic goal details are intentionally kept out of the cached
   *  system prompt; models inspect them through tools or continuation inputs. */
  goal: GoalState | null
  /** Durable queued inputs for the goal runner. These are ordinary user
   *  messages once promoted, but tracked separately so pause/resume/crash
   *  recovery can continue at a safe boundary. */
  goalInputs: GoalInput[]

  /** Per-step token usage snapshots. One entry per `agentLoop` invocation
   *  (= one user submit). Persisted to the session jsonl; restored on
   *  `/resume`. Cleared on `/clear`. */
  stepStats: StepStats[]

  // ── Deferred tools / toolSearch (top-level agent only) ──

  /** Catalog of deferred tools the model can discover via `toolSearch` but
   *  that are NOT in the request tool list until activated. Built once by
   *  buildTools at loop start. Undefined for sub-agents (they keep full tool
   *  injection over their curated, small tool set). */
  deferredCatalog?: DeferredToolEntry[]
  /** Names of deferred tools the model has loaded via `toolSearch` this
   *  session. composeTurnTools splices their definitions into the request
   *  tool set every turn. Persists for the whole session — a loaded tool
   *  stays loaded (matches Claude Code / Codex "discovered tools" semantics).
   *  In-memory only; Set iteration order is insertion order, keeping the
   *  spliced-in tail of the tools map stable across turns. */
  activatedTools: Set<string>

  // ── Memory v2 dynamic recall ──

  memoryGeneration: number
  memoryRecallAttachments: MemoryRecallAttachment[]
  memoryRecallTombstones: MemoryRecallTombstone[]
  surfacedMemoryHashes: Set<string>
  memoryTokensInWindow: number
  lastMemoryRecallTrace: MemoryRecallTrace | null
}

/** Generate a human-skimmable session id: `YYYYMMDD-HHMMSS-mmm` (local
 *  time, milliseconds tail for uniqueness across rapid successive
 *  starts). Replaces the old `Date.now().toString(36)` (`mohbm95d`)
 *  which was unreadable in `ls .x-code/sessions/` — the timestamp shape
 *  matches plan-file naming so the two directory listings sort and
 *  scan the same way. */

export interface CreateLoopStateOptions {
  ownerSessionId?: string
  projectCwd?: string
  shellProvider?: ManagedShellProvider
}

export function createLoopState(
  initialMode: PermissionMode = 'default',
  options: CreateLoopStateOptions = {},
): LoopState {
  const sessionId = options.ownerSessionId ?? generateTimestampId()
  const projectCwd = options.projectCwd ?? process.cwd()
  const state = {
    trackedMessages: [],
    messages: [] as ModelMessage[],
    contextSecurity: { peerInfluenceActive: false },
    executionAuthority: { source: 'user', peerTainted: false },
    transcriptIntegrity: 'clean',
    transcriptRequiresSnapshot: false,
    manualToolExecutors: new Map(),
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      currentContextTokens: 0,
    },
    usageBreakdown: createUsageBreakdown(),
    lastInputTokens: 0,
    sessionId,
    projectCwd,
    sessionFilePath: null,
    startedAt: new Date().toISOString(),
    filesModified: new Set(),
    turnFilesModified: new Set(),
    recentToolCalls: [],
    visualCheckCallsSinceMutation: 0,
    systemPromptCache: null,
    systemPromptBlocks: undefined,
    permissionMode: initialMode,
    // Plan path is derived LAZILY from the user's task text once a
    // message lands — done in agentLoop / enterPlanMode handler. We
    // can't slugify here because the user's intent isn't visible at
    // session-construction time.
    currentPlanPath: null,
    taskSlug: '',
    todos: [],
    checkpoints: [],
    checkpointFileCache: new Map(),
    persistedMessageCount: 0,
    pendingFlush: null,
    prevTurnCacheRead: 0,
    expectCacheMiss: false,
    expectedCacheMissReasons: new Set(),
    providerTurns: [],
    cacheMissSummary: createCacheMissSummary(),
    readFileCache: new Map(),
    shellSessions: new UnifiedShellSessionManager({
      ownerSessionId: sessionId,
      projectCwd,
      provider: options.shellProvider ?? getManagedShellProvider(),
    }),
    goal: null,
    goalInputs: [],
    activatedTools: new Set(),
    stepStats: [],
    memoryGeneration: 0,
    memoryRecallAttachments: [],
    memoryRecallTombstones: [],
    surfacedMemoryHashes: new Set(),
    memoryTokensInWindow: 0,
    lastMemoryRecallTrace: null,
  } satisfies LoopState
  const view = createModelMessageView(state)
  Object.defineProperty(state, 'messages', {
    enumerable: true,
    configurable: false,
    get: () => view,
    set: (messages: ModelMessage[]) => replaceTrackedMessages(state, messages),
  })
  return state
}
