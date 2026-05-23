// @x-code-cli/core — Skill registry
//
// Built once at CLI startup and frozen for the session. Adding, removing,
// enabling, or disabling a skill requires a CLI restart: the skill list is
// embedded in the system prompt and exposed as slash commands, and both
// caches assume byte-stable inputs for the whole session (CLAUDE.md). The
// /skill disable|enable|remove handlers write settings to disk and print a
// "Restart the CLI to apply." hint — they never mutate this registry.
import { loadSkills } from './loader.js'
import { loadDisabledSkillsSet } from './settings.js'

export interface SkillDefinition {
  name: string
  description: string
  content: string
  source: 'global' | 'project'
}

export interface SkillEntry extends SkillDefinition {
  disabled: boolean
}

export class SkillRegistry {
  private readonly byName: Map<string, SkillEntry>

  constructor(skills: SkillDefinition[], disabled: ReadonlySet<string> = new Set()) {
    this.byName = new Map()
    // Last-write wins: project skills override globals of the same name
    // because loadSkills() returns globals first, then project skills.
    for (const skill of skills) {
      this.byName.set(skill.name, { ...skill, disabled: disabled.has(skill.name) })
    }
  }

  /** Enabled skill by name. Disabled skills are hidden from the agent loop
   *  and slash-command dispatch — use `getEntry()` if you need to inspect
   *  the disabled flag (the /skill list handler does). */
  get(name: string): SkillDefinition | undefined {
    const entry = this.byName.get(name)
    if (!entry || entry.disabled) return undefined
    return entry
  }

  /** Enabled skills only. */
  list(): SkillDefinition[] {
    return [...this.byName.values()].filter((s) => !s.disabled)
  }

  /** Enabled skill names only. */
  names(): string[] {
    return [...this.byName.values()].filter((s) => !s.disabled).map((s) => s.name)
  }

  /** Every loaded skill, with `disabled` flag. Used by /skill list and the
   *  disable/enable/remove handlers so they can act on disabled skills too. */
  listAll(): SkillEntry[] {
    return [...this.byName.values()]
  }

  getEntry(name: string): SkillEntry | undefined {
    return this.byName.get(name)
  }
}

export async function createSkillRegistry(): Promise<SkillRegistry> {
  const [skills, disabled] = await Promise.all([loadSkills(), loadDisabledSkillsSet()])
  return new SkillRegistry(skills, disabled)
}
