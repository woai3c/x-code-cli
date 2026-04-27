// @x-code-cli/core — Shared agent loop state
import type { ModelMessage } from 'ai'

import type { PermissionMode, TokenUsage } from '../types/index.js'

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
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
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
  }
}
