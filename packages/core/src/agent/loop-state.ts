// @x-code-cli/core — Shared agent loop state
import type { ModelMessage } from 'ai'

import type { PermissionMode, TodoItem, TokenUsage } from '../types/index.js'

export interface LoopState {
  messages: ModelMessage[]
  tokenUsage: TokenUsage
  /** Real input-token count from the most recent API response, used to trigger compression. */
  lastInputTokens: number
  sessionId: string
  startedAt: string
  filesModified: Set<string>
  turnCount: number
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
   *  Shift+Tab (user) or the enterPlanMode/exitPlanMode tools (model).
   *  Read by tool-execution to decide which system prompt overlay
   *  applies and which tools are advertised. */
  permissionMode: PermissionMode
  /** Permission mode the session was in BEFORE entering plan mode, so
   *  exitPlanMode can restore it instead of unconditionally promoting to
   *  'acceptEdits'. Without this, a user in 'default' (each write is
   *  prompted) who entered plan mode and got their plan approved would
   *  silently end up in 'acceptEdits' (writes auto-approved) — surprise
   *  permission upgrade. Set on enterPlanMode, cleared back to undefined
   *  on exit. Matches CC's `prePlanMode` semantics. */
  prePlanMode?: PermissionMode
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
   *  Survives `/clear` (matches Claude Code) so a multi-feature
   *  checklist isn't wiped by an unrelated context reset. */
  todos: TodoItem[]
  /** Working directory the next shell command should run in. Captured from
   *  `pwd` after each shell command completes; null until the first
   *  command runs (then we use Node's `process.cwd()` and let the
   *  capture populate it). The shell tool description promises that
   *  cwd persists between calls — without this state, every spawn used
   *  Node's process.cwd() and `cd subdir && ...` had no effect on the
   *  next call. Survives compaction and /clear (a session-long shell
   *  context, not turn-scoped). */
  shellCwd: string | null
  /** Number of consecutive reactive auto-compactions that completed but
   *  STILL didn't make the next turn fit (i.e., compressed and the very
   *  next API call also returned context_length_exceeded). After
   *  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES we stop retrying — without the
   *  cap, a pathological prompt that compresses but still overflows
   *  loops indefinitely until the user hits Esc, burning API quota every
   *  cycle. Counter resets to 0 on any successful turn (incremented in
   *  compression.ts:handleContextTooLong, reset in runTurn after a
   *  non-error finishReason). */
  consecutiveAutoCompactFails: number
  /** Records of files the model has read this session, keyed by absolute
   *  path. The edit and writeFile tools require an entry here before they
   *  will run, and compare `timestamp` against the file's current mtime
   *  to detect external modifications between read and write. Without
   *  this, the model can blind-edit a file it never read (acting on stale
   *  assumptions) or silently overwrite a user's in-flight IDE edits.
   *
   *  - `timestamp`: file mtime at the time of read, in milliseconds.
   *  - `isPartialView`: true when the read was a partial slice (offset/
   *    limit). Partial reads do NOT count as "read for edit" — the model
   *    must do a full read first, otherwise it could clobber content
   *    outside the slice it actually saw.
   *
   *  Cleared on `/clear` along with `messages`. Survives compaction. */
  readFiles: Map<string, { timestamp: number; isPartialView: boolean }>
  /** Number of messages already persisted to the session jsonl file.
   *  The agent loop calls `flushPendingMessages` at turn boundaries,
   *  which appends `state.messages.slice(persistedMessageCount)` and
   *  bumps the counter. Reset to `state.messages.length` after any
   *  compaction (light or deep) — those rewritten messages get
   *  re-flushed after a `compact-boundary` line so the loader's
   *  "everything-after-last-boundary wins" rule reconstructs the same
   *  in-memory state on resume. See `agent/session-store.ts`. */
  persistedMessageCount: number

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
    turnCount: 0,
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
    readFiles: new Map(),
    shellCwd: null,
    consecutiveAutoCompactFails: 0,
    persistedMessageCount: 0,
  }
}
