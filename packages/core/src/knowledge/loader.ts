// @x-code-cli/core — Knowledge loader
//
// Layered project context loading. Sources (root-to-leaf precedence within a
// section; sections concatenated in the order below):
//
//   1. Global AGENTS.md (~/.x-code/AGENTS.md)       — user's cross-project prefs
//   2. Global auto memory (~/.x-code/memory/auto.md) — AI-written via saveKnowledge
//   3. Project AGENTS.md chain                       — walked up from cwd to repo root
//   4. Project auto memory (.x-code/memory/auto.md)  — AI-written via saveKnowledge
//   5. Local preferences (.x-code/local/preferences.md) — personal, gitignored
//
// Later sections in the resulting string carry more weight for the model, so
// monorepo sub-packages (deepest in the chain) override shared context, and
// local personal preferences override team-shared AGENTS.md content.
import path from 'node:path'

import { GLOBAL_XCODE_DIR, XCODE_DIR, fileExists, readFileSafe } from '../utils.js'
import { getAutoMemory } from './auto-memory.js'

const GLOBAL_DIR = GLOBAL_XCODE_DIR

/**
 * Walk from `startDir` upward, collecting every AGENTS.md found. Matches the
 * Codex convention: a repo-root AGENTS.md applies to the whole project, and
 * package-level AGENTS.md files (in a monorepo) override it with more specific
 * context. Stops at the first directory that contains `.git` (inclusive) or
 * at the filesystem root.
 *
 * Returns entries in root-to-leaf order so the deepest file is appended last.
 */
async function collectAgentsMdChain(startDir: string): Promise<Array<{ dir: string; content: string }>> {
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

  const entries: Array<{ dir: string; content: string }> = []
  for (const d of dirs.reverse()) {
    const content = await readFileSafe(path.join(d, 'AGENTS.md'))
    if (content) entries.push({ dir: d, content })
  }
  return entries
}

/** Build the full knowledge context for system prompt injection */
export async function buildKnowledgeContext(options?: { sessionContext?: string }): Promise<string> {
  const sections: string[] = []

  const globalAgents = await readFileSafe(path.join(GLOBAL_DIR, 'AGENTS.md'))
  if (globalAgents) {
    sections.push('### Global Preferences (~/.x-code/AGENTS.md)\n' + globalAgents)
  }

  const globalMemory = getAutoMemory('global')
  const globalMemoryContent = globalMemory.getPromptContent()
  if (globalMemoryContent) {
    sections.push('### Global Auto Memory\n' + globalMemoryContent)
  }

  const cwd = process.cwd()
  const agentsChain = await collectAgentsMdChain(cwd)
  for (const entry of agentsChain) {
    const relPath = path.relative(cwd, entry.dir) || '.'
    sections.push(`### Project AGENTS.md (${relPath})\n${entry.content}`)
  }

  const projectMemory = getAutoMemory('project')
  const projectMemoryContent = projectMemory.getPromptContent()
  if (projectMemoryContent) {
    sections.push('### Project Auto Memory\n' + projectMemoryContent)
  }

  const localPrefs = await readFileSafe(path.join(cwd, XCODE_DIR, 'local', 'preferences.md'))
  if (localPrefs) {
    sections.push('### Local Preferences\n' + localPrefs)
  }

  if (options?.sessionContext) {
    sections.push(options.sessionContext)
  }

  if (sections.length === 0) return ''
  return '## Project Knowledge\n\n' + sections.join('\n\n')
}
