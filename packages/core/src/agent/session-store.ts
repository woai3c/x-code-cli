// @x-code-cli/core — Per-session JSONL transcript store.
//
// One file per session: `.x-code/sessions/<sessionId>.jsonl`.
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
import { readFile } from 'node:fs/promises'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { ModelMessage } from 'ai'

import { resetMemoryRecallWindow } from '../knowledge/memory-recall-state.js'
import type { MemoryRecallAttachment, MemoryRecallTombstone } from '../knowledge/memory-types.js'
import { ensureProjectStorageDir } from '../project-storage.js'
import type { PermissionMode, TokenUsage } from '../types/index.js'
import { XCODE_DIR } from '../utils.js'
import { scanCacheMisses } from './cache-stats.js'
import type { CacheMissSummary, ProviderTurnUsage } from './cache-stats.js'
import type { GoalInput, GoalState, GoalVerificationResult } from './goal/types.js'
import { createLoopState } from './loop-state.js'
import type { LoopState, StepStats } from './loop-state.js'
import type { CheckpointEntry } from './snapshot.js'
import { cloneUsageBreakdown, createUsageBreakdown } from './usage.js'
import type { UsageBreakdown } from './usage.js'

const SESSIONS_SUBDIR = 'sessions'

function sessionsDir(cwd: string = process.cwd()): string {
  return path.join(cwd, XCODE_DIR, SESSIONS_SUBDIR)
}

/** Build the on-disk filename for a session. New sessions use only their
 * timestamp-shaped id. Hydrated sessions pin `sessionFilePath` so legacy
 * slug-prefixed files continue appending in place after an upgrade. */
export function getSessionFilePath(
  state: { sessionId: string; sessionFilePath?: string | null },
  cwd: string = process.cwd(),
): string {
  return state.sessionFilePath ?? path.join(sessionsDir(cwd), `${state.sessionId}.jsonl`)
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
  /** Optional for backward compatibility with sessions written before usage
   *  attribution was introduced. This is a cumulative snapshot. */
  breakdown?: UsageBreakdown
  /** Present only for main provider requests. */
  turn?: ProviderTurnUsage
  /** Cumulative diagnostic snapshot so tail scans do not need every turn. */
  cacheMissSummary?: CacheMissSummary
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
  memoryGeneration?: number
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

interface GoalEntry {
  t: 'meta'
  kind: 'goal'
  goal: GoalState | null
  ts: string
}

interface GoalInputEntry {
  t: 'meta'
  kind: 'goal-input'
  goalId: string
  input: GoalInput
  ts: string
}

interface GoalVerificationEntry {
  t: 'meta'
  kind: 'goal-verification'
  goalId: string
  result: GoalVerificationResult
  ts: string
}

interface StepStatsEntry {
  t: 'meta'
  kind: 'step-stats'
  step: StepStats
  ts: string
}

interface MemoryRecallEntry {
  t: 'meta'
  kind: 'memory-recall'
  attachment: MemoryRecallAttachment
  memoryGeneration?: number
  ts: string
}

interface MemoryRecallDeleteEntry {
  t: 'meta'
  kind: 'memory-recall-delete'
  tombstone: MemoryRecallTombstone
  ts: string
}

type Entry =
  | HeaderEntry
  | MsgEntry
  | UsageEntry
  | CompactBoundaryEntry
  | InterruptedEntry
  | CheckpointJsonlEntry
  | GoalEntry
  | GoalInputEntry
  | GoalVerificationEntry
  | StepStatsEntry
  | MemoryRecallEntry
  | MemoryRecallDeleteEntry

// ── Append helpers (fire-and-forget; never throw) ───────────────────────

async function appendLine(filePath: string, entry: Entry): Promise<void> {
  await appendRawLines(filePath, [JSON.stringify(entry)])
}

/** Per-file write queues with batching (Claude Code's sessionStorage model).
 *  All appends are fire-and-forget (flushPendingMessages / appendUsage /
 *  appendCheckpoint), so several writes to the SAME file are routinely in
 *  flight at once. Concurrent appends are not atomic — on Windows they
 *  interleave and overwrite, producing glued / split jsonl lines that the
 *  loader then has to skip (observed: a 500 KB msg line torn apart by a
 *  checkpoint line landing mid-write). The queue serializes them; whatever
 *  piles up while one appendFile is in flight is merged into a SINGLE
 *  follow-up append, so a turn-end burst (messages + usage + checkpoint)
 *  costs two syscalls instead of N. */
interface PendingWrite {
  lines: string[]
  resolve: (ok: boolean) => void
}

interface FileWriteQueue {
  pending: PendingWrite[]
  writing: boolean
}

const writeQueues = new Map<string, FileWriteQueue>()
/** Files already chmod'd this process — avoids a redundant syscall on every
 *  append. */
const chmodDone = new Set<string>()

async function drainWriteQueue(filePath: string, queue: FileWriteQueue): Promise<void> {
  queue.writing = true
  try {
    // Yield once so enqueue calls issued in the same tick (the common
    // turn-end burst) coalesce into the first batch too.
    await Promise.resolve()
    while (queue.pending.length > 0) {
      const batch = queue.pending.splice(0)
      const lines = batch.flatMap((w) => w.lines)
      let ok = true
      try {
        await ensureProjectStorageDir(path.dirname(filePath))
        await fs.appendFile(filePath, lines.join('\n') + '\n', 'utf-8')
        // Transcripts can contain secrets pasted into prompts — restrict to
        // owner-only. No-op on Windows, where chmod only toggles read-only.
        if (!chmodDone.has(filePath)) {
          chmodDone.add(filePath)
          await fs.chmod(filePath, 0o600).catch(() => {})
        }
      } catch {
        // Persistence is best-effort — never block the agent loop on FS errors.
        ok = false
      }
      for (const w of batch) w.resolve(ok)
    }
  } finally {
    queue.writing = false
  }
}

/** Batch-append pre-serialised jsonl rows. Returns true on success so
 *  callers can keep "only advance state when disk write succeeded" — e.g.
 *  markBoundaryAndReflush mustn't clear the in-memory checkpoint list
 *  unless the boundary actually landed on disk. */
function appendRawLines(filePath: string, lines: string[]): Promise<boolean> {
  if (lines.length === 0) return Promise.resolve(true)
  let queue = writeQueues.get(filePath)
  if (!queue) {
    queue = { pending: [], writing: false }
    writeQueues.set(filePath, queue)
  }
  return new Promise<boolean>((resolve) => {
    queue.pending.push({ lines, resolve })
    if (!queue.writing) void drainWriteQueue(filePath, queue)
  })
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
  state.sessionFilePath = filePath
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
  // Bump the counter BEFORE the await. agentLoop's final flush is
  // fire-and-forget and print mode's saveSession flush starts immediately
  // after — with the counter bumped post-await, both pass the guard above
  // and the tail messages land in the jsonl twice (observed in e2e
  // transcripts). Capture the end index too: messages pushed while the
  // write is in flight belong to the NEXT flush, not this one.
  const startCount = state.persistedMessageCount
  const flushEnd = state.messages.length
  state.persistedMessageCount = flushEnd
  const writePromise = appendRawLines(filePath, lines)
  // Stash on LoopState so saveSession can await this in-flight write
  // before process.exit() kills it.  print mode calls saveSession
  // (awaited) right after agentLoop returns; without this hook the pre-
  // bump above makes saveSession a no-op and process.exit() races the
  // fire-and-forget appendFile.
  state.pendingFlush = writePromise
  if (!(await writePromise)) {
    // Write failed — roll back so a later flush retries these messages,
    // but ONLY if no newer flush ran while we were awaiting: rewinding
    // past a count another flush already advanced would re-append its
    // lines (the very duplicate-tail bug this pre-bump fixes).
    if (state.persistedMessageCount === flushEnd) {
      state.persistedMessageCount = startCount
    }
  }
  state.pendingFlush = null
}

/** Append a usage snapshot for the current turn. Called from the agent loop
 *  after `collectTurnResponse` accepts the provider's `usage` object. The
 *  picker reads only the LAST usage line (tail scan) to display per-session
 *  totals — no need to keep older snapshots around any more efficiently. */
export async function appendUsage(state: LoopState, modelId: string, turn?: ProviderTurnUsage): Promise<void> {
  const filePath = getSessionFilePath(state)
  const cacheMissSummary = scanCacheMisses(state.providerTurns)
  // Full loads reconstruct individual estimates from persisted turns. Keeping
  // only cumulative totals here avoids duplicating the entire turn history in
  // every usage snapshot while preserving cheap tail reads for the picker.
  const entry: UsageEntry = {
    t: 'meta',
    kind: 'usage',
    usage: { ...state.tokenUsage },
    breakdown: cloneUsageBreakdown(state.usageBreakdown),
    turn,
    cacheMissSummary: { ...cacheMissSummary, estimates: [] },
    modelId,
    ts: new Date().toISOString(),
  }
  await appendLine(filePath, entry)
}

/** Append a per-step usage snapshot. Called from agentLoop after each
 *  user-submit completes. Accumulates across the session — loadSession
 *  collects every entry to rebuild the full step history on resume. */
export async function appendStepStats(state: LoopState, step: StepStats): Promise<void> {
  if (!state.sessionId) return
  const filePath = getSessionFilePath(state)
  const entry: StepStatsEntry = {
    t: 'meta',
    kind: 'step-stats',
    step,
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
  const boundary: CompactBoundaryEntry = {
    t: 'meta',
    kind: 'compact-boundary',
    memoryGeneration: state.memoryGeneration,
    ts,
  }
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
  resetMemoryRecallWindow(state)
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

export async function appendGoalState(state: LoopState): Promise<void> {
  if (!state.sessionId) return
  const filePath = getSessionFilePath(state)
  const entry: GoalEntry = {
    t: 'meta',
    kind: 'goal',
    goal: state.goal ? structuredClone(state.goal) : null,
    ts: new Date().toISOString(),
  }
  await appendLine(filePath, entry)
}

export async function appendGoalInput(state: LoopState, input: GoalInput): Promise<void> {
  if (!state.sessionId) return
  const filePath = getSessionFilePath(state)
  const entry: GoalInputEntry = {
    t: 'meta',
    kind: 'goal-input',
    goalId: input.goalId,
    input: structuredClone(input),
    ts: new Date().toISOString(),
  }
  await appendLine(filePath, entry)
}

export async function appendGoalVerification(
  state: LoopState,
  goalId: string,
  result: GoalVerificationResult,
): Promise<void> {
  if (!state.sessionId) return
  const filePath = getSessionFilePath(state)
  const entry: GoalVerificationEntry = {
    t: 'meta',
    kind: 'goal-verification',
    goalId,
    result: structuredClone(result),
    ts: new Date().toISOString(),
  }
  await appendLine(filePath, entry)
}

export async function appendMemoryRecall(state: LoopState, attachment: MemoryRecallAttachment): Promise<void> {
  if (!state.sessionId) return
  const entry: MemoryRecallEntry = {
    t: 'meta',
    kind: 'memory-recall',
    attachment: structuredClone(attachment),
    memoryGeneration: state.memoryGeneration,
    ts: new Date().toISOString(),
  }
  await appendLine(getSessionFilePath(state), entry)
}

export async function appendMemoryRecallDelete(state: LoopState, tombstone: MemoryRecallTombstone): Promise<void> {
  if (!state.sessionId) return
  const entry: MemoryRecallDeleteEntry = {
    t: 'meta',
    kind: 'memory-recall-delete',
    tombstone: structuredClone(tombstone),
    ts: new Date().toISOString(),
  }
  await appendLine(getSessionFilePath(state), entry)
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
  usageBreakdown?: UsageBreakdown
  providerTurns?: ProviderTurnUsage[]
  cacheMissSummary?: CacheMissSummary
  goal: GoalState | null
  goalInputs: GoalInput[]
  /** Rewind checkpoints surviving the last compact-boundary (if any).
   *  The backing file manifests live under `.x-code/file-history/<sid>/`. */
  checkpoints: CheckpointEntry[]
  /** Per-step token usage snapshots accumulated across the session. */
  stepStats: StepStats[]
  memoryRecallAttachments: MemoryRecallAttachment[]
  memoryRecallTombstones: MemoryRecallTombstone[]
  memoryGeneration: number
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
  const providerTurns: ProviderTurnUsage[] = []
  let messages: ModelMessage[] = []
  let checkpoints: CheckpointEntry[] = []
  let goal: GoalState | null = null
  const goalInputs: GoalInput[] = []
  const stepStats: StepStats[] = []
  let memoryRecallAttachments: MemoryRecallAttachment[] = []
  let memoryRecallTombstones: MemoryRecallTombstone[] = []
  let memoryGeneration = 0

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
        if (entry.turn) providerTurns.push(entry.turn)
      } else if (entry.kind === 'compact-boundary') {
        messages = []
        // Checkpoints anchored to pre-compaction message counts are now
        // meaningless — the array shrank under them. Drop along with msgs.
        checkpoints = []
        memoryRecallAttachments = []
        memoryRecallTombstones = []
        memoryGeneration = entry.memoryGeneration ?? 0
      } else if (entry.kind === 'checkpoint') {
        checkpoints.push({
          ckptId: entry.ckptId,
          messageCount: entry.messageCount,
          ts: entry.ts,
          userPrompt: entry.userPrompt,
        })
      } else if (entry.kind === 'goal') {
        goal = entry.goal
      } else if (entry.kind === 'goal-input') {
        const idx = goalInputs.findIndex((input) => input.id === entry.input.id)
        if (idx >= 0) goalInputs[idx] = entry.input
        else goalInputs.push(entry.input)
      } else if (entry.kind === 'goal-verification' && goal && goal.id === entry.goalId) {
        if (!goal.verificationResults.some((result) => result.ts === entry.result.ts)) {
          goal.verificationResults.push(entry.result)
        }
      } else if (entry.kind === 'step-stats') {
        stepStats.push(entry.step)
      } else if (entry.kind === 'memory-recall') {
        memoryRecallAttachments.push(entry.attachment)
        memoryGeneration = Math.max(memoryGeneration, entry.memoryGeneration ?? 0)
      } else if (entry.kind === 'memory-recall-delete') {
        memoryRecallTombstones.push(entry.tombstone)
        memoryGeneration = Math.max(memoryGeneration, entry.tombstone.generation)
      }
      // 'interrupted' is informational only — doesn't affect state
    } else if (entry.t === 'msg') {
      messages.push(entry.message)
    }
  }
  if (!header) return null

  // Repair binary parts that older builds persisted as JSON-serialized
  // Buffers — without this the resumed transcript fails the SDK's
  // ModelMessage schema on the very first request.
  normalizeSerializedBinaryParts(messages)

  return {
    sessionId: header.sessionId,
    taskSlug: header.taskSlug,
    startedAt: header.startedAt,
    modelId: lastUsage?.modelId ?? header.modelId,
    cwd: header.cwd,
    gitBranch: header.gitBranch,
    firstPrompt: header.firstPrompt,
    messages: sanitizeMessageTail(messages),
    tokenUsage: lastUsage?.usage ?? EMPTY_USAGE,
    usageBreakdown: lastUsage?.breakdown ?? createUsageBreakdown(),
    providerTurns,
    cacheMissSummary: lastUsage?.cacheMissSummary ?? scanCacheMisses(providerTurns),
    goal,
    goalInputs,
    checkpoints,
    stepStats,
    memoryRecallAttachments,
    memoryRecallTombstones,
    memoryGeneration,
    filePath,
  }
}

type ToolCallPart = { type?: string; toolCallId?: string }

/** Restore a binary payload that was persisted as a JSON-serialized Buffer /
 *  Uint8Array back to a base64 string. Older builds put raw Buffer instances
 *  into image/file parts; JSON.stringify turns those into
 *  `{"type":"Buffer","data":[...]}` (Buffer) or `{"0":137,"1":80,...}`
 *  (Uint8Array) — both fail the SDK's ModelMessage schema on resume, killing
 *  every request in the resumed session. Returns undefined when the shape
 *  isn't a recognizable serialized binary. */
function serializedBinaryToBase64(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const obj = value as Record<string, unknown>
  if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
    return Buffer.from(obj.data as number[]).toString('base64')
  }
  const keys = Object.keys(obj)
  if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
    return Buffer.from(keys.sort((a, b) => Number(a) - Number(b)).map((k) => obj[k] as number)).toString('base64')
  }
  return undefined
}

/** Walk loaded messages in place and repair binary parts corrupted by JSON
 *  serialization (see serializedBinaryToBase64). Covers user/assistant image
 *  and file parts plus tool-result `content` entries. */
function normalizeSerializedBinaryParts(messages: ModelMessage[]): void {
  const fixPart = (part: unknown): void => {
    if (!part || typeof part !== 'object') return
    const p = part as Record<string, unknown>
    if (p.type === 'image' && typeof p.image !== 'string') {
      const restored = serializedBinaryToBase64(p.image)
      if (restored !== undefined) p.image = restored
    } else if (p.type === 'file' && typeof p.data !== 'string') {
      const restored = serializedBinaryToBase64(p.data)
      if (restored !== undefined) p.data = restored
    }
  }
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    if (msg.role === 'user' || msg.role === 'assistant') {
      for (const part of msg.content) fixPart(part)
    } else if (msg.role === 'tool') {
      for (const part of msg.content as Array<{ type?: string; output?: { type?: string; value?: unknown } }>) {
        if (part?.type !== 'tool-result') continue
        const output = part.output
        if (output?.type !== 'content' || !Array.isArray(output.value)) continue
        for (const entry of output.value as Array<{ type?: string; data?: unknown }>) {
          if (
            (entry?.type === 'media' || entry?.type === 'image-data' || entry?.type === 'file-data') &&
            typeof entry.data !== 'string'
          ) {
            const restored = serializedBinaryToBase64(entry.data)
            if (restored !== undefined) entry.data = restored
          }
        }
      }
    }
  }
}

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
  usageBreakdown?: UsageBreakdown | null
  cacheMissSummary?: CacheMissSummary | null
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
        let usageBreakdown: UsageBreakdown | null = null
        let cacheMissSummary: CacheMissSummary | null = null
        let latestModelId = header.modelId
        const tailLines = tail.split('\n').reverse()
        for (const l of tailLines) {
          if (!l.trim()) continue
          if (l.includes('"kind":"usage"')) {
            try {
              const e = JSON.parse(l) as UsageEntry
              tokenUsage = e.usage
              usageBreakdown = e.breakdown ?? null
              cacheMissSummary = e.cacheMissSummary ?? null
              latestModelId = e.modelId || header.modelId
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
          modelId: latestModelId,
          mtime: stat.mtimeMs,
          tokenUsage,
          usageBreakdown,
          cacheMissSummary,
        } satisfies SessionListEntry
      } catch {
        return null
      }
    }),
  )
  return results
    .filter((r): r is Exclude<(typeof results)[number], null> => r !== null)
    .sort((a, b) => b.mtime - a.mtime)
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

/** Build a LoopState seeded from a previously-saved session. The agent
 *  loop accepts `existingState` and will continue appending to the exact
 *  loaded jsonl path, including legacy slug-prefixed filenames.
 *  `persistedMessageCount` is set to the loaded length
 *  so the very first flush after the next user submit only appends NEW
 *  messages — the loaded tail is already on disk. */
export function hydrateLoopState(loaded: LoadedSession, initialMode: PermissionMode = 'default'): LoopState {
  const state = createLoopState(initialMode)
  state.sessionId = loaded.sessionId
  state.sessionFilePath = loaded.filePath
  state.taskSlug = loaded.taskSlug
  state.startedAt = loaded.startedAt
  state.messages = loaded.messages.slice()
  state.tokenUsage = { ...loaded.tokenUsage }
  state.usageBreakdown = loaded.usageBreakdown ? cloneUsageBreakdown(loaded.usageBreakdown) : createUsageBreakdown()
  state.providerTurns = loaded.providerTurns?.slice() ?? []
  state.lastInputTokens = loaded.tokenUsage.inputTokens
  state.persistedMessageCount = loaded.messages.length
  state.checkpoints = loaded.checkpoints.slice()
  state.goal = loaded.goal ? structuredClone(loaded.goal) : null
  state.goalInputs = loaded.goalInputs.map((input) => ({ ...input }))
  state.stepStats = loaded.stepStats.slice()
  state.memoryRecallAttachments = loaded.memoryRecallAttachments.map((attachment) => structuredClone(attachment))
  state.memoryRecallTombstones = loaded.memoryRecallTombstones.map((tombstone) => structuredClone(tombstone))
  state.memoryGeneration = loaded.memoryGeneration
  state.surfacedMemoryHashes = new Set(
    state.memoryRecallAttachments.flatMap((attachment) =>
      attachment.topics.map((topic) => `${topic.topicId}@${topic.topicHash}`),
    ),
  )
  state.memoryTokensInWindow = state.memoryRecallAttachments.reduce(
    (sum, attachment) => sum + attachment.estimatedTokens,
    0,
  )
  return state
}
