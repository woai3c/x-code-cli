// @x-code-cli/core — Per-session token usage persistence.
//
// Writes a small JSON snapshot to .x-code/sessions/{sessionId}.usage.json on
// every assistant turn so that /usage works after a restart and so the user
// can grep/diff usage across sessions in the project. Scope is intentionally
// per-cwd (project-local) — there's no cross-project aggregation.
//
// Kept separate from session.ts (which writes the LLM-generated SessionSummary
// at exit/compact) because the two write at different cadences and would
// clobber each other if they shared a file.
import fs from 'node:fs/promises'
import path from 'node:path'

import type { LoopState } from '../agent/loop-state.js'
import type { TokenUsage } from '../types/index.js'
import { XCODE_DIR } from '../utils.js'

export interface SessionUsageSnapshot {
  id: string
  modelId: string
  startedAt: string
  updatedAt: string
  turnCount: number
  usage: TokenUsage
}

const SESSIONS_DIR = `${XCODE_DIR}/sessions`

function getSessionsDir(): string {
  return path.join(process.cwd(), SESSIONS_DIR)
}

function getUsagePath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.usage.json`)
}

function getLatestUsagePath(): string {
  return path.join(getSessionsDir(), 'latest.usage.json')
}

/** Write the current usage state to disk. Fire-and-forget from the loop —
 *  callers should `void` this; failures are swallowed so a transient FS error
 *  never aborts the agent turn. */
export async function persistUsageSnapshot(state: LoopState, modelId: string): Promise<void> {
  const snapshot: SessionUsageSnapshot = {
    id: state.sessionId,
    modelId,
    startedAt: state.startedAt,
    updatedAt: new Date().toISOString(),
    turnCount: state.turnCount,
    usage: { ...state.tokenUsage },
  }
  try {
    await fs.mkdir(getSessionsDir(), { recursive: true })
    const json = JSON.stringify(snapshot, null, 2)
    await Promise.all([
      fs.writeFile(getUsagePath(state.sessionId), json, 'utf-8'),
      fs.writeFile(getLatestUsagePath(), json, 'utf-8'),
    ])
  } catch {
    // Persistence is best-effort; never block the agent loop on FS errors.
  }
}

/** Read the most recent usage snapshot for the current project (cwd). Returns
 *  null when no session has run here yet. /usage prefers in-memory state for
 *  the live session and only hits this on a fresh process. */
export async function loadLatestUsageSnapshot(): Promise<SessionUsageSnapshot | null> {
  try {
    const raw = await fs.readFile(getLatestUsagePath(), 'utf-8')
    return JSON.parse(raw) as SessionUsageSnapshot
  } catch {
    return null
  }
}

/** Enumerate every per-session usage snapshot in this project, newest first.
 *  Used by `/usage history` — purely project-local, never traverses other
 *  cwds. Skips `latest.usage.json` since it's a duplicate pointer. Silently
 *  drops malformed JSON files instead of failing the whole listing. */
export async function listSessionUsageSnapshots(): Promise<SessionUsageSnapshot[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(getSessionsDir())
  } catch {
    return []
  }
  const usageFiles = entries.filter((f) => f.endsWith('.usage.json') && f !== 'latest.usage.json')
  const snapshots = await Promise.all(
    usageFiles.map(async (f) => {
      try {
        const raw = await fs.readFile(path.join(getSessionsDir(), f), 'utf-8')
        return JSON.parse(raw) as SessionUsageSnapshot
      } catch {
        return null
      }
    }),
  )
  return snapshots
    .filter((s): s is SessionUsageSnapshot => s !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
