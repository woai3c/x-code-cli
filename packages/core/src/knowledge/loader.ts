// @x-code-cli/core — Knowledge loader
//
// Layered project context loading. Sources (root-to-leaf precedence within a
// section; sections concatenated in the order below):
//
//   1. User AGENTS.md (~/.x-code/) — fallback to CLAUDE.md when absent
//   2. User auto memory (~/.x-code/memory/auto.md)     — AI-written via post-turn extractor
//   3. Project AGENTS.md chain — fallback to CLAUDE.md per directory
//   4. Project auto memory (.x-code/memory/auto.md)    — AI-written via post-turn extractor
//   5. AGENTS.local.md at project root                 — personal preferences, gitignored
//
// Later sections carry more weight for the model: monorepo sub-packages
// (deepest in the chain) override shared context, and local personal
// preferences override team-shared knowledge files.
//
// File-name policy is read-only fallback: at each directory we look for
// `AGENTS.md` (our convention, what `/init` creates) and only if it's
// absent do we fall back to `CLAUDE.md` (Claude Code compat — lets users
// with an existing CLAUDE.md keep using it without renaming). When both
// exist in the same directory, AGENTS.md wins outright and CLAUDE.md is
// ignored. Writes (`/init`, future tooling) always target AGENTS.md.
import path from 'node:path'

import { USER_XCODE_DIR, fileExists, readFileSafe } from '../utils.js'
import { getAutoMemory } from './auto-memory.js'

const USER_DIR = USER_XCODE_DIR

/** Filenames recognised at each directory, tried in order. The first one
 *  found wins for that directory; the rest are skipped. AGENTS.md is our
 *  primary convention; CLAUDE.md is read-only fallback for compat. */
const KNOWLEDGE_FILENAMES = ['AGENTS.md', 'CLAUDE.md'] as const

/** Read whichever of AGENTS.md / CLAUDE.md exists in `dir`, preferring
 *  the former. Returns null when neither is present. */
async function readKnowledgeFile(dir: string): Promise<{ fileName: string; content: string } | null> {
  for (const fileName of KNOWLEDGE_FILENAMES) {
    const content = await readFileSafe(path.join(dir, fileName))
    if (content) return { fileName, content }
  }
  return null
}

/**
 * Walk from `startDir` upward, collecting one knowledge file per directory.
 * Matches the Codex convention: a repo-root file applies to the whole
 * project, and package-level files (in a monorepo) override it with more
 * specific context. Stops at the first directory that contains `.git`
 * (inclusive) or at the filesystem root.
 *
 * Returns entries in root-to-leaf order so the deepest file is appended
 * last. Each directory contributes at most one entry (AGENTS.md if
 * present, otherwise CLAUDE.md, otherwise skipped).
 */
async function collectProjectKnowledgeChain(
  startDir: string,
): Promise<Array<{ dir: string; fileName: string; content: string }>> {
  const dirs: string[] = []
  let dir = path.resolve(startDir)
  const fsRoot = path.parse(dir).root

  while (true) {
    dirs.push(dir)
    if (await fileExists(path.join(dir, '.git'))) break
    if (dir === fsRoot) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  const entries: Array<{ dir: string; fileName: string; content: string }> = []
  for (const d of dirs.reverse()) {
    const found = await readKnowledgeFile(d)
    if (found) entries.push({ dir: d, fileName: found.fileName, content: found.content })
  }
  return entries
}

/** Build the full knowledge context for system prompt injection */
export async function buildKnowledgeContext(options?: { sessionContext?: string }): Promise<string> {
  const sections: string[] = []

  // User-scope human-written prefs: AGENTS.md preferred; fall back to
  // CLAUDE.md so users with an existing `~/.x-code/CLAUDE.md` (or one
  // copied over from Claude Code's home) get it picked up without
  // having to rename.
  const userKnowledge = await readKnowledgeFile(USER_DIR)
  if (userKnowledge) {
    sections.push(`### User Preferences (~/.x-code/${userKnowledge.fileName})\n${userKnowledge.content}`)
  }

  const userMemory = getAutoMemory('user')
  const userMemoryContent = userMemory.getPromptContent()
  if (userMemoryContent) {
    sections.push('### User Auto Memory\n' + userMemoryContent)
  }

  const cwd = process.cwd()
  const projectKnowledge = await collectProjectKnowledgeChain(cwd)
  for (const entry of projectKnowledge) {
    const relPath = path.relative(cwd, entry.dir) || '.'
    sections.push(`### Project ${entry.fileName} (${relPath})\n${entry.content}`)
  }

  const projectMemory = getAutoMemory('project')
  const projectMemoryContent = projectMemory.getPromptContent()
  if (projectMemoryContent) {
    sections.push('### Project Auto Memory\n' + projectMemoryContent)
  }

  const localPrefs = await readFileSafe(path.join(cwd, 'AGENTS.local.md'))
  if (localPrefs) {
    sections.push('### Local Preferences (AGENTS.local.md)\n' + localPrefs)
  }

  if (options?.sessionContext) {
    sections.push(options.sessionContext)
  }

  if (sections.length === 0) return ''
  return '## Project Knowledge\n\n' + sections.join('\n\n')
}
