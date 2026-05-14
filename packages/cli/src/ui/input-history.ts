// @x-code-cli/cli — Input history (Up/Down recall) backing store.
//
// Persisted form: `.x-code/history.jsonl`, one JSON object per line, append-
// only. Project-local so two unrelated projects don't pollute each other's
// recall — matches our existing convention (`.x-code/sessions/`,
// `.x-code/plans/`, `.x-code/memory/`). Claude Code instead uses a single
// global file with a `project:` field per entry; we chose the simpler
// per-project file because (a) it sidesteps the cross-process flush queue +
// lockfile dance their global file needs, and (b) it makes history feel like
// the rest of `.x-code/` — gitignored, scoped, throwaway-with-the-project.
//
// On load we read the WHOLE file and keep only the last HISTORY_MAX lines.
// The file naturally stays small (one short line per submit, project-scoped),
// so a streaming reverse-reader like Claude Code's `readLinesReverse` would
// be over-engineered here. Switch to streaming only if a real user grows
// their per-project file past a few MB.
//
// Writes are fire-and-forget `fs.appendFile`. POSIX guarantees an append of
// up to PIPE_BUF (4096 bytes) is atomic, and Windows' append-mode handle
// (`O_APPEND` → FILE_APPEND_DATA) is similarly atomic per write call — well
// within budget for a single-line history entry. We deliberately skip a
// lockfile: per-project file + rare concurrent xc instances + per-write
// atomic append = the lockfile would cost more than it buys.
import fs from 'node:fs/promises'
import path from 'node:path'

import type { PastedContents } from './paste-refs.js'

const HISTORY_FILE = '.x-code/history.jsonl'

/** Mirrors Claude Code's `MAX_HISTORY_ITEMS`. Read-side only — the file on
 *  disk grows unbounded, but the user only ever sees the most recent 100
 *  entries when pressing Up. Files containing more lines are sliced down
 *  in memory, never trimmed on disk. */
export const HISTORY_MAX = 100

export interface InputHistoryEntry {
  /** Pre-paste-expansion text (the placeholder form with `[Pasted text #N]`
   *  refs intact). Restoring this keeps the input box compact rather than
   *  unfolding the whole paste back into the live frame. */
  text: string
  pasted: PastedContents
  ts: number
}

function historyPath(cwd: string): string {
  return path.join(cwd, HISTORY_FILE)
}

/** Read up to HISTORY_MAX most-recent entries. Returned oldest-first so the
 *  caller can `push` new submits onto the tail and walk backwards via
 *  `arr[arr.length - 1 - i]` — same shape `historyRef` uses in-memory. */
export async function loadInputHistory(cwd: string = process.cwd()): Promise<InputHistoryEntry[]> {
  let raw: string
  try {
    raw = await fs.readFile(historyPath(cwd), 'utf-8')
  } catch {
    // ENOENT on first run — empty history. Any other error is silently
    // treated the same way: history is non-critical, never block startup.
    return []
  }
  // Trailing newline is normal (every append ends with `\n`); filter empties
  // along with any blank lines left by a partial write.
  const lines = raw.split('\n').filter((l) => l.length > 0)
  const tail = lines.length > HISTORY_MAX ? lines.slice(lines.length - HISTORY_MAX) : lines
  const out: InputHistoryEntry[] = []
  for (const line of tail) {
    try {
      const parsed = JSON.parse(line) as Partial<InputHistoryEntry>
      if (typeof parsed.text !== 'string' || !parsed.text) continue
      out.push({
        text: parsed.text,
        pasted: (parsed.pasted as PastedContents | undefined) ?? {},
        ts: typeof parsed.ts === 'number' ? parsed.ts : 0,
      })
    } catch {
      // Corrupt line (mid-write crash, manual edit). Skip — better to lose
      // one entry than break startup.
    }
  }
  return out
}

/** Append one entry. Fire-and-forget: returns a promise so tests can await,
 *  but the call site can ignore it. Errors are swallowed because input
 *  history is a UX nicety, not load-bearing — losing one entry to a disk
 *  hiccup is preferable to surfacing an error to the user mid-prompt. */
export async function appendInputHistory(entry: InputHistoryEntry, cwd: string = process.cwd()): Promise<void> {
  const file = historyPath(cwd)
  const line = JSON.stringify(entry) + '\n'
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, line, { encoding: 'utf-8' })
  } catch {
    /* best-effort */
  }
}
