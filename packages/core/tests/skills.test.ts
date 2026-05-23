// Tests for skill loader + registry
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { loadSkills } from '../src/skills/loader.js'
import { SkillRegistry } from '../src/skills/registry.js'

/** Create a temp dir, write skill subdirs into it, return the dir path. */
async function makeTempSkillsDir(skills: { dir: string; frontmatter: string; body: string }[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-skills-test-'))
  for (const s of skills) {
    const skillDir = path.join(root, s.dir)
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\n${s.frontmatter}\n---\n${s.body}`, 'utf-8')
  }
  return root
}

let originalSkillsDir: string | undefined

beforeEach(() => {
  originalSkillsDir = process.env.XC_SKILLS_DIR
})

afterEach(async () => {
  if (originalSkillsDir === undefined) {
    delete process.env.XC_SKILLS_DIR
  } else {
    process.env.XC_SKILLS_DIR = originalSkillsDir
  }
})

// ── loadSkills ────────────────────────────────────────────────────────────────

describe('loadSkills', () => {
  it('returns empty array when directory does not exist', async () => {
    process.env.XC_SKILLS_DIR = path.join(os.tmpdir(), 'xc-skills-nonexistent-' + Date.now())
    const skills = await loadSkills()
    expect(skills).toEqual([])
  })

  it('loads a valid skill', async () => {
    const dir = await makeTempSkillsDir([
      {
        dir: 'code-review',
        frontmatter: 'name: code-review\ndescription: Review code for quality',
        body: 'Review the code carefully.',
      },
    ])
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      name: 'code-review',
      description: 'Review code for quality',
      content: 'Review the code carefully.',
    })
  })

  it('loads multiple skills', async () => {
    const dir = await makeTempSkillsDir([
      {
        dir: 'skill-a',
        frontmatter: 'name: skill-a\ndescription: Skill A',
        body: 'Body A',
      },
      {
        dir: 'skill-b',
        frontmatter: 'name: skill-b\ndescription: Skill B',
        body: 'Body B',
      },
    ])
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills).toHaveLength(2)
    const names = skills.map((s) => s.name).sort()
    expect(names).toEqual(['skill-a', 'skill-b'])
  })

  it('skips skill dirs without SKILL.md', async () => {
    const dir = await makeTempSkillsDir([
      {
        dir: 'valid-skill',
        frontmatter: 'name: valid-skill\ndescription: Valid',
        body: 'Body',
      },
    ])
    // Extra directory with no SKILL.md
    await fs.mkdir(path.join(dir, 'empty-dir'), { recursive: true })
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('valid-skill')
  })

  it('skips SKILL.md with no frontmatter', async () => {
    const dir = path.join(os.tmpdir(), 'xc-skills-nofm-' + Date.now())
    await fs.mkdir(path.join(dir, 'bad-skill'), { recursive: true })
    await fs.writeFile(path.join(dir, 'bad-skill', 'SKILL.md'), 'No frontmatter here.', 'utf-8')
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills).toHaveLength(0)
  })

  it('skips SKILL.md missing required frontmatter fields', async () => {
    const dir = await makeTempSkillsDir([
      {
        dir: 'no-desc',
        frontmatter: 'name: no-desc', // missing description
        body: 'Body',
      },
    ])
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills).toHaveLength(0)
  })

  it('strips surrounding quotes from frontmatter values', async () => {
    const dir = await makeTempSkillsDir([
      {
        dir: 'quoted',
        frontmatter: 'name: "quoted-skill"\ndescription: "A quoted description"',
        body: 'Body',
      },
    ])
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills[0].name).toBe('quoted-skill')
    expect(skills[0].description).toBe('A quoted description')
  })

  it('trims leading/trailing whitespace from body', async () => {
    const dir = await makeTempSkillsDir([
      {
        dir: 'trim-test',
        frontmatter: 'name: trim-test\ndescription: Trim test',
        body: '\n\n  Body content  \n\n',
      },
    ])
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills[0].content).toBe('Body content')
  })
})

// ── SkillRegistry ─────────────────────────────────────────────────────────────

describe('SkillRegistry', () => {
  it('starts empty when given no skills', () => {
    const registry = new SkillRegistry([])
    expect(registry.list()).toEqual([])
    expect(registry.names()).toEqual([])
  })

  it('get returns undefined for unknown skill', () => {
    const registry = new SkillRegistry([])
    expect(registry.get('nonexistent')).toBeUndefined()
  })

  it('get returns the skill by name', () => {
    const registry = new SkillRegistry([
      { name: 'review', description: 'Code review', content: 'Review...', source: 'global' },
    ])
    const skill = registry.get('review')
    expect(skill).toBeDefined()
    expect(skill!.name).toBe('review')
    expect(skill!.content).toBe('Review...')
  })

  it('list returns all skills', () => {
    const defs = [
      { name: 'a', description: 'A', content: 'Body A', source: 'global' as const },
      { name: 'b', description: 'B', content: 'Body B', source: 'project' as const },
    ]
    const registry = new SkillRegistry(defs)
    expect(registry.list()).toHaveLength(2)
  })

  it('names returns all skill names', () => {
    const defs = [
      { name: 'alpha', description: 'Alpha', content: '', source: 'global' as const },
      { name: 'beta', description: 'Beta', content: '', source: 'global' as const },
    ]
    const registry = new SkillRegistry(defs)
    expect(registry.names().sort()).toEqual(['alpha', 'beta'])
  })

  it('project skill overrides global skill with same name', () => {
    // loadSkills returns globals first, then project — registry deduplicates
    // by last-write-wins, so project wins.
    const defs = [
      { name: 'review', description: 'Global review', content: 'Global body', source: 'global' as const },
      { name: 'review', description: 'Project review', content: 'Project body', source: 'project' as const },
    ]
    const registry = new SkillRegistry(defs)
    expect(registry.list()).toHaveLength(1)
    expect(registry.get('review')!.description).toBe('Project review')
    expect(registry.get('review')!.source).toBe('project')
  })

  it('different names are not deduplicated', () => {
    const defs = [
      { name: 'a', description: 'A', content: '', source: 'global' as const },
      { name: 'b', description: 'B', content: '', source: 'project' as const },
    ]
    const registry = new SkillRegistry(defs)
    expect(registry.list()).toHaveLength(2)
  })

  it('disabled skills are hidden from list/names/get but appear in listAll', () => {
    const defs = [
      { name: 'on-skill', description: 'On', content: '', source: 'global' as const },
      { name: 'off-skill', description: 'Off', content: '', source: 'global' as const },
    ]
    const registry = new SkillRegistry(defs, new Set(['off-skill']))
    expect(registry.list().map((s) => s.name)).toEqual(['on-skill'])
    expect(registry.names()).toEqual(['on-skill'])
    expect(registry.get('off-skill')).toBeUndefined()
    expect(registry.get('on-skill')).toBeDefined()
    expect(registry.listAll()).toHaveLength(2)
    expect(registry.listAll().find((s) => s.name === 'off-skill')!.disabled).toBe(true)
    expect(registry.listAll().find((s) => s.name === 'on-skill')!.disabled).toBe(false)
    expect(registry.getEntry('off-skill')!.disabled).toBe(true)
  })

  it('YAML folded scalar in description joins continuation lines', async () => {
    const dir = await makeTempSkillsDir([
      {
        dir: 'folded',
        frontmatter:
          'name: folded\ndescription: First chunk of the description\n  continues on the next line\n  and a third line',
        body: 'Body',
      },
    ])
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0].description).toBe('First chunk of the description continues on the next line and a third line')
  })
})

// ── settings (disabledSkills) ─────────────────────────────────────────────────

describe('skill settings', () => {
  let originalHome: string | undefined
  let originalCwd: string

  beforeEach(() => {
    originalHome = process.env.X_CODE_HOME
    originalCwd = process.cwd()
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.X_CODE_HOME
    else process.env.X_CODE_HOME = originalHome
    process.chdir(originalCwd)
  })

  it('union of global + project disabled lists', async () => {
    const { setSkillDisabled, loadDisabledSkillsSet } = await import('../src/skills/settings.js')
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-settings-test-home-'))
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-settings-test-proj-'))
    // utils.ts caches GLOBAL_XCODE_DIR at module-eval time, so X_CODE_HOME
    // alone won't redirect the global path here. We chdir into a temp
    // project dir to point the project scope at a fresh location; the
    // global path lives wherever utils.ts resolved it on first import.
    process.chdir(projectDir)

    await setSkillDisabled('alpha', 'project', true)
    await setSkillDisabled('beta', 'project', true)
    const disabled = await loadDisabledSkillsSet()
    expect(disabled.has('alpha')).toBe(true)
    expect(disabled.has('beta')).toBe(true)
  })

  it('setSkillDisabled returns noop when state already matches', async () => {
    const { setSkillDisabled } = await import('../src/skills/settings.js')
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-settings-noop-'))
    process.chdir(projectDir)

    expect(await setSkillDisabled('gamma', 'project', true)).toBe('changed')
    expect(await setSkillDisabled('gamma', 'project', true)).toBe('noop')
    expect(await setSkillDisabled('gamma', 'project', false)).toBe('changed')
    expect(await setSkillDisabled('gamma', 'project', false)).toBe('noop')
  })

  it('preserves unrelated fields in settings.json', async () => {
    const { setSkillDisabled, skillSettingsPath } = await import('../src/skills/settings.js')
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-settings-merge-'))
    process.chdir(projectDir)

    const file = skillSettingsPath('project')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ keepMe: 'yes', other: 42 }), 'utf-8')

    await setSkillDisabled('delta', 'project', true)
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.keepMe).toBe('yes')
    expect(parsed.other).toBe(42)
    expect(parsed.disabledSkills).toEqual(['delta'])
  })
})
