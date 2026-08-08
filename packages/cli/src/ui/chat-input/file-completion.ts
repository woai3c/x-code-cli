// @x-code-cli/cli — Workspace index and ranking for the @-mention file completion menu.
//
// The scanner is bounded and the matching operations stay stateless so both
// halves can be unit-tested without a terminal:
//
//   1. detectAtToken — given the input text + cursor, decide whether the
//      user is currently editing an `@…` token, and if so where it spans.
//      The trigger rule (`@` at line start or preceded by whitespace)
//      mirrors core's extractFileReferences (file-ingest.ts) — the UI must
//      never propose a path the backend would refuse, otherwise the user
//      sees the file get suggested but not ingested.
//
//   2. scoreAndRank — fuzzy-rank a flat list of file/dir entries against
//      the current query, with basename-vs-fullpath weighting and dotfile
//      gating (hidden unless the query itself starts with '.').
//
//   3. applyCompletion — splice a chosen entry into the buffer, replacing
//      the entire @-token (atIdx..tokenEnd) so a user typing through a
//      half-complete suggestion doesn't end up with a duplicated tail.
//   4. scanWorkspaceFiles — build a shallow-first, filtered workspace index.
//   5. useFileCompletion — own the scan lifecycle for ChatInput.
import fs from 'node:fs/promises'
import path from 'node:path'

import { useEffect, useState } from 'react'

export interface AtTrigger {
  /** True when the cursor sits inside an @-token whose '@' is at line
   *  start or preceded by whitespace. */
  active: boolean
  /** Position of the '@' itself (only meaningful when active). */
  atIdx: number
  /** Substring between '@' and the cursor — fed to scoreAndRank. */
  query: string
  /** Right boundary of the token (first whitespace at-or-after cursor,
   *  or text.length). applyCompletion replaces text.slice(atIdx, tokenEnd). */
  tokenEnd: number
}

const INACTIVE: AtTrigger = { active: false, atIdx: -1, query: '', tokenEnd: -1 }

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

export function detectAtToken(text: string, cursor: number): AtTrigger {
  if (cursor < 0 || cursor > text.length) return INACTIVE
  // Walk left from cursor; whitespace before '@' = not in a token.
  let i = cursor - 1
  while (i >= 0) {
    const ch = text[i] ?? ''
    if (ch === '@') break
    if (isWhitespace(ch)) return INACTIVE
    i--
  }
  if (i < 0 || text[i] !== '@') return INACTIVE
  const atIdx = i
  // Same prefix rule as file-ingest.ts:114 — keeps `user@host` and
  // `npm install foo@1.2` from popping the menu.
  if (atIdx > 0 && !isWhitespace(text[atIdx - 1] ?? '')) return INACTIVE
  // Right boundary: scan forward to first whitespace.
  let j = cursor
  while (j < text.length && !isWhitespace(text[j] ?? '')) j++
  return {
    active: true,
    atIdx,
    query: text.slice(atIdx + 1, cursor),
    tokenEnd: j,
  }
}

export interface FileEntry {
  /** POSIX-style path relative to cwd. */
  relPath: string
  isDirectory: boolean
}

export interface ScoredEntry extends FileEntry {
  score: number
}

function isHidden(relPath: string): boolean {
  const slash = relPath.lastIndexOf('/')
  const basename = slash >= 0 ? relPath.slice(slash + 1) : relPath
  return basename.startsWith('.')
}

/** Subsequence match with consecutive-run bonus. Returns -Infinity on miss.
 *  Earlier match positions outrank later ones (capped). */
function fuzzyScore(target: string, query: string): number {
  if (query.length === 0) return 0
  const t = target.toLowerCase()
  const q = query.toLowerCase()
  let ti = 0
  let qi = 0
  let score = 0
  let consecutive = 0
  let firstMatchIdx = -1
  while (ti < t.length && qi < q.length) {
    if (t[ti] === q[qi]) {
      if (firstMatchIdx === -1) firstMatchIdx = ti
      consecutive++
      score += 1 + consecutive
      qi++
    } else {
      consecutive = 0
    }
    ti++
  }
  if (qi < q.length) return -Infinity
  score += Math.max(0, 10 - firstMatchIdx)
  return score
}

function scoreEntry(entry: FileEntry, query: string): number {
  if (query.length === 0) {
    // Empty query: shallow paths first; alphabetical tie-break is handled
    // by the outer sort.
    const depth = entry.relPath.split('/').length
    return -depth
  }
  const slash = entry.relPath.lastIndexOf('/')
  const basename = slash >= 0 ? entry.relPath.slice(slash + 1) : entry.relPath
  // Basename match weighted heavily so `chat` ranks ChatInput.tsx above
  // a deep `src/foo/chatter/util.ts`.
  const baseScore = fuzzyScore(basename, query)
  if (baseScore !== -Infinity) return baseScore * 10
  return fuzzyScore(entry.relPath, query)
}

export function scoreAndRank(entries: FileEntry[], query: string): ScoredEntry[] {
  const showHidden = query.startsWith('.')
  const out: ScoredEntry[] = []
  for (const e of entries) {
    if (!showHidden && isHidden(e.relPath)) continue
    const score = scoreEntry(e, query)
    if (score === -Infinity) continue
    out.push({ ...e, score })
  }
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.relPath.localeCompare(b.relPath)
  })
  return out
}

/** Splice a picked entry into the buffer, replacing the full @-token.
 *  Directories get a trailing '/' so the user can keep typing a child
 *  path; files don't (cursor stops at the path so the user can keep
 *  composing the prompt). */
export function applyCompletion(
  text: string,
  atIdx: number,
  tokenEnd: number,
  picked: { relPath: string; isDirectory: boolean },
): { text: string; cursor: number } {
  const insert = '@' + picked.relPath + (picked.isDirectory ? '/' : '')
  const before = text.slice(0, atIdx)
  const after = text.slice(tokenEnd)
  return {
    text: before + insert + after,
    cursor: atIdx + insert.length,
  }
}

const HARD_BLACKLIST: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  '.x-code',
  'out',
  'build',
  'coverage',
  '.turbo',
  '.cache',
])

const DEFAULT_MAX_ENTRIES = 5000
const DEFAULT_MAX_MS = 200

interface SimpleIgnore {
  /** Bare names that match anywhere in the tree (`node_modules`, `dist`). */
  names: Set<string>
  /** Lower-cased suffixes including the dot (`.log`, `.tsbuildinfo`). */
  suffixes: Set<string>
}

const EMPTY_IGNORE: SimpleIgnore = { names: new Set(), suffixes: new Set() }

/** Parse a .gitignore content string with deliberately reduced semantics:
 *  - skip blank lines, comments (`#`), negations (`!…`)
 *  - `*.ext`               → suffix `.ext`
 *  - `name` / `/name` / `name/`  → bare name (matches at any depth)
 *  - anything containing `/` mid-pattern, `**`, or `?` / `[` is dropped
 *
 *  This catches the 90%+ case that hard-blacklist misses (`*.log`,
 *  `coverage`, `.DS_Store`, `*.tsbuildinfo`) without pulling in the
 *  `ignore` package. Repos with intricate ignore rules just won't
 *  benefit fully from gitignore filtering — the hard blacklist still
 *  protects them from the worst offenders. */
export function parseSimpleGitignore(content: string): SimpleIgnore {
  const names = new Set<string>()
  const suffixes = new Set<string>()
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    if (line.startsWith('*.') && !line.slice(2).match(/[\\/*?[\]]/)) {
      suffixes.add(line.slice(1).toLowerCase())
      continue
    }
    const stripped = line.replace(/^\/+/, '').replace(/\/+$/, '')
    if (!stripped) continue
    if (/[*?[\]/]/.test(stripped)) continue
    names.add(stripped)
  }
  return { names, suffixes }
}

async function loadIgnore(rootDir: string): Promise<SimpleIgnore> {
  try {
    const content = await fs.readFile(path.join(rootDir, '.gitignore'), 'utf-8')
    return parseSimpleGitignore(content)
  } catch {
    return EMPTY_IGNORE
  }
}

export interface ScanOptions {
  rootDir: string
  signal?: AbortSignal
  maxEntries?: number
  maxMs?: number
  /** Override gitignore. Test injection point — production path always
   *  loads `<rootDir>/.gitignore`. */
  ignore?: SimpleIgnore
}

/** BFS over rootDir with the three filtering layers. POSIX-style relPaths
 *  even on Windows so they match what the menu displays and what the user
 *  is typing (forward-slash). file-ingest.ts:118 normalizes either flavor
 *  on the backend. */
export async function scanWorkspaceFiles(opts: ScanOptions): Promise<FileEntry[]> {
  const { rootDir, signal, maxEntries = DEFAULT_MAX_ENTRIES, maxMs = DEFAULT_MAX_MS } = opts
  const ignore = opts.ignore ?? (await loadIgnore(rootDir))
  const start = Date.now()
  const result: FileEntry[] = []
  const queue: string[] = ['']

  const matchesSuffix = (name: string): boolean => {
    if (ignore.suffixes.size === 0) return false
    const lower = name.toLowerCase()
    for (const suf of ignore.suffixes) {
      if (lower.endsWith(suf)) return true
    }
    return false
  }

  while (queue.length > 0) {
    if (signal?.aborted) break
    if (Date.now() - start > maxMs) break
    if (result.length >= maxEntries) break

    const relDir = queue.shift()!
    const absDir = relDir === '' ? rootDir : path.join(rootDir, relDir)

    let dirents
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const dirent of dirents) {
      const name = dirent.name
      if (HARD_BLACKLIST.has(name)) continue
      if (ignore.names.has(name)) continue
      if (dirent.isSymbolicLink()) continue

      const isDir = dirent.isDirectory()
      const isFile = dirent.isFile()
      if (!isDir && !isFile) continue
      if (isFile && matchesSuffix(name)) continue

      const relPath = relDir ? `${relDir}/${name}` : name
      result.push({ relPath, isDirectory: isDir })
      if (isDir) queue.push(relPath)
      if (result.length >= maxEntries) break
    }
  }

  return result
}

export interface UseFileCompletionResult {
  entries: readonly FileEntry[]
  loading: boolean
}

/** React hook: scan once on mount, expose entries + loading flag. cwd is
 *  read from `process.cwd()` at scan time and never re-checked — shell
 *  tools that internally chdir don't affect the menu. */
export function useFileCompletion(): UseFileCompletionResult {
  const [entries, setEntries] = useState<readonly FileEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    scanWorkspaceFiles({ rootDir: process.cwd(), signal: ac.signal })
      .then((result) => {
        if (cancelled) return
        setEntries(result)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [])

  return { entries, loading }
}
