// @x-code-cli/core — Skill loader
//
// Scans ~/.x-code/skills/*/SKILL.md and <repo-root>/.x-code/skills/*/SKILL.md
// for user-defined skills with YAML frontmatter. The subdirectory layout
// mirrors all major competitors (Gemini CLI, Opencode, Codex) and allows
// future support files alongside SKILL.md.
//
// Priority: project-level skills override global skills of the same name.
// Bad files are skipped with a warning — one broken SKILL.md must never
// crash the CLI.
import fs from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { GLOBAL_XCODE_DIR, XCODE_DIR } from '../utils.js'
import type { SkillDefinition } from './registry.js'

const SKILL_FILENAME = 'SKILL.md'

const frontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
})

/** Minimal YAML frontmatter parser — reuses the same subset logic as
 *  sub-agent loader: string scalars only, no dependency on gray-matter. */
function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null

  const yamlBlock = match[1]!
  const body = match[2]!
  const data: Record<string, unknown> = {}

  for (const line of yamlBlock.split(/\r?\n/)) {
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

async function loadSkillsFromDir(dir: string, source: SkillDefinition['source']): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = []

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return skills
  }

  for (const entry of entries) {
    const skillFile = path.join(dir, entry, SKILL_FILENAME)

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

      skills.push({
        name: result.data.name,
        description: result.data.description,
        content: parsed.body.trim(),
        source,
      })
    } catch (err) {
      console.error(`[skills] Skipping ${skillFile}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return skills
}

/** Load skills from global + project directories.
 *  Environment variable `XC_SKILLS_DIR` overrides both paths (testing only). */
export async function loadSkills(): Promise<SkillDefinition[]> {
  const override = process.env.XC_SKILLS_DIR
  if (override) {
    return loadSkillsFromDir(override, 'project')
  }

  const globalDir = path.join(GLOBAL_XCODE_DIR, 'skills')
  const projectDir = path.join(process.cwd(), XCODE_DIR, 'skills')

  const globalSkills = await loadSkillsFromDir(globalDir, 'global')
  const projectSkills = await loadSkillsFromDir(projectDir, 'project')

  // Project skills come last so their names win over global skills
  // when the registry deduplicates by name.
  return [...globalSkills, ...projectSkills]
}
