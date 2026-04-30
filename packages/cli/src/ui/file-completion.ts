// @x-code-cli/cli — Pure functions powering the @-mention file completion menu.
//
// Three responsibilities, kept stateless and side-effect free so they can be
// unit-tested without a terminal:
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
