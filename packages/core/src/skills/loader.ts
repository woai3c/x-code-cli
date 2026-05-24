// @x-code-cli/core — Skill loader
//
// Scans ~/.x-code/skills/*/SKILL.md and <repo-root>/.x-code/skills/*/SKILL.md
// for user-defined skills with YAML frontmatter. The subdirectory layout
// mirrors all major competitors (Gemini CLI, Opencode, Codex) and allows
// future support files alongside SKILL.md.
//
// Priority: project-level skills override user-level skills of the same name.
// Bad files are skipped with a warning — one broken SKILL.md must never
// crash the CLI.
import fs from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { USER_XCODE_DIR, XCODE_DIR } from '../utils.js'
import type { SkillDefinition } from './registry.js'

const SKILL_FILENAME = 'SKILL.md'

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
  name: z.string().min(1),
  description: z.string().min(1),
})

/** Walk a skill directory and return relative paths of its non-hidden
 *  files (excluding SKILL.md itself). Used at load time so SkillRegistry
 *  has a ready-to-inject list of bundled resources — Opencode and
 *  Gemini CLI do the same listing at activation, but X-Code caches it
 *  alongside the SkillDefinition since the registry is frozen for the
 *  session anyway (`/skill refresh` rebuilds). */
async function listSkillFiles(skillDir: string): Promise<string[]> {
  const out: string[] = []

  async function walk(currentDir: string): Promise<void> {
    if (out.length >= MAX_LISTED_FILES) return

    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (out.length >= MAX_LISTED_FILES) return
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (SKILL_FILE_LIST_SKIP_DIRS.has(entry.name)) continue
        await walk(path.join(currentDir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const fullPath = path.join(currentDir, entry.name)
      const rel = path.relative(skillDir, fullPath).split(path.sep).join('/')
      if (rel === SKILL_FILENAME) continue
      out.push(rel)
    }
  }

  await walk(skillDir)
  return out.sort()
}

/** Minimal YAML frontmatter parser — reuses the same subset logic as
 *  sub-agent loader: string scalars only, no dependency on gray-matter. */
function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null

  const yamlBlock = match[1]!
  const body = match[2]!
  const data: Record<string, unknown> = {}

  // Fold YAML continuation lines: an indented non-empty line is joined to
  // the previous line with a single space. Mirrors the folded-scalar form
  // used by skill SKILL.md files where a long `description:` is wrapped
  // with 2-space indented continuations.
  const foldedLines: string[] = []
  for (const line of yamlBlock.split(/\r?\n/)) {
    if (/^\s/.test(line) && line.trim() && foldedLines.length > 0) {
      foldedLines[foldedLines.length - 1] += ' ' + line.trim()
    } else {
      foldedLines.push(line)
    }
  }

  for (const line of foldedLines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const colonIdx = trimmed.indexOf(':')
    if (colonIdx < 1) continue

    const key = trimmed.slice(0, colonIdx).trim()
    let value: string = trimmed.slice(colonIdx + 1).trim()

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    data[key] = value
  }

  return { data, body }
}

async function loadSkillsFromDir(
  dir: string,
  source: SkillDefinition['source'],
  pluginId?: string,
): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = []

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return skills
  }

  for (const entry of entries) {
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
        name: result.data.name,
        description: result.data.description,
        content: parsed.body.trim(),
        source,
        dir: skillDir,
        files,
        ...(pluginId ? { pluginId } : {}),
      })
    } catch (err) {
      console.error(`[skills] Skipping ${skillFile}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return skills
}

export interface LoadSkillsOptions {
  /** Extra skill directories to scan after the built-in user + project
   *  paths. Used to fold plugin-contributed `skills/` directories into
   *  the same registry — see packages/core/src/plugins/integration.ts.
   *  Order matters: later entries win on name collision. Plugin skills
   *  are scanned BEFORE project skills (so a user-authored project skill
   *  can override a plugin skill of the same name). */
  extraDirs?: ReadonlyArray<{ dir: string; pluginId: string }>
}

/** Load skills from user + project directories, plus any extra dirs
 *  passed in (used by the plugin system to fold in plugin-contributed
 *  skill directories). Environment variable `XC_SKILLS_DIR` overrides
 *  the built-in paths for testing (extras are still honoured). */
export async function loadSkills(opts: LoadSkillsOptions = {}): Promise<SkillDefinition[]> {
  const override = process.env.XC_SKILLS_DIR
  if (override) {
    const overrideSkills = await loadSkillsFromDir(override, 'project')
    return [...overrideSkills, ...(await loadFromExtras(opts.extraDirs))]
  }

  const userDir = path.join(USER_XCODE_DIR, 'skills')
  const projectDir = path.join(process.cwd(), XCODE_DIR, 'skills')

  const userSkills = await loadSkillsFromDir(userDir, 'user')
  const pluginSkills = await loadFromExtras(opts.extraDirs)
  const projectSkills = await loadSkillsFromDir(projectDir, 'project')

  // Merge order — last-wins in the registry (project overrides plugin
  // overrides user builtin). This matches the precedence we tell users:
  // a project-level skill always overrides anything from a plugin.
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
    out.push(...(await loadSkillsFromDir(dir, 'user', pluginId)))
  }
  return out
}
