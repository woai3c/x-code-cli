// @x-code-cli/core — Shared agent loop state
import type { ModelMessage } from 'ai'

import { BackgroundShellRegistry } from '../tools/background-shell.js'
import type { ReadFileCache } from '../tools/read-file.js'
import type { PermissionMode, TodoItem, TokenUsage } from '../types/index.js'
import { generateTimestampId } from '../utils.js'
import type { GoalInput, GoalState } from './goal/types.js'
import type { CheckpointEntry } from './snapshot.js'
import type { DeferredToolEntry } from './tool-search/catalog.js'

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

export interface LoopState {
  messages: ModelMessage[]
  tokenUsage: TokenUsage
  /** Real input-token count from the most recent API response, used to trigger compression. */
  lastInputTokens: number
  sessionId: string
  /** Exact transcript path. Null for new sessions until appendHeader pins
   *  the timestamp-only path; hydrated legacy sessions preserve their
   *  original slug-prefixed path so resume keeps appending in place. */
  sessionFilePath: string | null
  startedAt: string
  filesModified: Set<string>
  /** Rolling record of recently executed tool calls, keyed by a hash of the
   *  tool name + stable-stringified input. Used by the doom-loop guard to
   *  detect when the model is looping on the same failing call. */
  recentToolCalls: Array<{ toolName: string; hash: string }>
  /** Cached system prompt text — rebuilt once per session so the prefix
   *  stays byte-stable across turns, enabling automatic prefix-caching on
   *  OpenAI-compatible providers (DeepSeek, Moonshot, Alibaba, …).
   *  Invalidated (set to null) on `permissionMode` change so the next turn
   *  rebuilds it with / without the plan-mode overlay. */
  systemPromptCache: string | null
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
  /** Number of messages already persisted to the session jsonl file.
   *  The agent loop calls `flushPendingMessages` at turn boundaries,
   *  which appends `state.messages.slice(persistedMessageCount)` and
   *  bumps the counter. Reset to `state.messages.length` after any
   *  compaction (light or deep) — those rewritten messages get
   *  re-flushed after a `compact-boundary` line so the loader's
   *  "everything-after-last-boundary wins" rule reconstructs the same
   *  in-memory state on resume. See `agent/session-store.ts`. */
  persistedMessageCount: number
  /** Promise of the most recent in-flight `appendRawLines` inside
   *  `flushPendingMessages`. `saveSession` awaits this before running
   *  its own flush — without it, print mode's `process.exit()` can
   *  kill the fire-and-forget agentLoop final flush mid-write. */
  pendingFlush: Promise<boolean> | null

  // ── Cache break detection ──

  /** Per-turn cache-read token count from the previous turn. Used to
   *  detect unexpected cache misses (e.g. a code change that broke
   *  system prompt byte-stability). */
  prevTurnCacheRead: number
  /** When true, the next turn's cache-read drop is expected (e.g. after
   *  compaction or permissionMode change) and should not trigger a
   *  warning. Automatically cleared after one turn. */
  expectCacheMiss: boolean

  // ── Sub-agent support (set once in agentLoop, read by tool-execution) ──

  /** Cached knowledge context for sub-agent system prompts. Set once in
   *  agentLoop after buildKnowledgeContext resolves; transparent to
   *  sub-agent loops (they don't call buildKnowledgeContext themselves). */
  knowledgeContext?: string
  /** Whether cwd is a git repo. Cached for sub-agent system prompts. */
  isGitRepo?: boolean

  /** Session-scoped read de-dup cache (absolute path → last-read mtime+size).
   *  readFile returns a short stub instead of re-sending full content when a
   *  file is re-read unchanged, saving context tokens. Sub-agents get their
   *  own (fresh LoopState) so caches never cross agents. In-memory only. */
  readFileCache: ReadFileCache

  /** Background shells started via shell({ runInBackground: true }). Per-agent
   *  (sub-agents get a fresh LoopState). In-memory only; execa's default
   *  cleanup kills any survivors when the CLI process exits. */
  bgShells: BackgroundShellRegistry

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
}

/** Generate a human-skimmable session id: `YYYYMMDD-HHMMSS-mmm` (local
 *  time, milliseconds tail for uniqueness across rapid successive
 *  starts). Replaces the old `Date.now().toString(36)` (`mohbm95d`)
 *  which was unreadable in `ls .x-code/sessions/` — the timestamp shape
 *  matches plan-file naming so the two directory listings sort and
 *  scan the same way. */

export function createLoopState(initialMode: PermissionMode = 'default'): LoopState {
  return {
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      currentContextTokens: 0,
    },
    lastInputTokens: 0,
    sessionId: generateTimestampId(),
    sessionFilePath: null,
    startedAt: new Date().toISOString(),
    filesModified: new Set(),
    recentToolCalls: [],
    systemPromptCache: null,
    permissionMode: initialMode,
    // Plan path is derived LAZILY from the user's task text once a
    // message lands — done in agentLoop / enterPlanMode handler. We
    // can't slugify here because the user's intent isn't visible at
    // session-construction time.
    currentPlanPath: null,
    taskSlug: '',
    todos: [],
    checkpoints: [],
    persistedMessageCount: 0,
    pendingFlush: null,
    prevTurnCacheRead: 0,
    expectCacheMiss: false,
    readFileCache: new Map(),
    bgShells: new BackgroundShellRegistry(),
    goal: null,
    goalInputs: [],
    activatedTools: new Set(),
    stepStats: [],
  }
}
