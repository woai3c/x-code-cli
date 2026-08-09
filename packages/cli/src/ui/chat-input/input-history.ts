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
// Startup reads only the tail of the file. Appends periodically compact an
// oversized history through a temp-file + atomic rename so startup cost stays
// bounded without risking the original file on an interrupted rewrite.
//
// Writes are fire-and-forget from the UI and serialized per file inside this
// process so compaction cannot race a later append. We deliberately skip a
// cross-process lockfile: histories are project-local and each append remains
// one append-mode write.
import fs from 'node:fs/promises'
import path from 'node:path'

import { useEffect, useRef } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

import { ensureProjectStorageDir } from '@x-code-cli/core'

import type { PastedContents } from './paste-refs.js'
import type { InputAction } from './reducer.js'

const HISTORY_FILE = '.x-code/history.jsonl'
const HISTORY_READ_BYTES = 1024 * 1024
const HISTORY_COMPACT_BYTES = 2 * 1024 * 1024
const HISTORY_COMPACT_MAX = 500
const HISTORY_READ_CHUNK = 64 * 1024

/** Mirrors Claude Code's `MAX_HISTORY_ITEMS`. The user only sees the most
 *  recent 100 entries when pressing Up; disk compaction retains a wider
 *  500-entry window. */
const HISTORY_MAX = 100
const historyWriteQueues = new Map<string, Promise<void>>()

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
async function readHistoryTail(file: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(file, 'r')
  try {
    const stat = await handle.stat()
    const length = Math.min(stat.size, maxBytes)
    const start = stat.size - length
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    let raw = buffer.subarray(0, bytesRead).toString('utf-8')
    if (start > 0) {
      const firstNewline = raw.indexOf('\n')
      raw = firstNewline === -1 ? '' : raw.slice(firstNewline + 1)
    }
    return raw
  } finally {
    await handle.close()
  }
}

async function readLastRawLines(file: string, maxLines: number): Promise<string[]> {
  const handle = await fs.open(file, 'r')
  try {
    const stat = await handle.stat()
    let position = stat.size
    let newlineCount = 0
    const chunks: Buffer[] = []

    while (position > 0 && newlineCount <= maxLines) {
      const length = Math.min(HISTORY_READ_CHUNK, position)
      position -= length
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      const chunk = buffer.subarray(0, bytesRead)
      chunks.unshift(chunk)
      for (const byte of chunk) {
        if (byte === 0x0a) newlineCount++
      }
    }

    let raw = Buffer.concat(chunks).toString('utf-8')
    if (position > 0) {
      const firstNewline = raw.indexOf('\n')
      raw = firstNewline === -1 ? '' : raw.slice(firstNewline + 1)
    }
    return raw
      .split('\n')
      .filter((line) => line.length > 0)
      .slice(-maxLines)
  } finally {
    await handle.close()
  }
}

async function compactInputHistory(file: string): Promise<void> {
  const lines = await readLastRawLines(file, HISTORY_COMPACT_MAX)
  const tempFile = `${file}.${process.pid}-${Date.now()}.tmp`
  try {
    await fs.writeFile(tempFile, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf-8')
    await fs.rename(tempFile, file)
  } catch (error) {
    await fs.unlink(tempFile).catch(() => undefined)
    throw error
  }
}

export async function loadInputHistory(cwd: string = process.cwd()): Promise<InputHistoryEntry[]> {
  let raw: string
  try {
    raw = await readHistoryTail(historyPath(cwd), HISTORY_READ_BYTES)
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
async function appendInputHistoryNow(entry: InputHistoryEntry, file: string): Promise<void> {
  await ensureProjectStorageDir(path.dirname(file))
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8' })
  const stat = await fs.stat(file)
  if (stat.size > HISTORY_COMPACT_BYTES) await compactInputHistory(file)
}

export async function appendInputHistory(entry: InputHistoryEntry, cwd: string = process.cwd()): Promise<void> {
  const file = historyPath(cwd)
  const previous = historyWriteQueues.get(file) ?? Promise.resolve()
  const queued = previous.catch(() => undefined).then(() => appendInputHistoryNow(entry, file))
  historyWriteQueues.set(file, queued)
  try {
    await queued
  } catch {
    /* best-effort */
  } finally {
    if (historyWriteQueues.get(file) === queued) historyWriteQueues.delete(file)
  }
}

interface UseInputHistoryOptions {
  text: string
  cursorRef: MutableRefObject<number>
  pastedContents: PastedContents
  dispatch: Dispatch<InputAction>
  setPastedContents: Dispatch<SetStateAction<PastedContents>>
  setCompletionIndex: Dispatch<SetStateAction<number>>
  setAtCompletionIndex: Dispatch<SetStateAction<number>>
}

export function useInputHistory({
  text,
  cursorRef,
  pastedContents,
  dispatch,
  setPastedContents,
  setCompletionIndex,
  setAtCompletionIndex,
}: UseInputHistoryOptions) {
  // Navigation counters stay synchronous so rapid Up/Down presses never
  // observe a React-state value from the previous render. History keeps the
  // compact paste-reference form; restoring expanded pastes would flood the
  // input box with the original content.
  const historyRef = useRef<InputHistoryEntry[]>([])
  const historyIndexRef = useRef(0)
  const historyDraftRef = useRef<{ text: string; cursor: number; pasted: PastedContents } | null>(null)
  // Pin storage to the launch directory so a tool-driven `cd` cannot split a
  // session's reads and writes across two project history files.
  const initialCwdRef = useRef(process.cwd())

  useEffect(() => {
    let cancelled = false
    void loadInputHistory(initialCwdRef.current).then((entries) => {
      if (cancelled) return
      historyRef.current = entries
    })
    return () => {
      cancelled = true
    }
  }, [])

  const resetHistoryNav = () => {
    historyIndexRef.current = 0
    historyDraftRef.current = null
  }

  const pushHistory = (raw: string, pasted: PastedContents) => {
    if (!raw.trim()) return
    const last = historyRef.current[historyRef.current.length - 1]
    if (last && last.text === raw) return
    const entry: InputHistoryEntry = { text: raw, pasted: { ...pasted }, ts: Date.now() }
    historyRef.current.push(entry)
    if (historyRef.current.length > HISTORY_MAX) historyRef.current.shift()
    void appendInputHistory(entry, initialCwdRef.current)
  }

  const restoreHistoryEntry = (entry: { text: string; pasted: PastedContents }, cursorAt: 'start' | 'end') => {
    dispatch({ type: 'SET_TEXT', text: entry.text, cursor: cursorAt === 'start' ? 0 : entry.text.length })
    setPastedContents({ ...entry.pasted })
    setCompletionIndex(0)
    setAtCompletionIndex(0)
  }

  const navigateHistoryUp = () => {
    if (historyRef.current.length === 0) return
    if (historyIndexRef.current >= historyRef.current.length) return
    if (historyIndexRef.current === 0) {
      historyDraftRef.current = {
        text,
        cursor: cursorRef.current,
        pasted: { ...pastedContents },
      }
    }
    historyIndexRef.current += 1
    const entry = historyRef.current[historyRef.current.length - historyIndexRef.current]
    if (entry) restoreHistoryEntry(entry, 'start')
  }

  const navigateHistoryDown = () => {
    if (historyIndexRef.current <= 0) return
    historyIndexRef.current -= 1
    if (historyIndexRef.current === 0) {
      const draft = historyDraftRef.current
      historyDraftRef.current = null
      if (draft) {
        dispatch({ type: 'SET_TEXT', text: draft.text, cursor: draft.cursor })
        setPastedContents({ ...draft.pasted })
      } else {
        dispatch({ type: 'RESET' })
        setPastedContents({})
      }
      setCompletionIndex(0)
      setAtCompletionIndex(0)
      return
    }
    const entry = historyRef.current[historyRef.current.length - historyIndexRef.current]
    if (entry) restoreHistoryEntry(entry, 'end')
  }

  const isNavigatingHistory = () => historyIndexRef.current > 0

  return { isNavigatingHistory, navigateHistoryDown, navigateHistoryUp, pushHistory, resetHistoryNav }
}
