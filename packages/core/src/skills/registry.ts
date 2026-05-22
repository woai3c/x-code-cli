// @x-code-cli/core — Skill registry
import { loadSkills } from './loader.js'

export interface SkillDefinition {
  name: string
  description: string
  content: string
  source: 'global' | 'project'
}

export class SkillRegistry {
  private readonly byName: Map<string, SkillDefinition>

  constructor(skills: SkillDefinition[]) {
    this.byName = new Map()
    // Last-write wins: project skills override globals of the same name
    // because loadSkills() returns globals first, then project skills.
    for (const skill of skills) {
      this.byName.set(skill.name, skill)
    }
  }

  get(name: string): SkillDefinition | undefined {
    return this.byName.get(name)
  }

  list(): SkillDefinition[] {
    return [...this.byName.values()]
  }

  names(): string[] {
    return [...this.byName.keys()]
  }
}

export async function createSkillRegistry(): Promise<SkillRegistry> {
  const skills = await loadSkills()
  return new SkillRegistry(skills)
}
