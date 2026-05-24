// @x-code-cli/core — Hooks subsystem types
//
// A hook is a shell command a plugin registers against one of six agent
// lifecycle events. The CLI emits an event payload to the hook on stdin
// as one JSON line; the hook may reply on stdout with a one-line JSON
// `HookDecision` to influence what the agent does next (allow / deny /
// modify args / inject context).
//
// Why shell commands and not a programmatic SDK: lowest barrier to entry
// for plugin authors, matches the format users already see in Claude
// Code, and keeps the surface area small (no plugin code runs inside
// our process). See [[plugin-marketplace-design]] §8 for the full
// rationale.
//
// Why ten events: enough to cover the high-value lifecycle integrations
// (context injection, tool gating, sub-agent audit, compaction
// instrumentation, completion notifications) without exposing every
// internal seam we may want to refactor. Adding events later is cheap;
// removing them is a breaking change. PreCompact / PostCompact and
// SubagentStart / SubagentStop were added in round 2 to match the
// Claude/Codex shape — plugins that want to log every sub-agent
// invocation or persist state before compaction wipes it had no other
// hook to attach to.

export type HookEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PreCompact'
  | 'PostCompact'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'TurnComplete'
  | 'SessionEnd'

/** Subset of events that emit a decision the agent acts on. Other events
 *  are fire-and-forget — hooks may run side effects (logging,
 *  notifications) but the agent ignores their stdout. */
export type DecisionEvent = 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse'

/** One hook entry as it appears in hooks.json. */
export interface HookConfigEntry {
  /** Optional regex matching tool name. Only meaningful for PreToolUse /
   *  PostToolUse — ignored for other events. A missing matcher means
   *  "every tool". */
  matcher?: string
  /** Shell command to run on the current platform when no platform-specific
   *  override below is set. Supports `${pluginDir}` / `${pluginDataDir}` /
   *  `${cwd}` / `${homedir}` / `${env:NAME}` / `${sep}` variable expansion
   *  (see [[variables]]).
   *
   *  We require this even when the platform overrides are set so plugin
   *  authors can't accidentally ship a plugin that runs on *only* one OS
   *  — the base command is the safety net for any platform the author
   *  didn't explicitly think about. */
  command: string
  /** Platform-specific override commands. When set, the matching one
   *  replaces `command` on that OS. Keys match `process.platform`
   *  values; unknown platforms (freebsd / sunos / aix) fall through to
   *  the base `command`. */
  commandWindows?: string
  commandDarwin?: string
  commandLinux?: string
  /** Per-hook timeout in ms (default 5000, capped at 30000). */
  timeout?: number
  description?: string
  /** What to do when the hook exits non-zero or crashes:
   *
   *    'allow'  (default) — log warning, treat as if the hook said allow
   *    'block'            — treat as deny (only meaningful for DecisionEvents)
   *
   *  The default is permissive on purpose: a broken hook must not be
   *  able to wedge the agent loop indefinitely. */
  failurePolicy?: 'allow' | 'block'
}

/** A whole hooks.json file. Each event name maps to an ordered array of
 *  entries — earlier entries run first, and for decision events a deny
 *  short-circuits the rest. */
export type HookConfig = Partial<Record<HookEventName, HookConfigEntry[]>>

/** Session-level context attached to every event payload. */
export interface SessionContext {
  cwd: string
  modelId: string
  /** Optional — when the CLI assigns a session id we pass it through so
   *  hooks can correlate events. */
  sessionId?: string
}

/** Discriminated union of every event payload shape. The `name` field
 *  doubles as the tag. The CLI builds these and hands them to
 *  [[HookBus.emit]] — the executor serialises them as JSON for stdin. */
export type HookEvent =
  | { name: 'SessionStart'; session: SessionContext }
  | { name: 'UserPromptSubmit'; session: SessionContext; prompt: string }
  | {
      name: 'PreToolUse'
      session: SessionContext
      tool: { name: string; args: unknown; callId: string }
    }
  | {
      name: 'PostToolUse'
      session: SessionContext
      tool: { name: string; args: unknown; callId: string; output: string; isError: boolean }
    }
  | {
      name: 'PreCompact'
      session: SessionContext
      /** Why compaction is about to run — useful for hooks that want to
       *  decide whether to checkpoint state or skip. */
      trigger: 'proactive' | 'reactive'
      /** Approximate message count and token count before compaction. */
      messageCount: number
      tokenEstimate: number
    }
  | {
      name: 'PostCompact'
      session: SessionContext
      trigger: 'proactive' | 'reactive'
      /** Message count after compaction — the delta from PreCompact's
       *  messageCount tells the hook how much was reclaimed. */
      messageCount: number
      /** Empty string when the path was a light-compact (no LLM summary
       *  was written). */
      summary: string
    }
  | {
      name: 'SubagentStart'
      session: SessionContext
      agent: {
        /** The sub-agent's registered name (e.g. `code-reviewer`). */
        name: string
        /** The parent agent's one-line task description. */
        description: string
        /** The full prompt the parent agent sent to the sub-agent. */
        prompt: string
      }
    }
  | {
      name: 'SubagentStop'
      session: SessionContext
      agent: {
        name: string
        description: string
      }
      /** Wall-clock duration of the sub-agent run. */
      durationMs: number
      /** How the sub-agent finished. `aborted` includes Esc cancellation
       *  and reaching the per-agent maxTurns cap without finalising. */
      outcome: 'completed' | 'aborted' | 'failed'
      tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number }
    }
  | {
      name: 'TurnComplete'
      session: SessionContext
      turn: number
      tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number }
    }
  | { name: 'SessionEnd'; session: SessionContext }

/** What a hook can ask the agent to do via its stdout JSON. */
export type HookDecision =
  | { decision: 'allow'; context?: string }
  | { decision: 'deny'; reason?: string }
  | { decision: 'modify'; args?: unknown; output?: string; context?: string }

/** A hook ready to execute — paired with its owning plugin's identity
 *  and rootDir so variable expansion can resolve `${pluginDir}`. Built
 *  by [[buildHookRegistry]] at startup, immutable for the session. */
export interface RegisteredHook {
  pluginId: string
  /** Absolute path to the plugin's root dir — substituted into the
   *  hook command via `${pluginDir}`. */
  pluginDir: string
  event: HookEventName
  entry: HookConfigEntry
}
