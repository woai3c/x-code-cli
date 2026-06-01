// @x-code-cli/core — File-history snapshot store (content-addressed)
//
// Backs the `/rewind` command. Each user-message turn produces a checkpoint
// that captures the current state of every file in `state.filesModified`.
// Content is deduplicated by sha256 blob — repeated files across checkpoints
// occupy disk once. Per session, layout under .x-code/file-history/<sid>/:
//
//   blobs/<sha256>           — content-addressed file contents (shared)
//   checkpoints/<id>.json    — manifest mapping abs path -> blob hash | absent | skip
//
// Why content-addressed (vs per-checkpoint copies): in a typical agent run
// most files are unchanged between adjacent user messages — the model edits
// 1-3 files per turn while `filesModified` may have 30+ accumulated. With
// dedup the marginal cost of a new checkpoint is just the bytes of the
// files that actually changed, not the whole tracked set.
//
// Why no shadow-git (per the design discussion): file-copy keeps this
// working in non-git projects, sidesteps .gitignore conflicts, and avoids
// any chance of touching the user's real .git index.
import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { XCODE_DIR } from '../utils.js'
import type { LoopState } from './loop-state.js'

const FILE_HISTORY_SUBDIR = 'file-history'
const BLOBS_SUBDIR = 'blobs'
const CHECKPOINTS_SUBDIR = 'checkpoints'

/** Files larger than this are recorded with `skip: true` in the manifest
 *  and left untouched on restore. Keeps a stray build artifact (megabytes
 *  to gigabytes) from blowing up the blob store; agent-tracked source
 *  files are essentially never this large. */
const MAX_FILE_BYTES = 10 * 1024 * 1024

/** Ring-buffer cap. Older checkpoints are evicted; orphaned blobs are GC'd
 *  on the next restore or eviction. 100 matches Claude Code's bound. */
const MAX_CHECKPOINTS = 100

/** Public, in-memory representation of a checkpoint. Mirrored to jsonl as
 *  a `meta:checkpoint` line so /rewind survives /resume. */
export interface CheckpointEntry {
  ckptId: string
  /** `state.messages.length` immediately AFTER the user message was pushed.
   *  Rewind truncates messages to `messageCount - 1` (drops that user msg
   *  + everything after). Not stable across compaction — the in-memory
   *  list is cleared by markBoundaryAndReflush. */
  messageCount: number
  ts: string
  /** First ~200 chars of the user message that triggered this checkpoint —
   *  drives the picker's preview. */
  userPrompt: string
}

interface ManifestFileEntry {
  /** sha256 hex of the file content at snapshot time. Points to blobs/<hash>. */
  hash?: string
  /** File did not exist (or wasn't a regular file) at snapshot time. On
   *  restore: unlink if currently present. */
  absent?: boolean
  /** File was too large or unreadable at snapshot time. On restore: leave
   *  the live file alone — we couldn't capture it, so we can't undo it. */
  skip?: boolean
}

interface Manifest {
  ckptId: string
  ts: string
  messageCount: number
  userPrompt: string
  /** Keys are absolute paths (whatever `state.filesModified` stores). */
  files: Record<string, ManifestFileEntry>
}

function historyDir(sessionId: string, cwd: string): string {
  return path.join(cwd, XCODE_DIR, FILE_HISTORY_SUBDIR, sessionId)
}

function blobsDir(sessionId: string, cwd: string): string {
  return path.join(historyDir(sessionId, cwd), BLOBS_SUBDIR)
}

function checkpointsDir(sessionId: string, cwd: string): string {
  return path.join(historyDir(sessionId, cwd), CHECKPOINTS_SUBDIR)
}

function manifestPath(sessionId: string, ckptId: string, cwd: string): string {
  return path.join(checkpointsDir(sessionId, cwd), `${ckptId}.json`)
}

function blobPath(sessionId: string, hash: string, cwd: string): string {
  return path.join(blobsDir(sessionId, cwd), hash)
}

/** Local-time YYYYMMDD-HHMMSS-mmm, matching the sessionId shape so a
 *  directory listing of checkpoints sorts chronologically. */
function genCkptId(now: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${pad(now.getMilliseconds(), 3)}`
  )
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Distinguish "file truly doesn't exist" from "couldn't stat for any other
 *  reason (EACCES, EPERM, EBUSY...)". Mislabeling a permission-protected file
 *  as ENOENT would mark it `absent` and silently try to unlink it on restore —
 *  worse than leaving it alone. */
type StatOutcome = { kind: 'ok'; stat: Stats } | { kind: 'absent' } | { kind: 'unreadable' }
async function statSafe(p: string): Promise<StatOutcome> {
  try {
    return { kind: 'ok', stat: await fs.stat(p) }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' }
    return { kind: 'unreadable' }
  }
}

async function writeBlobIfMissing(sessionId: string, hash: string, content: Buffer, cwd: string): Promise<void> {
  const p = blobPath(sessionId, hash, cwd)
  if (await exists(p)) return
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, content)
}

/** Capture the current on-disk state of every file in `state.filesModified`
 *  into a new content-addressed checkpoint and append the entry to
 *  `state.checkpoints`. Returns the entry on success, null on FS failure
 *  (in which case rewind to this point would be unsafe — caller should
 *  treat the snapshot as unavailable, NOT silently skip it).
 *
 *  Snapshotting is best-effort per-file: a read failure on one path marks
 *  it `skip` and continues, so a transient EACCES on a single file doesn't
 *  doom the whole checkpoint. */
export async function createCheckpoint(
  state: LoopState,
  userPromptPreview: string,
  cwd: string = process.cwd(),
): Promise<CheckpointEntry | null> {
  const ckptId = genCkptId()
  const ts = new Date().toISOString()
  const messageCount = state.messages.length
  const files: Record<string, ManifestFileEntry> = {}

  for (const absPath of state.filesModified) {
    const outcome = await statSafe(absPath)
    if (outcome.kind === 'absent') {
      files[absPath] = { absent: true }
      continue
    }
    if (outcome.kind === 'unreadable') {
      // Couldn't stat for reasons OTHER than "file doesn't exist" — most
      // likely a permission issue. Mark skip so restore won't try to delete
      // a file the user (or another process) actively cares about.
      files[absPath] = { skip: true }
      continue
    }
    const stat = outcome.stat
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      // Symlinks / dirs / oversized blobs — record as skip so restore knows
      // to leave them alone (vs misclassifying as absent and deleting).
      files[absPath] = { skip: true }
      continue
    }
    try {
      const buf = await fs.readFile(absPath)
      const hash = createHash('sha256').update(buf).digest('hex')
      await writeBlobIfMissing(state.sessionId, hash, buf, cwd)
      files[absPath] = { hash }
    } catch {
      files[absPath] = { skip: true }
    }
  }

  const manifest: Manifest = {
    ckptId,
    ts,
    messageCount,
    userPrompt: userPromptPreview.slice(0, 200),
    files,
  }
  try {
    await fs.mkdir(checkpointsDir(state.sessionId, cwd), { recursive: true })
    await fs.writeFile(manifestPath(state.sessionId, ckptId, cwd), JSON.stringify(manifest, null, 2), 'utf-8')
  } catch {
    return null
  }

  const entry: CheckpointEntry = { ckptId, messageCount, ts, userPrompt: manifest.userPrompt }
  state.checkpoints.push(entry)

  // Ring-buffer eviction. Drop oldest manifests; defer blob GC to the
  // amortized sweep below so we don't re-read remaining manifests on every
  // eviction.
  let evicted = false
  while (state.checkpoints.length > MAX_CHECKPOINTS) {
    const dropped = state.checkpoints.shift()
    if (!dropped) break
    void fs.unlink(manifestPath(state.sessionId, dropped.ckptId, cwd)).catch(() => undefined)
    evicted = true
  }
  if (evicted) {
    // Awaited (not fire-and-forget) so tests see deterministic blob counts
    // and so a subsequent eviction can't race a still-running sweep into
    // double-deleting a blob the new manifest references. GC is O(remaining
    // checkpoints * files per manifest) — a few hundred reads at most,
    // amortized over hundreds of normal checkpoints between evictions.
    await garbageCollectBlobs(state, cwd).catch(() => undefined)
  }

  return entry
}

/** Restore the working tree to the state captured at `ckptId`. Algorithm,
 *  applied to the union of (current `filesModified`, manifest keys):
 *    - in manifest with `hash` → write blob content back
 *    - in manifest with `absent` → unlink (if present)
 *    - in manifest with `skip`   → leave alone (couldn't capture)
 *    - NOT in manifest           → unlink (was created after the checkpoint)
 *  Files outside this union are untouched — we only undo what the agent
 *  has historically touched.
 *
 *  After a successful restore:
 *    - `state.filesModified` is rebuilt from the manifest's keys (so the
 *      agent's notion of "touched files" matches the restored point).
 *    - Checkpoints after the target are dropped from `state.checkpoints`
 *      and their manifests deleted; orphaned blobs get GC'd.
 *
 *  Caller (use-agent) is responsible for truncating `state.messages` to
 *  `entry.messageCount - 1` and rewriting the session jsonl — restore
 *  here only touches the working tree + checkpoint bookkeeping. */
export async function restoreCheckpoint(
  state: LoopState,
  ckptId: string,
  cwd: string = process.cwd(),
): Promise<boolean> {
  let raw: string
  try {
    raw = await fs.readFile(manifestPath(state.sessionId, ckptId, cwd), 'utf-8')
  } catch {
    return false
  }
  let manifest: Manifest
  try {
    manifest = JSON.parse(raw) as Manifest
  } catch {
    return false
  }

  const allFiles = new Set<string>([...state.filesModified, ...Object.keys(manifest.files)])
  for (const absPath of allFiles) {
    const entry = manifest.files[absPath]
    if (!entry) {
      // Created in a turn AFTER this checkpoint — delete to roll back.
      await fs.unlink(absPath).catch(() => undefined)
      continue
    }
    if (entry.skip) continue
    if (entry.absent) {
      await fs.unlink(absPath).catch(() => undefined)
      continue
    }
    if (entry.hash) {
      try {
        const buf = await fs.readFile(blobPath(state.sessionId, entry.hash, cwd))
        await fs.mkdir(path.dirname(absPath), { recursive: true })
        await fs.writeFile(absPath, buf)
      } catch {
        // Missing blob → can't restore this file. Don't fail the whole
        // rewind: a single bad file is better than leaving the rest in a
        // half-restored state.
      }
    }
  }

  // Rebuild filesModified from the manifest so subsequent checkpoints cover
  // the right set. Includes absent/skip entries: those files have been
  // touched by the agent historically and should remain in scope.
  state.filesModified.clear()
  for (const absPath of Object.keys(manifest.files)) {
    state.filesModified.add(absPath)
  }

  // Drop checkpoints AFTER the restored one (keep the target — the user is
  // now "at" that point and can re-rewind to it).
  const cutoffIndex = state.checkpoints.findIndex((c) => c.ckptId === ckptId)
  if (cutoffIndex >= 0) {
    const dropped = state.checkpoints.splice(cutoffIndex + 1)
    for (const d of dropped) {
      void fs.unlink(manifestPath(state.sessionId, d.ckptId, cwd)).catch(() => undefined)
    }
  }
  await garbageCollectBlobs(state, cwd).catch(() => undefined)
  return true
}

/** Sweep blobs/ and unlink any blob not referenced by a remaining manifest.
 *  Cheap: O(remaining checkpoints * files per manifest) reads + one readdir.
 *  Runs after eviction and after restore — the only paths that orphan blobs. */
async function garbageCollectBlobs(state: LoopState, cwd: string): Promise<void> {
  const referenced = new Set<string>()
  for (const ckpt of state.checkpoints) {
    try {
      const raw = await fs.readFile(manifestPath(state.sessionId, ckpt.ckptId, cwd), 'utf-8')
      const m = JSON.parse(raw) as Manifest
      for (const entry of Object.values(m.files)) {
        if (entry.hash) referenced.add(entry.hash)
      }
    } catch {
      // Manifest gone or unreadable — skip; its blobs become candidates for
      // collection along with the rest.
    }
  }
  let names: string[]
  try {
    names = await fs.readdir(blobsDir(state.sessionId, cwd))
  } catch {
    return
  }
  for (const name of names) {
    if (!referenced.has(name)) {
      await fs.unlink(blobPath(state.sessionId, name, cwd)).catch(() => undefined)
    }
  }
}
