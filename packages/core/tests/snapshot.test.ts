// Tests for the /rewind feature: content-addressed snapshot store +
// session-jsonl persistence + hydrate path.
//
// What we care about (and what would actually break for users):
//
//   1. Roundtrip: createCheckpoint → mutate → restore. The file content the
//      user sees afterward IS the pre-mutation content. This is the whole
//      point — if it doesn't hold, rewind is broken.
//   2. Dedup: identical content across two checkpoints occupies one blob on
//      disk. Without this, a 100-checkpoint cap could blow up to gigabytes.
//   3. After-checkpoint deletion: a file the agent CREATED after the
//      checkpoint must be unlinked on rewind. Otherwise "go back to before
//      I asked you to make X" leaves X on disk.
//   4. Absent / skip: files marked absent are re-deleted; files marked skip
//      (oversize, unreadable) are left alone. The skip semantics are the
//      safety valve — never silently delete a file we couldn't capture.
//   5. Persistence: appendCheckpoint → loadSession → hydrateLoopState gives
//      back the same checkpoint list. Without this, /rewind silently breaks
//      across /resume.
//   6. Compact-boundary semantics: pre-boundary checkpoints disappear on
//      load (their messageCount anchors are invalid after compaction).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createLoopState } from '../src/agent/loop-state.js'
import {
  appendCheckpoint,
  appendHeader,
  flushPendingMessages,
  hydrateLoopState,
  loadSession,
  markBoundaryAndReflush,
} from '../src/agent/session-store.js'
import { createCheckpoint, restoreCheckpoint } from '../src/agent/snapshot.js'
import { XCODE_DIR } from '../src/utils.js'

// ── Setup ───────────────────────────────────────────────────────────────

let tempDir: string
let originalCwd: string

beforeEach(() => {
  // chdir into a fresh tempdir so session-store writes (which use process.cwd())
  // and our explicit-cwd snapshot calls land in the same isolated tree. Matches
  // the pattern in session-store.test.ts.
  tempDir = mkdtempSync(path.join(tmpdir(), 'xc-snapshot-'))
  originalCwd = process.cwd()
  process.chdir(tempDir)
})

afterEach(() => {
  process.chdir(originalCwd)
  rmSync(tempDir, { recursive: true, force: true })
})

// ── Helpers ─────────────────────────────────────────────────────────────

async function writeWorkfile(rel: string, content: string): Promise<string> {
  const abs = path.join(tempDir, rel)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf-8')
  return abs
}

function historySubdir(sid: string, sub: 'blobs' | 'checkpoints'): string {
  return path.join(tempDir, XCODE_DIR, 'file-history', sid, sub)
}

async function lsHistory(sid: string, sub: 'blobs' | 'checkpoints'): Promise<string[]> {
  try {
    const { readdir } = await import('node:fs/promises')
    return (await readdir(historySubdir(sid, sub))).sort()
  } catch {
    return []
  }
}

// ── Snapshot core ───────────────────────────────────────────────────────

describe('snapshot: roundtrip', () => {
  it('restores file content captured at the checkpoint', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('src/a.ts', 'original')
    state.filesModified.add(file)

    const ckpt = await createCheckpoint(state, 'first prompt', tempDir)
    expect(ckpt).not.toBeNull()

    await writeFile(file, 'modified')
    const ok = await restoreCheckpoint(state, ckpt!.ckptId, tempDir)
    expect(ok).toBe(true)
    expect(await readFile(file, 'utf-8')).toBe('original')
  })

  it('returns false for an unknown checkpoint id', async () => {
    const state = createLoopState()
    expect(await restoreCheckpoint(state, 'does-not-exist', tempDir)).toBe(false)
  })

  it('records the entry on state.checkpoints with the correct messageCount', async () => {
    const state = createLoopState()
    // Simulate the agentLoop call site: messages.push then createCheckpoint.
    state.messages.push({ role: 'user', content: 'hello' })
    const ckpt = await createCheckpoint(state, 'hello', tempDir)
    expect(ckpt).not.toBeNull()
    expect(ckpt!.messageCount).toBe(1)
    expect(state.checkpoints).toHaveLength(1)
    expect(state.checkpoints[0]!.ckptId).toBe(ckpt!.ckptId)
  })
})

describe('snapshot: content-addressed dedup', () => {
  it('reuses a single blob across two checkpoints when content is unchanged', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('a.ts', 'shared content')
    state.filesModified.add(file)

    await createCheckpoint(state, 'm1', tempDir)
    await createCheckpoint(state, 'm2', tempDir)

    expect(await lsHistory(state.sessionId, 'blobs')).toHaveLength(1)
  })

  it('writes a fresh blob when content changes', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('a.ts', 'v1')
    state.filesModified.add(file)

    await createCheckpoint(state, 'm1', tempDir)
    await writeFile(file, 'v2')
    await createCheckpoint(state, 'm2', tempDir)

    expect(await lsHistory(state.sessionId, 'blobs')).toHaveLength(2)
  })
})

describe('snapshot: after-checkpoint deletion', () => {
  it('unlinks a file that was created after the checkpoint', async () => {
    const state = createLoopState()
    // ckpt 1 taken with empty filesModified — represents "the world before
    // any agent edits in this session".
    const ckpt1 = await createCheckpoint(state, 'm1', tempDir)
    expect(ckpt1).not.toBeNull()

    // Later, the agent "creates" newfile.ts and tracks it.
    const newfile = await writeWorkfile('newfile.ts', 'created later')
    state.filesModified.add(newfile)

    const ok = await restoreCheckpoint(state, ckpt1!.ckptId, tempDir)
    expect(ok).toBe(true)
    expect(existsSync(newfile)).toBe(false)
  })
})

describe('snapshot: absent handling', () => {
  it('recreates "absent at snapshot" by deleting the file on restore', async () => {
    const state = createLoopState()
    // Track a file that doesn't exist when the checkpoint is taken.
    const ghost = path.join(tempDir, 'ghost.ts')
    state.filesModified.add(ghost)

    const ckpt = await createCheckpoint(state, 'm1', tempDir)
    expect(ckpt).not.toBeNull()

    // Caller creates it later.
    await writeWorkfile('ghost.ts', 'now exists')
    expect(existsSync(ghost)).toBe(true)

    await restoreCheckpoint(state, ckpt!.ckptId, tempDir)
    // Manifest said absent → restore re-asserts absent → file unlinked.
    expect(existsSync(ghost)).toBe(false)
  })
})

describe('snapshot: oversize / skip', () => {
  it('does not blob oversized files, and leaves them alone on restore', async () => {
    const state = createLoopState()
    const big = path.join(tempDir, 'big.bin')
    // Sparse file slightly above the 10MB cap. truncate() is instant on most
    // FSes — we don't want to allocate 10MB in RAM just to test the boundary.
    const fh = await open(big, 'w')
    await fh.truncate(11 * 1024 * 1024)
    await fh.close()
    state.filesModified.add(big)

    const ckpt = await createCheckpoint(state, 'm1', tempDir)
    expect(ckpt).not.toBeNull()
    // Oversize → no blob written.
    expect(await lsHistory(state.sessionId, 'blobs')).toHaveLength(0)

    // Mutate AFTER the checkpoint, then restore.
    await writeFile(big, 'now small')
    const ok = await restoreCheckpoint(state, ckpt!.ckptId, tempDir)
    expect(ok).toBe(true)
    // Skip semantics: we couldn't capture it, so we won't undo it.
    expect(await readFile(big, 'utf-8')).toBe('now small')
  })
})

describe('snapshot: post-restore bookkeeping', () => {
  it('drops checkpoints after the restored one from state.checkpoints', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('a.ts', 'v1')
    state.filesModified.add(file)

    const c1 = await createCheckpoint(state, 'm1', tempDir)
    await writeFile(file, 'v2')
    await createCheckpoint(state, 'm2', tempDir)
    await writeFile(file, 'v3')
    await createCheckpoint(state, 'm3', tempDir)
    expect(state.checkpoints).toHaveLength(3)

    await restoreCheckpoint(state, c1!.ckptId, tempDir)
    expect(state.checkpoints).toHaveLength(1)
    expect(state.checkpoints[0]!.ckptId).toBe(c1!.ckptId)
    // Manifests on disk should also have been trimmed.
    expect(await lsHistory(state.sessionId, 'checkpoints')).toHaveLength(1)
  })

  it('garbage-collects blobs no longer referenced by any remaining manifest', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('a.ts', 'v1')
    state.filesModified.add(file)

    const c1 = await createCheckpoint(state, 'm1', tempDir)
    await writeFile(file, 'v2')
    await createCheckpoint(state, 'm2', tempDir)
    expect(await lsHistory(state.sessionId, 'blobs')).toHaveLength(2)

    await restoreCheckpoint(state, c1!.ckptId, tempDir)
    // v2's blob is now orphaned → GC unlinks it; only v1's blob remains.
    expect(await lsHistory(state.sessionId, 'blobs')).toHaveLength(1)
  })
})

// ── Session-store integration ──────────────────────────────────────────
//
// These cover the jsonl persistence layer that lets /rewind survive /resume.
// They're not "unit tests of session-store" (that's session-store.test.ts) —
// they're specifically the end-to-end contract appendCheckpoint → loadSession
// → hydrateLoopState that the picker depends on.

describe('rewind persistence: appendCheckpoint + loadSession roundtrip', () => {
  it('checkpoints written before any compact-boundary survive load', async () => {
    const state = createLoopState()
    state.taskSlug = 'fix-bug'
    state.messages.push({ role: 'user', content: 'one' })
    await appendHeader(state, 'anthropic:claude-x', 'one', tempDir)
    await flushPendingMessages(state)

    const ckpt = await createCheckpoint(state, 'one', tempDir)
    expect(ckpt).not.toBeNull()
    await appendCheckpoint(state, ckpt!)

    const sessionFile = path.join(tempDir, XCODE_DIR, 'sessions', `fix-bug-${state.sessionId}.jsonl`)
    const loaded = await loadSession(sessionFile)
    expect(loaded).not.toBeNull()
    expect(loaded!.checkpoints).toHaveLength(1)
    expect(loaded!.checkpoints[0]!.ckptId).toBe(ckpt!.ckptId)

    // And hydrate carries them onto the live state.
    const hydrated = hydrateLoopState(loaded!)
    expect(hydrated.checkpoints).toHaveLength(1)
    expect(hydrated.checkpoints[0]!.ckptId).toBe(ckpt!.ckptId)
  })

  it('checkpoints before a compact-boundary are dropped on load', async () => {
    // Why this matters: a pre-boundary checkpoint's `messageCount` anchor
    // points into the COMPACTED-OUT message range, so "rewind to here" is
    // meaningless. The loader has to drop them, matching the in-memory
    // clearing that markBoundaryAndReflush does.
    const state = createLoopState()
    state.taskSlug = 'compact-test'
    state.messages.push({ role: 'user', content: 'before' })
    await appendHeader(state, 'anthropic:claude-x', 'before', tempDir)
    await flushPendingMessages(state)

    const pre = await createCheckpoint(state, 'before', tempDir)
    await appendCheckpoint(state, pre!)

    // Simulate light compaction: shrink messages and write a boundary +
    // reflush. markBoundaryAndReflush clears state.checkpoints in memory,
    // and the boundary line on disk causes the loader to drop the pre
    // entry as well.
    state.messages = []
    state.messages.push({ role: 'user', content: 'after' })
    await markBoundaryAndReflush(state)
    expect(state.checkpoints).toHaveLength(0)

    const post = await createCheckpoint(state, 'after', tempDir)
    await appendCheckpoint(state, post!)

    const sessionFile = path.join(tempDir, XCODE_DIR, 'sessions', `compact-test-${state.sessionId}.jsonl`)
    const loaded = await loadSession(sessionFile)
    expect(loaded).not.toBeNull()
    // Only the post-boundary checkpoint should be visible.
    expect(loaded!.checkpoints).toHaveLength(1)
    expect(loaded!.checkpoints[0]!.ckptId).toBe(post!.ckptId)
  })
})
