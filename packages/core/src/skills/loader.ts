// @x-code-cli/core — Skill loader
//
// Discovers Agent Skills (`<name>/SKILL.md` with YAML frontmatter) across the
// cross-agent `.agents/skills` standard, read-only `.claude/skills`
// compatibility directories, and `.x-code/skills` legacy/override directories.
//
// Precedence (low → high; later entries win on name collision):
//   1. User:    ~/.claude/skills → ~/.x-code/skills → ~/.agents/skills
//   2. Plugins: enabled plugin `skills/` contributions
//   3. Project: per directory from enclosing `.git` root down to `cwd`:
//               .claude/skills → .x-code/skills → .agents/skills
//
// Bad files are skipped with a warning — one broken SKILL.md must never
// crash the CLI.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { z } from 'zod'

import { parseFrontmatter } from '../utils/frontmatter.js'
import { XCODE_DIR, errorMessage, fileExists } from '../utils/index.js'
import type { SkillDefinition, SkillOrigin } from './registry.js'

const SKILL_FILENAME = 'SKILL.md'
export const AGENTS_DIR = '.agents'
export const CLAUDE_DIR = '.claude'

/** Intra-scope scan order (low → high priority; last-write wins).
 *  `.agents` is the primary cross-agent standard; `.x-code` preserves
 *  backward compatibility; `.claude` provides read-only Claude Code compat. */
const SKILL_ROOT_SPECS: ReadonlyArray<{ dirName: string; origin: Exclude<SkillOrigin, 'plugin'> }> = [
  { dirName: CLAUDE_DIR, origin: 'claude' },
  { dirName: XCODE_DIR, origin: 'xcode' },
  { dirName: AGENTS_DIR, origin: 'agents' },
]

/** Hard upper bound on the file count we list per skill — keeps the
 *  activation payload bounded even for skills that ship dozens of
 *  references / assets / scripts. Skills exceeding this get a truncation
 *  marker appended so the model knows the list isn't exhaustive. */
const MAX_LISTED_FILES = 50

/** Directory names skipped while listing a skill's bundled files —
 *  hidden dirs and obvious heavy ones that almost never contain skill
 *  resources. Listed by basename, not glob. */
const SKILL_FILE_LIST_SKIP_DIRS = new Set([
  'node_modules',
  '__pycache__',
  '.git',
  '.venv',
  'venv',
  'dist',
  'build',
  'target',
])

const frontmatterSchema = z.object({
  // Optional in frontmatter: some hand-authored Claude Code skills omit
  // `name` and rely on the enclosing directory name.
  name: z.string().min(1).optional(),
  description: z.string().min(1),
})

function normalizeComparePath(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Default user-scope directory where X-Code installs skills (`/skill install`).
 *  Targets `~/.agents/skills` in normal runs so installed skills follow the
 *  cross-agent standard; stays inside `$X_CODE_HOME/skills` when `X_CODE_HOME`
 *  is set for sandbox / test isolation. */
export function userSkillsDir(homeDir?: string): string {
  if (homeDir) return path.join(homeDir, AGENTS_DIR, 'skills')
  if (process.env.X_CODE_HOME) return path.join(process.env.X_CODE_HOME, 'skills')
  return path.join(os.homedir(), AGENTS_DIR, 'skills')
}

/** Collect project directories to scan for skills, ordered root → leaf.
 *  When `startDir` is inside a Git repository (an ancestor contains `.git`),
 *  scans every directory from the repo root down to `startDir` (matching
 *  Codex's monorepo convention). Outside a Git repository, scans `startDir`
 *  only so arbitrary parent directories (such as `~` or `/tmp`) are not
 *  misclassified as project scope. */
export async function collectProjectSkillDirs(startDir: string): Promise<string[]> {
  const visited: string[] = []
  let dir = path.resolve(startDir)
  const fsRoot = path.parse(dir).root
  let foundGitRoot = false

  while (true) {
    visited.push(dir)
    if (await fileExists(path.join(dir, '.git'))) {
      foundGitRoot = true
      break
    }
    if (dir === fsRoot) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return foundGitRoot ? visited.reverse() : [path.resolve(startDir)]
}

/** Walk a skill directory and return relative paths of its non-hidden
 *  files (excluding SKILL.md itself). Used at load time so SkillRegistry
 *  has a ready-to-inject list of bundled resources — Opencode and
 *  Gemini CLI do the same listing at activation, but X-Code caches it
 *  alongside the SkillDefinition since the registry is frozen for the
 *  session anyway (`/skill refresh` rebuilds). */
async function listSkillFiles(skillDir: string): Promise<string[]> {
  const out: string[] = []
  const visitedDirs = new Set<string>()

  async function walk(currentDir: string): Promise<void> {
    if (out.length >= MAX_LISTED_FILES) return

    let realDir: string
    try {
      realDir = normalizeComparePath(await fs.realpath(currentDir))
    } catch {
      realDir = normalizeComparePath(currentDir)
    }
    if (visitedDirs.has(realDir)) return
    visitedDirs.add(realDir)

    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (out.length >= MAX_LISTED_FILES) return
      if (entry.name.startsWith('.')) continue
      const fullPath = path.join(currentDir, entry.name)
      let isDirectory = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        try {
          const st = await fs.stat(fullPath)
          isDirectory = st.isDirectory()
          isFile = st.isFile()
        } catch {
          continue
        }
      }
      if (isDirectory) {
        if (SKILL_FILE_LIST_SKIP_DIRS.has(entry.name)) continue
        await walk(fullPath)
        continue
      }
      if (!isFile) continue
      const rel = path.relative(skillDir, fullPath).split(path.sep).join('/')
      if (rel === SKILL_FILENAME) continue
      out.push(rel)
    }
  }

  await walk(skillDir)
  return out.sort()
}

async function loadSkillsFromDir(
  dir: string,
  source: SkillDefinition['source'],
  origin: SkillOrigin,
  pluginId?: string,
): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = []

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return skills
  }

  // Deterministic alphabetical scan within a single skills directory so
  // filesystem readdir order cannot vary across platforms.
  for (const entry of [...entries].sort()) {
    const skillDir = path.join(dir, entry)
    const skillFile = path.join(skillDir, SKILL_FILENAME)

    try {
      await fs.access(skillFile)
    } catch {
      continue
    }

    try {
      const raw = await fs.readFile(skillFile, 'utf-8')
      const parsed = parseFrontmatter(raw)
      if (!parsed) {
        console.error(`[skills] Skipping ${skillFile}: no valid YAML frontmatter`)
        continue
      }

      const result = frontmatterSchema.safeParse(parsed.data)
      if (!result.success) {
        console.error(
          `[skills] Skipping ${skillFile}: invalid frontmatter — ${result.error.issues.map((i) => i.message).join(', ')}`,
        )
        continue
      }

      const files = await listSkillFiles(skillDir)

      skills.push({
        name: result.data.name ?? entry,
        description: result.data.description,
        content: parsed.body.trim(),
        source,
        origin,
        dir: skillDir,
        files,
        ...(pluginId ? { pluginId } : {}),
      })
    } catch (err) {
      console.error(`[skills] Skipping ${skillFile}: ${errorMessage(err)}`)
    }
  }

  return skills
}

export interface LoadSkillsOptions {
  /** Working directory used to walk project skill directories up to the
   *  enclosing `.git` root. Defaults to `process.cwd()`. */
  cwd?: string
  /** Explicit user home directory (containing `.agents`, `.claude`, `.x-code`).
   *  Defaults to `os.homedir()` unless `X_CODE_HOME` is set for sandbox isolation. */
  homeDir?: string
  /** Extra skill directories to scan after user skills and before project
   *  skills. Used to fold plugin-contributed `skills/` directories into
   *  the same registry — see packages/core/src/plugins/integration.ts.
   *  Order matters: later entries win on name collision. Plugin skills
   *  are scanned BEFORE project skills (so a user-authored project skill
   *  can override a plugin skill of the same name). */
  extraDirs?: ReadonlyArray<{ dir: string; pluginId: string }>
}

/** Load skills from user + plugin + project directories.
 *  Environment variable `XC_SKILLS_DIR` overrides the built-in paths for
 *  testing (extras are still honoured). */
export async function loadSkills(opts: LoadSkillsOptions = {}): Promise<SkillDefinition[]> {
  const override = process.env.XC_SKILLS_DIR
  if (override) {
    const overrideSkills = await loadSkillsFromDir(override, 'project', 'agents')
    return [...overrideSkills, ...(await loadFromExtras(opts.extraDirs))]
  }

  const seenSkillRoots = new Set<string>()
  const userSkills: SkillDefinition[] = []

  if (opts.homeDir) {
    for (const spec of SKILL_ROOT_SPECS) {
      const root = path.join(opts.homeDir, spec.dirName, 'skills')
      seenSkillRoots.add(normalizeComparePath(root))
      userSkills.push(...(await loadSkillsFromDir(root, 'user', spec.origin)))
    }
  } else if (process.env.X_CODE_HOME) {
    // Sandbox / test isolation: keep user-scope reads confined to X_CODE_HOME
    // so host ~/.agents and ~/.claude skills never leak into isolated runs.
    const root = path.join(process.env.X_CODE_HOME, 'skills')
    seenSkillRoots.add(normalizeComparePath(root))
    userSkills.push(...(await loadSkillsFromDir(root, 'user', 'xcode')))
  } else {
    const home = os.homedir()
    for (const spec of SKILL_ROOT_SPECS) {
      const root = path.join(home, spec.dirName, 'skills')
      seenSkillRoots.add(normalizeComparePath(root))
      userSkills.push(...(await loadSkillsFromDir(root, 'user', spec.origin)))
    }
  }

  const pluginSkills = await loadFromExtras(opts.extraDirs)

  const projectDirs = await collectProjectSkillDirs(opts.cwd ?? process.cwd())
  const projectSkills: SkillDefinition[] = []
  for (const projectDir of projectDirs) {
    for (const spec of SKILL_ROOT_SPECS) {
      const root = path.join(projectDir, spec.dirName, 'skills')
      const key = normalizeComparePath(root)
      // Avoid re-scanning user-scope directories as project-scope when `xc`
      // is launched directly inside the user's home directory.
      if (seenSkillRoots.has(key)) continue
      seenSkillRoots.add(key)
      projectSkills.push(...(await loadSkillsFromDir(root, 'project', spec.origin)))
    }
  }

  // Merge order — last-wins in the registry (project overrides plugin
  // overrides user; within each scope, .agents overrides .x-code overrides .claude).
  return [...userSkills, ...pluginSkills, ...projectSkills]
}

async function loadFromExtras(extras: LoadSkillsOptions['extraDirs']): Promise<SkillDefinition[]> {
  if (!extras || extras.length === 0) return []
  const out: SkillDefinition[] = []
  for (const { dir, pluginId } of extras) {
    // Plugin-provided skills' filesystem source is technically the cache
    // dir under ~/.x-code/plugins/cache/..., which makes 'user' the
    // closest fit (it's installed user-wide, not per-project). `pluginId`
    // carries the real provenance for the UI.
    out.push(...(await loadSkillsFromDir(dir, 'user', 'plugin', pluginId)))
  }
  return out
}
