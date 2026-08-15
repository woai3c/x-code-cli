// @x-code-cli/core — Knowledge loader
//
// Layered project context loading. Sources (root-to-leaf precedence within a
// section; sections concatenated in the order below):
//
//   1. User AGENTS.md (~/.x-code/) — fallback to CLAUDE.md when absent
//   2. User memory Core profile (~/.x-code/memory/MEMORY.md)
//   3. Project AGENTS.md chain — fallback to CLAUDE.md per directory
//   4. AGENTS.local.md at project root                 — personal preferences, gitignored
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

import { fileExists, readFileSafe, userXcodeDir } from '../utils.js'
import type { MemoryService } from './memory/service.js'

/** Filenames recognised at each directory, tried in order. The first one
 *  found wins for that directory; the rest are skipped. AGENTS.md is our
 *  primary convention; CLAUDE.md is read-only fallback for compat. */
const KNOWLEDGE_FILENAMES = ['AGENTS.md', 'CLAUDE.md'] as const

/** Read whichever of AGENTS.md / CLAUDE.md exists in `dir`, preferring
 *  the former. Returns null when neither is present. */
async function readKnowledgeFile(dir: string): Promise<{ fileName: string; filePath: string; content: string } | null> {
  for (const fileName of KNOWLEDGE_FILENAMES) {
    const filePath = path.join(dir, fileName)
    const content = await readFileSafe(filePath)
    if (content) return { fileName, filePath, content }
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
): Promise<Array<{ dir: string; fileName: string; filePath: string; content: string }>> {
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

  const entries: Array<{ dir: string; fileName: string; filePath: string; content: string }> = []
  for (const d of dirs.reverse()) {
    const found = await readKnowledgeFile(d)
    if (found) entries.push({ dir: d, ...found })
  }
  return entries
}

/** Build the full knowledge context for system prompt injection */
export async function buildKnowledgeContext(options?: {
  sessionContext?: string
  memoryService?: MemoryService
  cwd?: string
}): Promise<string> {
  const sections: string[] = []
  const seenPaths = new Set<string>()
  const seenContents = new Set<string>()
  const pushUniqueSection = (heading: string, content: string, filePath?: string): void => {
    const resolvedPath = filePath ? path.resolve(filePath).replace(/\\/g, '/') : undefined
    const normalizedPath = resolvedPath && process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath
    if ((normalizedPath && seenPaths.has(normalizedPath)) || seenContents.has(content)) return
    if (normalizedPath) seenPaths.add(normalizedPath)
    seenContents.add(content)
    sections.push(`${heading}\n${content}`)
  }

  // User-scope human-written prefs: AGENTS.md preferred; fall back to
  // CLAUDE.md so users with an existing `~/.x-code/CLAUDE.md` (or one
  // copied over from Claude Code's home) get it picked up without
  // having to rename.
  const userKnowledge = await readKnowledgeFile(userXcodeDir())
  if (userKnowledge) {
    pushUniqueSection(
      `### User Preferences (~/.x-code/${userKnowledge.fileName})`,
      userKnowledge.content,
      userKnowledge.filePath,
    )
  }

  const userMemoryContent = options?.memoryService?.getCoreProfile().trim()
  if (userMemoryContent) {
    pushUniqueSection('### User Auto Memory', userMemoryContent)
  }

  const cwd = options?.cwd ?? process.cwd()
  const projectKnowledge = await collectProjectKnowledgeChain(cwd)
  for (const entry of projectKnowledge) {
    const relPath = path.relative(cwd, entry.dir) || '.'
    pushUniqueSection(`### Project ${entry.fileName} (${relPath})`, entry.content, entry.filePath)
  }

  const localPrefs = await readFileSafe(path.join(cwd, 'AGENTS.local.md'))
  if (localPrefs) {
    pushUniqueSection('### Local Preferences (AGENTS.local.md)', localPrefs, path.join(cwd, 'AGENTS.local.md'))
  }

  if (options?.sessionContext) {
    sections.push(options.sessionContext)
  }

  if (sections.length === 0) return ''
  return '## Project Knowledge\n\n' + sections.join('\n\n')
}
