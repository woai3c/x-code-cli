// @x-code-cli/core — Shared agent loop state
import type { ModelMessage } from 'ai'

import type { PermissionMode, TodoItem, TokenUsage } from '../types/index.js'
import type { CheckpointEntry } from './snapshot.js'

export interface LoopState {
  messages: ModelMessage[]
  tokenUsage: TokenUsage
  /** Real input-token count from the most recent API response, used to trigger compression. */
  lastInputTokens: number
  sessionId: string
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
  /** Lowercase-hyphen slug derived from the user's first message, used
   *  to give session-usage files a human-skimmable name (mirrors how
   *  plan files are named). Empty string when the first message had no
   *  ASCII content (e.g. CJK-only) — session file then falls back to
   *  pure timestamp. Set ONCE on the first agentLoop turn and never
   *  changed; renaming mid-session would orphan the previous turn's
   *  on-disk usage file. */
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
}

/** Generate a human-skimmable session id: `YYYYMMDD-HHMMSS-mmm` (local
 *  time, milliseconds tail for uniqueness across rapid successive
 *  starts). Replaces the old `Date.now().toString(36)` (`mohbm95d`)
 *  which was unreadable in `ls .x-code/sessions/` — the timestamp shape
 *  matches plan-file naming so the two directory listings sort and
 *  scan the same way. */
function generateSessionId(now: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${pad(now.getMilliseconds(), 3)}`
  )
}

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
    sessionId: generateSessionId(),
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
    prevTurnCacheRead: 0,
    expectCacheMiss: false,
  }
}
