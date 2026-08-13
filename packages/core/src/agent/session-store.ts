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
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { ModelMessage } from 'ai'

import { resetMemoryRecallWindow } from '../knowledge/memory/recall-state.js'
import type { MemoryRecallAttachment, MemoryRecallTombstone } from '../knowledge/memory/types.js'
import { ensureProjectStorageDir } from '../project-storage.js'
import { BROWSER_VISUAL_CHECK_TOOL_NAME } from '../tools/browser-visual-check.js'
import type {
  ContextSecurityState,
  MessageProvenance,
  PermissionMode,
  TokenUsage,
  TrackedModelMessage,
} from '../types/index.js'
import { XCODE_DIR } from '../utils.js'
import { scanCacheMisses } from './cache-stats.js'
import type { CacheMissSummary, ProviderTurnUsage } from './cache-stats.js'
import type { GoalInput, GoalState, GoalVerificationResult } from './goal/types.js'
import { createLoopState } from './loop-state.js'
import type { LoopState, StepStats } from './loop-state.js'
import {
  canonicalSecurityJson,
  canonicalTranscriptDigest,
  createTrackedMessage,
  deriveContextSecurity,
  effectiveExecutionAuthority,
  isValidContextSecurity,
  isValidProvenance,
} from './provenance.js'
import type { CheckpointEntry } from './snapshot.js'
import { setTrackedTranscript } from './tracked-messages.js'
import { cloneUsageBreakdown, createUsageBreakdown } from './usage.js'
import type { UsageBreakdown } from './usage.js'

const SESSIONS_SUBDIR = 'sessions'
const OMITTED_VISUAL_CHECK_IMAGE = '[browserVisualCheck screenshot omitted from session storage]'
const BINARY_TOOL_OUTPUT_TYPES = new Set(['file', 'file-data', 'image', 'image-data', 'media'])

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
  firstPromptProvenance?: MessageProvenance
}

interface MsgEntry {
  t: 'msg'
  epochId?: string
  entryId?: string
  message: ModelMessage
  provenance?: MessageProvenance
  ts: string
}

interface TranscriptEpochStartEntry {
  t: 'meta'
  kind: 'transcript-epoch-start'
  epochId: string
  parentEpochId?: string
  mode: 'snapshot' | 'delta'
  ts: string
}

interface ContextSecurityBoundaryEntry {
  t: 'meta'
  kind: 'context-security-boundary'
  epochId: string
  state: ContextSecurityState
  resultEntryCount: number
  resultTranscriptDigest: string
  ts: string
}

interface TranscriptEpochCommitEntry {
  t: 'meta'
  kind: 'transcript-epoch-commit'
  epochId: string
  boundaryDigest: string
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
  | TranscriptEpochStartEntry
  | ContextSecurityBoundaryEntry
  | TranscriptEpochCommitEntry

interface PersistedToolResultPart {
  type?: string
  toolName?: string
  output?: {
    type?: string
    value?: unknown
  }
}

/** Keep the live screenshot in memory for the model's next request, but never
 *  copy its base64 payload into the project's resumable JSONL transcript. */
function persistenceSafeMessage(message: ModelMessage): ModelMessage {
  if (message.role !== 'tool' || !Array.isArray(message.content)) return message
  let changed = false
  const content = (message.content as PersistedToolResultPart[]).map((part) => {
    if (
      part?.type !== 'tool-result' ||
      part.toolName !== BROWSER_VISUAL_CHECK_TOOL_NAME ||
      part.output?.type !== 'content' ||
      !Array.isArray(part.output.value)
    ) {
      return part
    }
    const retained = (part.output.value as Array<{ type?: string }>).filter(
      (entry) => !entry?.type || !BINARY_TOOL_OUTPUT_TYPES.has(entry.type),
    )
    if (retained.length === part.output.value.length) return part
    changed = true
    return {
      ...part,
      output: {
        ...part.output,
        value: [...retained, { type: 'text', text: OMITTED_VISUAL_CHECK_IMAGE }],
      },
    }
  })
  return changed ? ({ ...message, content } as ModelMessage) : message
}

// ── Append helpers (fire-and-forget; never throw) ───────────────────────

async function appendLine(filePath: string, entry: Entry): Promise<void> {
  await appendRawLines(filePath, [JSON.stringify(entry)])
}

/** Every append and atomic snapshot for one session shares this operation
 * chain. A snapshot rename can therefore never race and discard a usage,
 * checkpoint, goal, or memory append that was already acknowledged. */
const fileOperations = new Map<string, Promise<void>>()
/** Files already chmod'd this process — avoids a redundant syscall on every
 *  append. */
const chmodDone = new Set<string>()

function enqueueFileOperation<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileOperations.get(filePath) ?? Promise.resolve()
  let resolveTail!: () => void
  const tail = new Promise<void>((resolve) => {
    resolveTail = resolve
  })
  fileOperations.set(filePath, tail)
  return previous
    .catch(() => {})
    .then(operation)
    .finally(() => {
      resolveTail()
      if (fileOperations.get(filePath) === tail) fileOperations.delete(filePath)
    })
}

async function appendRawLinesNow(filePath: string, lines: string[]): Promise<boolean> {
  try {
    await ensureProjectStorageDir(path.dirname(filePath))
    const handle = await fs.open(filePath, 'a', 0o600)
    try {
      await handle.writeFile(lines.join('\n') + '\n', 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (!chmodDone.has(filePath)) {
      chmodDone.add(filePath)
      await fs.chmod(filePath, 0o600).catch(() => {})
    }
    return true
  } catch {
    return false
  }
}

function appendRawLines(filePath: string, lines: string[]): Promise<boolean> {
  if (lines.length === 0) return Promise.resolve(true)
  return enqueueFileOperation(filePath, () => appendRawLinesNow(filePath, lines))
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

function persistenceSafeTrackedMessage(entry: TrackedModelMessage): TrackedModelMessage {
  return {
    entryId: entry.entryId,
    message: persistenceSafeMessage(entry.message),
    provenance: structuredClone(entry.provenance),
  }
}

function epochLines(
  entries: readonly TrackedModelMessage[],
  mode: 'snapshot' | 'delta',
  resultingTranscript: readonly TrackedModelMessage[],
  parentEpochId?: string,
): { epochId: string; lines: string[] } {
  const epochId = randomUUID()
  const ts = new Date().toISOString()
  const start: TranscriptEpochStartEntry = {
    t: 'meta',
    kind: 'transcript-epoch-start',
    epochId,
    ...(parentEpochId ? { parentEpochId } : {}),
    mode,
    ts,
  }
  const projectedEntries = entries.map(persistenceSafeTrackedMessage)
  const projectedResult = resultingTranscript.map(persistenceSafeTrackedMessage)
  const boundary: ContextSecurityBoundaryEntry = {
    t: 'meta',
    kind: 'context-security-boundary',
    epochId,
    state: deriveContextSecurity(projectedResult),
    resultEntryCount: projectedResult.length,
    resultTranscriptDigest: canonicalTranscriptDigest(projectedResult),
    ts,
  }
  const commit: TranscriptEpochCommitEntry = {
    t: 'meta',
    kind: 'transcript-epoch-commit',
    epochId,
    boundaryDigest: createHash('sha256').update(canonicalSecurityJson(boundary)).digest('hex'),
    ts,
  }
  return {
    epochId,
    lines: [
      JSON.stringify(start),
      ...projectedEntries.map((entry) =>
        JSON.stringify({
          t: 'msg',
          epochId,
          entryId: entry.entryId,
          message: entry.message,
          provenance: entry.provenance,
          ts,
        } satisfies MsgEntry),
      ),
      JSON.stringify(boundary),
      JSON.stringify(commit),
    ],
  }
}

function isTranscriptLine(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as { t?: string; kind?: string }
  return (
    entry.t === 'msg' ||
    (entry.t === 'meta' &&
      ['compact-boundary', 'transcript-epoch-start', 'context-security-boundary', 'transcript-epoch-commit'].includes(
        entry.kind ?? '',
      ))
  )
}

async function retainedMetadataLines(
  filePath: string,
  options: {
    dropCheckpoints?: boolean
    checkpointMessageCountAtMost?: number
    dropMemoryRecall?: boolean
  } = {},
): Promise<string[]> {
  let raw = ''
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const lines: string[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const metadata = entry as { t?: string; kind?: string; messageCount?: number }
    if (metadata.t === 'meta' && metadata.kind === 'checkpoint') {
      if (options.dropCheckpoints) continue
      if (
        options.checkpointMessageCountAtMost !== undefined &&
        (typeof metadata.messageCount !== 'number' || metadata.messageCount > options.checkpointMessageCountAtMost)
      ) {
        continue
      }
    }
    if (
      options.dropMemoryRecall &&
      metadata.t === 'meta' &&
      (metadata.kind === 'memory-recall' || metadata.kind === 'memory-recall-delete')
    ) {
      continue
    }
    if (!isTranscriptLine(entry)) lines.push(JSON.stringify(entry))
  }
  return lines
}

async function replaceWithSnapshot(filePath: string, lines: readonly string[]): Promise<void> {
  await ensureProjectStorageDir(path.dirname(filePath))
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(tempPath, 'wx', 0o600)
    await handle.chmod(0o600)
    await handle.writeFile(lines.join('\n') + '\n', 'utf-8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(tempPath, filePath)
    const directory = await fs.open(path.dirname(filePath), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
    chmodDone.add(filePath)
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.unlink(tempPath).catch(() => {})
    throw error
  }
}

interface TranscriptSnapshotOptions {
  allowIntegrityRepair?: boolean
  dropCheckpoints?: boolean
  checkpointMessageCountAtMost?: number
  dropMemoryRecall?: boolean
}

function cloneTrackedTranscript(entries: readonly TrackedModelMessage[]): TrackedModelMessage[] {
  return entries.map((entry) => ({
    entryId: entry.entryId,
    message: structuredClone(entry.message),
    provenance: structuredClone(entry.provenance),
  }))
}

function enqueueTranscriptOperation(state: LoopState, operation: () => Promise<void>): Promise<void> {
  const previous = state.pendingFlush ?? Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  state.pendingFlush = current
  void current.then(
    () => {
      if (state.pendingFlush === current) state.pendingFlush = null
    },
    () => {
      if (state.pendingFlush === current) state.pendingFlush = null
    },
  )
  return current
}

async function commitTranscriptSnapshotNow(
  state: LoopState,
  candidate: readonly TrackedModelMessage[],
  options: TranscriptSnapshotOptions,
  replaceInMemory: boolean,
): Promise<void> {
  try {
    if (state.transcriptIntegrity === 'failed' && !options.allowIntegrityRepair) {
      throw new Error('Transcript integrity failed; refusing a decontaminating snapshot')
    }
    const filePath = getSessionFilePath(state)
    const projected = candidate.map(persistenceSafeTrackedMessage)
    const epoch = epochLines(projected, 'snapshot', projected)
    await enqueueFileOperation(filePath, async () => {
      const metadata = await retainedMetadataLines(filePath, options)
      await replaceWithSnapshot(filePath, [...metadata, ...epoch.lines])
    })
    if (replaceInMemory) setTrackedTranscript(state, candidate)
    state.committedTranscriptEpochId = epoch.epochId
    state.transcriptIntegrity = 'clean'
    state.transcriptRequiresSnapshot = false
    state.persistedMessageCount = candidate.length
  } catch (error) {
    // rename may already have replaced the durable file before a directory
    // fsync reports failure. The in-memory parent is then no longer safe for
    // a delta; every snapshot failure forces the next operation to rewrite a
    // fresh root snapshot from the current tracked transcript.
    state.transcriptRequiresSnapshot = true
    throw error
  }
}

/** Commit a complete root snapshot. The live transcript changes only after
 * temp-file fsync, atomic rename, and directory fsync all succeed. State
 * derivation and I/O share the LoopState transcript chain, not just the
 * per-file writer queue. */
export function commitTranscriptSnapshot(
  state: LoopState,
  candidate?: readonly TrackedModelMessage[],
  options: TranscriptSnapshotOptions = {},
): Promise<void> {
  const requestedCandidate = candidate === undefined ? undefined : cloneTrackedTranscript(candidate)
  return enqueueTranscriptOperation(state, async () => {
    const selected = requestedCandidate ?? cloneTrackedTranscript(state.trackedMessages)
    await commitTranscriptSnapshotNow(state, selected, options, requestedCandidate !== undefined)
  })
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
    firstPromptProvenance: state.trackedMessages[0]?.provenance,
  }
  if (!(await appendRawLines(filePath, [JSON.stringify(entry)]))) {
    throw new Error('Failed to persist session header')
  }
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
export function flushPendingMessages(state: LoopState): Promise<void> {
  return enqueueTranscriptOperation(state, async () => {
    if (state.transcriptIntegrity === 'failed') {
      throw new Error('Transcript integrity failed; automatic permission remains disabled')
    }
    if (
      state.transcriptRequiresSnapshot ||
      state.transcriptIntegrity !== 'clean' ||
      !state.committedTranscriptEpochId
    ) {
      const selected = cloneTrackedTranscript(state.trackedMessages)
      await commitTranscriptSnapshotNow(state, selected, {}, false)
      return
    }
    if (state.persistedMessageCount >= state.trackedMessages.length) return
    const filePath = getSessionFilePath(state)
    const flushEnd = state.trackedMessages.length
    const resultingTranscript = state.trackedMessages.slice(0, flushEnd)
    const pending = resultingTranscript.slice(state.persistedMessageCount)
    if (pending.length === 0) return
    const epoch = epochLines(pending, 'delta', resultingTranscript, state.committedTranscriptEpochId)
    if (!(await appendRawLines(filePath, epoch.lines))) {
      // append mode can leave any byte prefix on disk before reporting an I/O
      // failure. Retrying another delta would chain across that unauthenticated
      // tail, so the next operation must atomically replace it with a snapshot.
      state.transcriptRequiresSnapshot = true
      throw new Error('Failed to commit transcript delta')
    }
    state.persistedMessageCount = flushEnd
    state.committedTranscriptEpochId = epoch.epochId
  })
}

/** Append a usage snapshot for the current turn. Called from the agent loop
 *  after `collectTurnResponse` accepts the provider's `usage` object. The
 *  picker reads only the LAST usage line (tail scan) to display per-session
 *  totals — no need to keep older snapshots around any more efficiently. */
export async function appendUsage(state: LoopState, modelId: string, turn?: ProviderTurnUsage): Promise<void> {
  const filePath = getSessionFilePath(state)
  // Full loads reconstruct individual estimates from persisted turns. Keeping
  // only cumulative totals here avoids duplicating the entire turn history in
  // every usage snapshot while preserving cheap tail reads for the picker.
  const entry: UsageEntry = {
    t: 'meta',
    kind: 'usage',
    usage: { ...state.tokenUsage },
    breakdown: cloneUsageBreakdown(state.usageBreakdown),
    turn,
    cacheMissSummary: { ...state.cacheMissSummary, estimates: [] },
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
export async function markBoundaryAndReflush(
  state: LoopState,
  summary?: string,
  candidate: readonly TrackedModelMessage[] = state.trackedMessages,
): Promise<void> {
  void summary
  await commitTranscriptSnapshot(state, candidate, { dropCheckpoints: true, dropMemoryRecall: true })
  // Compaction shrinks/rewrites the messages array — every prior
  // checkpoint's `messageCount` now points past the end. Clear the
  // in-memory list to mirror the loader's behaviour (which drops
  // pre-boundary checkpoint lines on resume).
  state.checkpoints = []
  resetMemoryRecallWindow(state)
}

export async function clearPeerContext(state: LoopState): Promise<number> {
  if (state.transcriptIntegrity !== 'clean' || state.contextSecurity.integrityFailure) {
    throw new Error('Transcript integrity must be repaired before peer context can be cleared')
  }
  if (!isValidContextSecurity(state.contextSecurity, state.trackedMessages)) {
    throw new Error('Stored context-security boundary does not match the tracked transcript')
  }
  const derived = deriveContextSecurity(state.trackedMessages)
  const firstTaintedEntryId = derived.firstTaintedEntryId
  if (!derived.peerInfluenceActive || !firstTaintedEntryId) return 0
  const firstTaintedIndex = state.trackedMessages.findIndex((entry) => entry.entryId === firstTaintedEntryId)
  if (
    firstTaintedIndex < 0 ||
    state.trackedMessages.slice(0, firstTaintedIndex).some((entry) => entry.provenance.derivedFromPeer)
  ) {
    throw new Error('The first tainted transcript entry cannot be located safely')
  }
  const removed = state.trackedMessages.length - firstTaintedIndex
  const safePrefix = state.trackedMessages.slice(0, firstTaintedIndex)
  await commitTranscriptSnapshot(state, safePrefix, {
    checkpointMessageCountAtMost: safePrefix.length,
    dropMemoryRecall: true,
  })
  state.checkpoints = state.checkpoints.filter((checkpoint) => checkpoint.messageCount <= safePrefix.length)
  resetMemoryRecallWindow(state)
  return removed
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
  trackedMessages: TrackedModelMessage[]
  contextSecurity: ContextSecurityState
  committedTranscriptEpochId?: string
  transcriptIntegrity: 'clean' | 'legacy' | 'failed'
  /** The loaded in-memory transcript differs from the last durable commit or
   *  discarded an incomplete tail. The first append must atomically replace
   *  the transcript instead of extending the stale/broken epoch chain. */
  transcriptRequiresSnapshot: boolean
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
  const rawLines = raw.split('\n').filter((line) => line.trim())
  const parsedLines = rawLines.map((line) => {
    try {
      return { ok: true as const, entry: JSON.parse(line) as Entry }
    } catch {
      return { ok: false as const }
    }
  })
  const hasEpoch = parsedLines.some(
    (line) =>
      line.ok &&
      line.entry.t === 'meta' &&
      ['transcript-epoch-start', 'context-security-boundary', 'transcript-epoch-commit'].includes(line.entry.kind),
  )
  const hasLegacyMessages = parsedLines.some(
    (line) => line.ok && line.entry.t === 'msg' && !(line.entry as MsgEntry).epochId,
  )

  let header: HeaderEntry | null = null
  let lastUsage: UsageEntry | null = null
  const providerTurns: ProviderTurnUsage[] = []
  let legacyMessages: ModelMessage[] = []
  let checkpoints: CheckpointEntry[] = []
  let goal: GoalState | null = null
  const goalInputs: GoalInput[] = []
  const stepStats: StepStats[] = []
  let memoryRecallAttachments: MemoryRecallAttachment[] = []
  let memoryRecallTombstones: MemoryRecallTombstone[] = []
  let memoryGeneration = 0

  for (const parsed of parsedLines) {
    if (!parsed.ok) continue
    const entry = parsed.entry
    if (entry.t === 'meta') {
      if (entry.kind === 'header') {
        header = entry
      } else if (entry.kind === 'usage') {
        lastUsage = entry
        if (entry.turn) providerTurns.push(entry.turn)
      } else if (entry.kind === 'compact-boundary' && !hasEpoch) {
        legacyMessages = []
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
    } else if (entry.t === 'msg' && !hasEpoch) {
      // Also protect resumed sessions created by older releases. This does not
      // rewrite their append-only files, but keeps legacy screenshots out of a
      // new provider request after resume.
      legacyMessages.push(persistenceSafeMessage(entry.message))
    }
  }
  if (!header) return null

  let trackedMessages: TrackedModelMessage[] = []
  let committedTranscriptEpochId: string | undefined
  let transcriptIntegrity: 'clean' | 'legacy' | 'failed' = hasEpoch ? 'clean' : 'legacy'
  let transcriptPrefixNeedsReplacement = false

  if (!hasEpoch) {
    trackedMessages = legacyMessages.map((message, index) =>
      createTrackedMessage(
        message,
        { authority: 'user', derivedFromPeer: false },
        createHash('sha256')
          .update(`${header!.sessionId}\u0000${index}\u0000${canonicalSecurityJson(message)}`)
          .digest('hex'),
      ),
    )
  } else if (hasLegacyMessages) {
    transcriptIntegrity = 'failed'
  } else {
    interface PendingEpoch {
      start: TranscriptEpochStartEntry
      entries: TrackedModelMessage[]
      boundary?: ContextSecurityBoundaryEntry
    }
    let active: PendingEpoch | undefined
    let validTranscript: TrackedModelMessage[] = []
    let sawCommittedSnapshot = false
    const seenEntryIds = new Set<string>()

    for (let index = 0; index < parsedLines.length; index++) {
      const parsed = parsedLines[index]!
      if (!parsed.ok) {
        const laterTranscriptLine = parsedLines
          .slice(index + 1)
          .some((later) => later.ok && isTranscriptLine(later.entry))
        // A malformed row terminates the continuous transcript prefix. A
        // trailing partial write is recoverable from the last commit, but a
        // later epoch must never be accepted across the gap: its parentage
        // and the bytes hidden by the malformed row cannot be authenticated.
        transcriptPrefixNeedsReplacement = true
        if (laterTranscriptLine) transcriptIntegrity = 'failed'
        break
      }
      const entry = parsed.entry
      if (!isTranscriptLine(entry)) continue
      if (entry.t === 'msg') {
        if (
          !active ||
          entry.epochId !== active.start.epochId ||
          active.boundary ||
          typeof entry.entryId !== 'string' ||
          !isValidProvenance(entry.provenance) ||
          seenEntryIds.has(entry.entryId)
        ) {
          transcriptIntegrity = 'failed'
          break
        }
        active.entries.push(
          createTrackedMessage(persistenceSafeMessage(entry.message), entry.provenance, entry.entryId),
        )
        continue
      }
      if (entry.kind === 'compact-boundary') {
        transcriptIntegrity = 'failed'
        break
      }
      if (entry.kind === 'transcript-epoch-start') {
        if (
          active ||
          (entry.mode === 'snapshot' && (entry.parentEpochId !== undefined || sawCommittedSnapshot)) ||
          (entry.mode === 'delta' && (!sawCommittedSnapshot || entry.parentEpochId !== committedTranscriptEpochId))
        ) {
          transcriptIntegrity = 'failed'
          break
        }
        active = { start: entry, entries: [] }
        continue
      }
      if (entry.kind === 'context-security-boundary') {
        if (!active || active.boundary || entry.epochId !== active.start.epochId) {
          transcriptIntegrity = 'failed'
          break
        }
        active.boundary = entry
        continue
      }
      if (entry.kind === 'transcript-epoch-commit') {
        if (!active || !active.boundary || entry.epochId !== active.start.epochId) {
          transcriptIntegrity = 'failed'
          break
        }
        const candidate = active.start.mode === 'snapshot' ? active.entries : [...validTranscript, ...active.entries]
        const boundary = active.boundary
        const boundaryHash = createHash('sha256').update(canonicalSecurityJson(boundary)).digest('hex')
        if (
          entry.boundaryDigest !== boundaryHash ||
          boundary.resultEntryCount !== candidate.length ||
          boundary.resultTranscriptDigest !== canonicalTranscriptDigest(candidate) ||
          !isValidContextSecurity(boundary.state, candidate)
        ) {
          transcriptIntegrity = 'failed'
          break
        }
        validTranscript = candidate
        for (const tracked of active.entries) seenEntryIds.add(tracked.entryId)
        committedTranscriptEpochId = entry.epochId
        sawCommittedSnapshot = true
        active = undefined
      }
    }
    if (active) transcriptPrefixNeedsReplacement = true
    trackedMessages = validTranscript
    if (!sawCommittedSnapshot) transcriptIntegrity = 'failed'
  }

  const committedDigestBeforeRepair = canonicalTranscriptDigest(trackedMessages)
  // Repair binary parts that older builds persisted as JSON-serialized
  // Buffers — without this the resumed transcript fails the SDK's
  // ModelMessage schema on the very first request.
  normalizeSerializedBinaryParts(trackedMessages.map((entry) => entry.message))

  trackedMessages = sanitizeTrackedMessageTail(trackedMessages)
  const transcriptRequiresSnapshot =
    transcriptIntegrity !== 'clean' ||
    transcriptPrefixNeedsReplacement ||
    canonicalTranscriptDigest(trackedMessages) !== committedDigestBeforeRepair
  const derivedSecurity = deriveContextSecurity(trackedMessages)
  const contextSecurity: ContextSecurityState =
    transcriptIntegrity === 'failed'
      ? { ...derivedSecurity, peerInfluenceActive: true, integrityFailure: true }
      : derivedSecurity

  return {
    sessionId: header.sessionId,
    taskSlug: header.taskSlug,
    startedAt: header.startedAt,
    modelId: lastUsage?.modelId ?? header.modelId,
    cwd: header.cwd,
    gitBranch: header.gitBranch,
    firstPrompt: header.firstPrompt,
    messages: trackedMessages.map((entry) => entry.message),
    trackedMessages,
    contextSecurity,
    committedTranscriptEpochId,
    transcriptIntegrity,
    transcriptRequiresSnapshot,
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

export function sanitizeTrackedMessageTail(entries: readonly TrackedModelMessage[]): TrackedModelMessage[] {
  const sanitizedMessages = sanitizeMessageTail(entries.map((entry) => entry.message))
  if (sanitizedMessages.length === entries.length) return entries.slice()
  return entries.slice(0, sanitizedMessages.length)
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
  setTrackedTranscript(state, loaded.trackedMessages)
  state.contextSecurity = structuredClone(loaded.contextSecurity)
  state.executionAuthority = effectiveExecutionAuthority({ source: 'user', peerTainted: false }, state.contextSecurity)
  state.committedTranscriptEpochId = loaded.committedTranscriptEpochId
  state.transcriptIntegrity = loaded.transcriptIntegrity
  state.transcriptRequiresSnapshot = loaded.transcriptRequiresSnapshot
  state.tokenUsage = { ...loaded.tokenUsage }
  state.usageBreakdown = loaded.usageBreakdown ? cloneUsageBreakdown(loaded.usageBreakdown) : createUsageBreakdown()
  state.providerTurns = loaded.providerTurns?.slice() ?? []
  state.cacheMissSummary = loaded.cacheMissSummary
    ? { ...loaded.cacheMissSummary, estimates: scanCacheMisses(state.providerTurns).estimates }
    : scanCacheMisses(state.providerTurns)
  state.lastInputTokens = loaded.tokenUsage.inputTokens
  state.persistedMessageCount = loaded.trackedMessages.length
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
