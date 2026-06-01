// @x-code-cli/core — Per-session JSONL transcript store.
//
// One file per session: `.x-code/sessions/<slug>-<sessionId>.jsonl` (slug is
// the same human-readable token used by plan files; falls back to
// timestamp-only naming when the user's first message has no ASCII content).
// The file is append-only; everything we record about a session — header,
// each ModelMessage, periodic token-usage snapshots, compaction boundaries,
// abort markers — lives as one JSON object per line.
//
// Why JSONL and not a single rewritten JSON document:
//   - Crash-safe. A killed process or full-disk error at most loses the line
//     currently being written; everything before it is intact.
//   - Cheap appends. Each turn appends a few hundred bytes; never rewrites.
//   - Mirrors Claude Code's `~/.claude/<project>/<uuid>.jsonl` exactly,
//     including the `compact_boundary` semantics (see `loadSession` below).
//
// This module replaces the old per-session `<id>.usage.json` and
// `<id>.json` (LLM summary) files — both are now meta entries inside the
// jsonl. /usage history and /resume both source from the same file.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { ModelMessage } from 'ai'

import type { PermissionMode, TokenUsage } from '../types/index.js'
import { XCODE_DIR } from '../utils.js'
import { createLoopState } from './loop-state.js'
import type { LoopState } from './loop-state.js'
import type { CheckpointEntry } from './snapshot.js'

const SESSIONS_SUBDIR = 'sessions'

function sessionsDir(cwd: string = process.cwd()): string {
  return path.join(cwd, XCODE_DIR, SESSIONS_SUBDIR)
}

/** Build the on-disk filename for a session. Same shape as plan files
 *  (`<slug>-<id>.<ext>`) so `ls .x-code/sessions/` and `ls .x-code/plans/`
 *  scan the same way. Empty slug (CJK-only first message) collapses to
 *  pure-timestamp naming, matching the plan-file fallback. */
export function getSessionFilePath(
  state: { sessionId: string; taskSlug: string },
  cwd: string = process.cwd(),
): string {
  const base = state.taskSlug ? `${state.taskSlug}-${state.sessionId}` : state.sessionId
  return path.join(sessionsDir(cwd), `${base}.jsonl`)
}

// ── Entry types written to the jsonl ────────────────────────────────────

interface HeaderEntry {
  t: 'meta'
  kind: 'header'
  cwd: string
  gitBranch?: string
  modelId: string
  startedAt: string
  /** Truncated to ~500 chars — enough for the picker to show a recognisable
   *  preview without paying to read the whole first user message off disk. */
  firstPrompt: string
  taskSlug: string
  sessionId: string
}

interface MsgEntry {
  t: 'msg'
  message: ModelMessage
  ts: string
}

interface UsageEntry {
  t: 'meta'
  kind: 'usage'
  usage: TokenUsage
  modelId: string
  ts: string
}

interface CompactBoundaryEntry {
  t: 'meta'
  kind: 'compact-boundary'
  /** Present for deep (LLM-summary) compaction; omitted for light compaction
   *  (loop-guard pruning). The summary text is ALSO embedded in the next
   *  msg line that gets re-flushed, so this is informational — used by
   *  `listSessions` to show "compacted" hints in the picker without
   *  re-reading the post-boundary messages. */
  summary?: string
  ts: string
}

interface InterruptedEntry {
  t: 'meta'
  kind: 'interrupted'
  ts: string
}

/** Rewind checkpoint pointer. Surfaced by `loadSession` so /resume picks
 *  up the same /rewind history. The actual file backups live separately
 *  under `.x-code/file-history/<sessionId>/`. */
interface CheckpointJsonlEntry {
  t: 'meta'
  kind: 'checkpoint'
  ckptId: string
  messageCount: number
  ts: string
  userPrompt: string
}

type Entry = HeaderEntry | MsgEntry | UsageEntry | CompactBoundaryEntry | InterruptedEntry | CheckpointJsonlEntry

// ── Append helpers (fire-and-forget; never throw) ───────────────────────

async function appendLine(filePath: string, entry: Entry): Promise<void> {
  await appendRawLines(filePath, [JSON.stringify(entry)])
}

/** Batch-append pre-serialised jsonl rows. Returns true on success so
 *  callers can keep "only advance state when disk write succeeded" — e.g.
 *  markBoundaryAndReflush mustn't clear the in-memory checkpoint list
 *  unless the boundary actually landed on disk. */
async function appendRawLines(filePath: string, lines: string[]): Promise<boolean> {
  if (lines.length === 0) return true
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.appendFile(filePath, lines.join('\n') + '\n', 'utf-8')
    return true
  } catch {
    // Persistence is best-effort — never block the agent loop on FS errors.
    return false
  }
}

/** Try to read the current git branch from `.git/HEAD`. Cheap, fully sync
 *  on the calling promise; absent / detached-HEAD / non-git all map to
 *  undefined silently. */
async function readGitBranch(cwd: string): Promise<string | undefined> {
  try {
    const head = await readFile(path.join(cwd, '.git', 'HEAD'), 'utf-8')
    const m = head.match(/^ref: refs\/heads\/(.+)$/m)
    return m ? m[1].trim() : undefined
  } catch {
    return undefined
  }
}

/** Write the session header. Idempotent: if the file already exists (resume
 *  path), we skip — the original header is preserved so picker metadata
 *  stays stable across resumes. */
export async function appendHeader(
  state: LoopState,
  modelId: string,
  firstPrompt: string,
  cwd: string = process.cwd(),
): Promise<void> {
  const filePath = getSessionFilePath(state, cwd)
  try {
    await fs.access(filePath)
    return // file already exists — header preserved from original session
  } catch {
    // File doesn't exist — fall through and write the header.
  }
  const gitBranch = await readGitBranch(cwd)
  const entry: HeaderEntry = {
    t: 'meta',
    kind: 'header',
    cwd,
    gitBranch,
    modelId,
    startedAt: state.startedAt,
    firstPrompt: firstPrompt.slice(0, 500),
    taskSlug: state.taskSlug,
    sessionId: state.sessionId,
  }
  await appendLine(filePath, entry)
}

/** Flush every message in `state.messages` past `state.persistedMessageCount`
 *  to the jsonl file. The diff-based design keeps the writer decoupled from
 *  the many places in the agent loop that mutate state.messages directly
 *  (collectTurnResponse, processToolCalls, length-finish nudge, etc.) — we
 *  catch them all by sweeping at turn boundaries.
 *
 *  After deep / light compaction the in-memory array shrinks. Callers must
 *  call `markBoundaryAndReflush` (below) instead of this — that path writes
 *  a compact-boundary marker so the loader can correctly truncate-on-load
 *  and then re-appends the trimmed messages so post-boundary jsonl content
 *  matches the new in-memory state. */
export async function flushPendingMessages(state: LoopState): Promise<void> {
  if (state.persistedMessageCount >= state.messages.length) return
  const filePath = getSessionFilePath(state)
  const ts = new Date().toISOString()
  const lines: string[] = []
  for (let i = state.persistedMessageCount; i < state.messages.length; i++) {
    const message = state.messages[i]
    if (!message) continue
    const entry: MsgEntry = { t: 'msg', message, ts }
    lines.push(JSON.stringify(entry))
  }
  // Preserve the pre-refactor early-bail: when the loop produces nothing
  // (every unpersisted slot was a defensive `!message` skip), leave
  // persistedMessageCount alone so a future repeat-with-real-messages
  // doesn't think it already covered the range.
  if (lines.length === 0) return
  if (await appendRawLines(filePath, lines)) {
    state.persistedMessageCount = state.messages.length
  }
}

/** Append a usage snapshot for the current turn. Called from the agent loop
 *  after `collectTurnResponse` accepts the provider's `usage` object. The
 *  picker reads only the LAST usage line (tail scan) to display per-session
 *  totals — no need to keep older snapshots around any more efficiently. */
export async function appendUsage(state: LoopState, modelId: string): Promise<void> {
  const filePath = getSessionFilePath(state)
  const entry: UsageEntry = {
    t: 'meta',
    kind: 'usage',
    usage: { ...state.tokenUsage },
    modelId,
    ts: new Date().toISOString(),
  }
  await appendLine(filePath, entry)
}

/** Mark a compaction event and re-flush the (just-shrunk) message array.
 *  After this returns, the jsonl post-last-boundary content equals
 *  `state.messages` exactly — `loadSession` reconstructs the same in-memory
 *  state on resume.
 *
 *  Why we re-append instead of relying on the pre-boundary messages: our
 *  `compressMessages` keeps a `recent N` slice verbatim, but those slices
 *  were already persisted before the boundary; the loader's
 *  "everything-after-last-boundary wins" rule would otherwise drop them.
 *  Duplicating ~6 messages on disk is cheap and keeps the load logic
 *  trivial.
 *
 *  Light compaction (loop-guard pruning) calls this with `summary=undefined`
 *  — the trimmed messages still need a boundary so the loader doesn't
 *  resurrect the dropped loop-guard pairs. */
export async function markBoundaryAndReflush(state: LoopState, summary?: string): Promise<void> {
  const filePath = getSessionFilePath(state)
  const ts = new Date().toISOString()
  const boundary: CompactBoundaryEntry = { t: 'meta', kind: 'compact-boundary', ts }
  if (summary !== undefined) boundary.summary = summary
  const lines = [JSON.stringify(boundary)]
  for (const message of state.messages) {
    const entry: MsgEntry = { t: 'msg', message, ts }
    lines.push(JSON.stringify(entry))
  }
  if (!(await appendRawLines(filePath, lines))) return
  state.persistedMessageCount = state.messages.length
  // Compaction shrinks/rewrites the messages array — every prior
  // checkpoint's `messageCount` now points past the end. Clear the
  // in-memory list to mirror the loader's behaviour (which drops
  // pre-boundary checkpoint lines on resume).
  state.checkpoints = []
}

/** Append a rewind checkpoint marker. Fire-and-forget, like the other
 *  append helpers. On resume, `loadSession` collects these into
 *  `LoadedSession.checkpoints` so the picker can offer the same rewind
 *  points across CLI restarts. The "everything-after-last-boundary wins"
 *  loader rule naturally drops checkpoints whose `messageCount` was
 *  invalidated by a compaction. */
export async function appendCheckpoint(state: LoopState, entry: CheckpointEntry): Promise<void> {
  if (!state.sessionId) return
  const filePath = getSessionFilePath(state)
  const jsonl: CheckpointJsonlEntry = {
    t: 'meta',
    kind: 'checkpoint',
    ckptId: entry.ckptId,
    messageCount: entry.messageCount,
    ts: entry.ts,
    userPrompt: entry.userPrompt,
  }
  await appendLine(filePath, jsonl)
}

/** Append an `interrupted` marker. Purely informational — the loader
 *  ignores it for state reconstruction; the picker can show "interrupted"
 *  next to sessions that ended mid-turn so users know what they're
 *  resuming into. */
export async function appendInterrupted(state: LoopState): Promise<void> {
  if (!state.sessionId) return
  const filePath = getSessionFilePath(state)
  const entry: InterruptedEntry = { t: 'meta', kind: 'interrupted', ts: new Date().toISOString() }
  await appendLine(filePath, entry)
}

// ── Read path: load + list ──────────────────────────────────────────────

export interface LoadedSession {
  sessionId: string
  taskSlug: string
  startedAt: string
  modelId: string
  cwd: string
  gitBranch?: string
  firstPrompt: string
  messages: ModelMessage[]
  tokenUsage: TokenUsage
  /** Rewind checkpoints surviving the last compact-boundary (if any).
   *  The backing file manifests live under `.x-code/file-history/<sid>/`. */
  checkpoints: CheckpointEntry[]
  /** Path of the jsonl file so the agent loop can keep appending to the
   *  same file when the user resumes. */
  filePath: string
}

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  currentContextTokens: 0,
}

/** Walk a session jsonl and reconstruct a LoadedSession.
 *
 *  Compact-boundary semantics (matches Claude Code): every time we see a
 *  `compact-boundary` line, the message accumulator is cleared. So the
 *  returned `messages` reflects only what's after the LAST boundary —
 *  which by construction equals the in-memory state at the point of
 *  compaction (see `markBoundaryAndReflush`).
 *
 *  Trailing tool_call / tool_result orphans are trimmed (the next API
 *  request would otherwise reject the message array) — see
 *  `sanitizeMessageTail` for the exact rule. */
export async function loadSession(filePath: string): Promise<LoadedSession | null> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
  let header: HeaderEntry | null = null
  let lastUsage: UsageEntry | null = null
  let messages: ModelMessage[] = []
  let checkpoints: CheckpointEntry[] = []

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: Entry
    try {
      entry = JSON.parse(line) as Entry
    } catch {
      continue // skip malformed lines silently
    }
    if (entry.t === 'meta') {
      if (entry.kind === 'header') {
        header = entry
      } else if (entry.kind === 'usage') {
        lastUsage = entry
      } else if (entry.kind === 'compact-boundary') {
        messages = []
        // Checkpoints anchored to pre-compaction message counts are now
        // meaningless — the array shrank under them. Drop along with msgs.
        checkpoints = []
      } else if (entry.kind === 'checkpoint') {
        checkpoints.push({
          ckptId: entry.ckptId,
          messageCount: entry.messageCount,
          ts: entry.ts,
          userPrompt: entry.userPrompt,
        })
      }
      // 'interrupted' is informational only — doesn't affect state
    } else if (entry.t === 'msg') {
      messages.push(entry.message)
    }
  }
  if (!header) return null

  return {
    sessionId: header.sessionId,
    taskSlug: header.taskSlug,
    startedAt: header.startedAt,
    modelId: header.modelId,
    cwd: header.cwd,
    gitBranch: header.gitBranch,
    firstPrompt: header.firstPrompt,
    messages: sanitizeMessageTail(messages),
    tokenUsage: lastUsage?.usage ?? EMPTY_USAGE,
    checkpoints,
    filePath,
  }
}

type ToolCallPart = { type?: string; toolCallId?: string }

/** Drop trailing assistant tool_calls that have no matching tool_result
 *  later in the array. Providers reject any orphan with "tool_use without
 *  tool_result", so resuming a session that ended mid-tool-execution must
 *  trim back to the last fully-resolved boundary.
 *
 *  Algorithm: collect every toolCallId that has a tool_result somewhere,
 *  then walk back from the end and drop any assistant message whose
 *  tool_call parts include an unresolved id. Stops at the first clean
 *  message (text-only assistant, or assistant whose every tool_call IS
 *  resolved). */
function sanitizeMessageTail(messages: ModelMessage[]): ModelMessage[] {
  const resolvedIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue
    for (const part of msg.content as ToolCallPart[]) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        resolvedIds.add(part.toolCallId)
      }
    }
  }
  let cutAt = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) {
      cutAt = i
      continue
    }
    if (msg.role !== 'assistant') {
      // Bare 'tool' or 'user' at the tail without an upstream tool_call is
      // legal — keep walking; the cut is driven only by orphan tool_calls.
      break
    }
    const content = msg.content
    if (typeof content === 'string') break // text-only assistant — clean tail
    if (!Array.isArray(content)) break
    const hasOrphan = (content as ToolCallPart[]).some(
      (p) => p?.type === 'tool-call' && typeof p.toolCallId === 'string' && !resolvedIds.has(p.toolCallId),
    )
    if (hasOrphan) {
      cutAt = i
      continue
    }
    break
  }
  return cutAt < messages.length ? messages.slice(0, cutAt) : messages
}

// ── List for picker ─────────────────────────────────────────────────────

export interface SessionListEntry {
  filePath: string
  sessionId: string
  taskSlug: string
  firstPrompt: string
  startedAt: string
  modelId: string
  /** File mtime in epoch milliseconds — sort key for the picker. */
  mtime: number
  tokenUsage: TokenUsage | null
}

/** Enumerate every session jsonl in the current project, newest first.
 *  Reads only the head (~8KB, for the header line) and tail (~4KB, for
 *  the last usage line) of each file — no full-file load — so the picker
 *  is responsive even with hundreds of historical sessions. Files
 *  without a parseable header are dropped silently. */
export async function listSessions(cwd: string = process.cwd()): Promise<SessionListEntry[]> {
  const dir = sessionsDir(cwd)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const jsonlFiles = entries.filter((f) => f.endsWith('.jsonl'))
  const results = await Promise.all(
    jsonlFiles.map(async (f) => {
      const filePath = path.join(dir, f)
      try {
        const stat = await fs.stat(filePath)
        const head = await readRange(filePath, 0, Math.min(8 * 1024, stat.size))
        const headerLine = head.split('\n').find((l) => l.includes('"kind":"header"'))
        if (!headerLine) return null
        let header: HeaderEntry
        try {
          header = JSON.parse(headerLine) as HeaderEntry
        } catch {
          return null
        }
        const tailStart = Math.max(0, stat.size - 4 * 1024)
        const tail = await readRange(filePath, tailStart, stat.size - tailStart)
        let tokenUsage: TokenUsage | null = null
        const tailLines = tail.split('\n').reverse()
        for (const l of tailLines) {
          if (!l.trim()) continue
          if (l.includes('"kind":"usage"')) {
            try {
              const e = JSON.parse(l) as UsageEntry
              tokenUsage = e.usage
              break
            } catch {
              // Malformed line — keep scanning earlier lines.
            }
          }
        }
        return {
          filePath,
          sessionId: header.sessionId,
          taskSlug: header.taskSlug,
          firstPrompt: header.firstPrompt,
          startedAt: header.startedAt,
          modelId: header.modelId,
          mtime: stat.mtimeMs,
          tokenUsage,
        } satisfies SessionListEntry
      } catch {
        return null
      }
    }),
  )
  return results.filter((r): r is SessionListEntry => r !== null).sort((a, b) => b.mtime - a.mtime)
}

/** Read [offset, offset+length) bytes of a file as utf-8. Used by
 *  `listSessions` to grab head/tail without slurping the full file. */
async function readRange(filePath: string, offset: number, length: number): Promise<string> {
  if (length <= 0) return ''
  const fh = await fs.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, offset)
    return buf.subarray(0, bytesRead).toString('utf-8')
  } finally {
    await fh.close()
  }
}

/** Pick the most recently modified session file in the current project, or
 *  null if none exist. Used by `xc --continue` / `-c` to skip the picker
 *  and resume the latest session unconditionally. */
export async function pickLatestSession(cwd: string = process.cwd()): Promise<SessionListEntry | null> {
  const all = await listSessions(cwd)
  return all[0] ?? null
}

/** Stable identifier for a session in picker UI. We can't use the filename
 *  directly (it can collide visually when multiple sessions share a slug)
 *  and the sessionId alone isn't unique across renames — but the file path
 *  is, by definition. Hashed to keep the choice label compact. */
export function shortIdFor(filePath: string): string {
  return createHash('sha1').update(filePath).digest('hex').slice(0, 8)
}

/** Build a LoopState seeded from a previously-saved session. The agent
 *  loop accepts `existingState` and will continue appending to the same
 *  jsonl file (filename derives from `sessionId` + `taskSlug`, both
 *  preserved here). `persistedMessageCount` is set to the loaded length
 *  so the very first flush after the next user submit only appends NEW
 *  messages — the loaded tail is already on disk. */
export function hydrateLoopState(loaded: LoadedSession, initialMode: PermissionMode = 'default'): LoopState {
  const state = createLoopState(initialMode)
  state.sessionId = loaded.sessionId
  state.taskSlug = loaded.taskSlug
  state.startedAt = loaded.startedAt
  state.messages = loaded.messages.slice()
  state.tokenUsage = { ...loaded.tokenUsage }
  state.lastInputTokens = loaded.tokenUsage.inputTokens
  state.persistedMessageCount = loaded.messages.length
  state.checkpoints = loaded.checkpoints.slice()
  return state
}
