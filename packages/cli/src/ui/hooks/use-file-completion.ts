// @x-code-cli/cli — Workspace file index for @-mention completion.
//
// On mount we BFS-walk cwd and produce a flat list of {relPath, isDirectory}
// entries that the menu's fuzzy ranker consumes. Three filtering layers in
// descending order of authority:
//
//   1. Hard blacklist (node_modules, .git, dist, .next, .x-code, out,
//      build, coverage). Matches what every project ignores in practice and
//      keeps us from blowing the entry budget on vendor trees before
//      .gitignore parsing even runs.
//   2. Simple .gitignore (top-level file only — bare names and `*.suffix`
//      patterns; everything else is silently skipped). MVP-grade; we don't
//      take an `ignore` npm dependency for a UI nicety. Complex repos that
//      need full git semantics can fall back to the hard blacklist.
//   3. Symlink skip — prevents loops without needing a visited-set.
//
// Bounded by a 5000-entry / 200ms soft cap so a giant monorepo doesn't
// freeze the UI on startup. Hitting the cap returns whatever was scanned
// so far; the user sees suggestions for the BFS-frontier portion of the
// tree, which is by definition the shallow part — closer to what they
// actually want to type.
import fs from 'node:fs/promises'
import path from 'node:path'

import { useEffect, useState } from 'react'

import type { FileEntry } from '../file-completion.js'

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
  const queue: string[] = [''] // relative POSIX paths; '' = root

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
