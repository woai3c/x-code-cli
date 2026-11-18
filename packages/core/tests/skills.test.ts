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

// ── loadSkills: dir + files population ───────────────────────────────────────

describe('loadSkills bundled-resources support', () => {
  it('populates `dir` with the absolute skill directory path', async () => {
    const dir = await makeTempSkillsDir([
      {
        dir: 'with-dir',
        frontmatter: 'name: with-dir\ndescription: Skill that has a dir',
        body: 'Body',
      },
    ])
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0].dir).toBe(path.join(dir, 'with-dir'))
  })

  it('lists bundled files (excluding SKILL.md itself)', async () => {
    const dir = await makeTempSkillsDir([
      {
        dir: 'with-files',
        frontmatter: 'name: with-files\ndescription: Has bundled files',
        body: 'Body',
      },
    ])
    // Add scripts + references next to SKILL.md
    const skillRoot = path.join(dir, 'with-files')
    await fs.mkdir(path.join(skillRoot, 'scripts'), { recursive: true })
    await fs.writeFile(path.join(skillRoot, 'scripts', 'preflight.sh'), '#!/bin/sh\necho ok\n', 'utf-8')
    await fs.mkdir(path.join(skillRoot, 'references'), { recursive: true })
    await fs.writeFile(path.join(skillRoot, 'references', 'api.md'), '# API\n', 'utf-8')
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0].files.sort()).toEqual(['references/api.md', 'scripts/preflight.sh'])
  })

  it('skips hidden files and heavy directories (.git, node_modules)', async () => {
    const dir = await makeTempSkillsDir([
      {
        dir: 'with-heavy',
        frontmatter: 'name: with-heavy\ndescription: Has noise',
        body: 'Body',
      },
    ])
    const skillRoot = path.join(dir, 'with-heavy')
    // Hidden file at root + nested .git dir + node_modules dir
    await fs.writeFile(path.join(skillRoot, '.DS_Store'), '', 'utf-8')
    await fs.mkdir(path.join(skillRoot, '.git'), { recursive: true })
    await fs.writeFile(path.join(skillRoot, '.git', 'HEAD'), 'ref: ...', 'utf-8')
    await fs.mkdir(path.join(skillRoot, 'node_modules', 'foo'), { recursive: true })
    await fs.writeFile(path.join(skillRoot, 'node_modules', 'foo', 'package.json'), '{}', 'utf-8')
    // A real file that should still be listed
    await fs.writeFile(path.join(skillRoot, 'real.txt'), 'real content', 'utf-8')
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0].files).toEqual(['real.txt'])
  })
})

// ── wrapActivatedSkill / formatSkillActivationBody ───────────────────────────

describe('wrapActivatedSkill', () => {
  it('wraps body in <activated_skill> with base directory + file list footer', async () => {
    const { wrapActivatedSkill } = await import('../src/skills/registry.js')
    const skill = {
      name: 'demo',
      description: 'desc',
      content: 'Do the thing.',
      source: 'user' as const,
      dir: '/abs/path/to/skills/demo',
      files: ['scripts/run.sh', 'references/notes.md'],
    }
    const out = wrapActivatedSkill(skill)
    expect(out).toContain('<activated_skill name="demo">')
    expect(out).toContain('</activated_skill>')
    expect(out).toContain('Do the thing.')
    expect(out).toContain('Base directory for this skill: /abs/path/to/skills/demo')
    expect(out).toContain('- scripts/run.sh')
    expect(out).toContain('- references/notes.md')
  })

  it('omits file list section when skill has no bundled files', async () => {
    const { wrapActivatedSkill } = await import('../src/skills/registry.js')
    const skill = {
      name: 'pure',
      description: 'desc',
      content: 'Plain prompt.',
      source: 'user' as const,
      dir: '/abs/pure',
      files: [],
    }
    const out = wrapActivatedSkill(skill)
    expect(out).toContain('Base directory for this skill: /abs/pure')
    expect(out).not.toContain('Files in this skill directory:')
  })

  it('truncates very long file lists with a "... N more" marker', async () => {
    const { wrapActivatedSkill } = await import('../src/skills/registry.js')
    const files = Array.from({ length: 55 }, (_, i) => `file${i}.txt`)
    const skill = {
      name: 'big',
      description: 'desc',
      content: 'Body',
      source: 'user' as const,
      dir: '/abs/big',
      files,
    }
    const out = wrapActivatedSkill(skill)
    expect(out).toContain('- file0.txt')
    expect(out).toContain('- file49.txt')
    expect(out).not.toContain('- file50.txt')
    expect(out).toContain('and 5 more file(s) not shown')
  })
})

// ── SkillRegistry ─────────────────────────────────────────────────────────────

describe('SkillRegistry', () => {
  it('get returns the skill by name', () => {
    const registry = new SkillRegistry([
      {
        name: 'review',
        description: 'Code review',
        content: 'Review...',
        source: 'user',
        dir: '/skills/review',
        files: [],
      },
    ])
    const skill = registry.get('review')
    expect(skill).toBeDefined()
    expect(skill!.name).toBe('review')
    expect(skill!.content).toBe('Review...')
  })

  it('list returns all skills', () => {
    const defs = [
      { name: 'a', description: 'A', content: 'Body A', source: 'user' as const, dir: '/skills/a', files: [] },
      { name: 'b', description: 'B', content: 'Body B', source: 'project' as const, dir: '/skills/b', files: [] },
    ]
    const registry = new SkillRegistry(defs)
    expect(registry.list()).toHaveLength(2)
  })

  it('names returns all skill names', () => {
    const defs = [
      { name: 'alpha', description: 'Alpha', content: '', source: 'user' as const, dir: '/skills/alpha', files: [] },
      { name: 'beta', description: 'Beta', content: '', source: 'user' as const, dir: '/skills/beta', files: [] },
    ]
    const registry = new SkillRegistry(defs)
    expect(registry.names().sort()).toEqual(['alpha', 'beta'])
  })

  it('project skill overrides user-scope skill with same name', () => {
    // loadSkills returns user-scope first, then project — registry deduplicates
    // by last-write-wins, so project wins.
    const defs = [
      {
        name: 'review',
        description: 'User review',
        content: 'User body',
        source: 'user' as const,
        dir: '/user/skills/review',
        files: [],
      },
      {
        name: 'review',
        description: 'Project review',
        content: 'Project body',
        source: 'project' as const,
        dir: '/project/skills/review',
        files: [],
      },
    ]
    const registry = new SkillRegistry(defs)
    expect(registry.list()).toHaveLength(1)
    expect(registry.get('review')!.description).toBe('Project review')
    expect(registry.get('review')!.source).toBe('project')
  })

  it('different names are not deduplicated', () => {
    const defs = [
      { name: 'a', description: 'A', content: '', source: 'user' as const, dir: '/skills/a', files: [] },
      { name: 'b', description: 'B', content: '', source: 'project' as const, dir: '/skills/b', files: [] },
    ]
    const registry = new SkillRegistry(defs)
    expect(registry.list()).toHaveLength(2)
  })

  it('disabled skills are hidden from list/names/get but appear in listAll', () => {
    const defs = [
      { name: 'on-skill', description: 'On', content: '', source: 'user' as const, dir: '/skills/on', files: [] },
      {
        name: 'off-skill',
        description: 'Off',
        content: '',
        source: 'user' as const,
        dir: '/skills/off',
        files: [],
      },
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

  it('reload() replaces entries in place and returns a diff vs the previous state', () => {
    const v1 = [
      {
        name: 'alpha',
        description: 'A v1',
        content: 'body A v1',
        source: 'user' as const,
        dir: '/skills/alpha',
        files: [],
      },
      {
        name: 'beta',
        description: 'B v1',
        content: 'body B v1',
        source: 'user' as const,
        dir: '/skills/beta',
        files: [],
      },
    ]
    const registry = new SkillRegistry(v1)
    const refBefore = registry

    // alpha unchanged, beta description changed, gamma added, delta absent
    const v2 = [
      {
        name: 'alpha',
        description: 'A v1',
        content: 'body A v1',
        source: 'user' as const,
        dir: '/skills/alpha',
        files: [],
      },
      {
        name: 'beta',
        description: 'B v2',
        content: 'body B v1',
        source: 'user' as const,
        dir: '/skills/beta',
        files: [],
      },
      {
        name: 'gamma',
        description: 'G',
        content: 'body G',
        source: 'user' as const,
        dir: '/skills/gamma',
        files: [],
      },
    ]
    const summary = registry.reload(v2, new Set())

    expect(summary.added).toEqual(['gamma'])
    expect(summary.changed).toEqual(['beta'])
    expect(summary.unchanged).toEqual(['alpha'])
    expect(summary.removed).toEqual([])

    // Object identity preserved — callers caching the registry don't lose it
    expect(registry).toBe(refBefore)

    // Visible state matches v2
    expect(registry.names().sort()).toEqual(['alpha', 'beta', 'gamma'])
    expect(registry.get('beta')!.description).toBe('B v2')
  })

  it('reload() reports removed skills and clears them from list/get', () => {
    const v1 = [
      {
        name: 'alpha',
        description: 'A',
        content: 'body A',
        source: 'user' as const,
        dir: '/skills/alpha',
        files: [],
      },
      { name: 'beta', description: 'B', content: 'body B', source: 'user' as const, dir: '/skills/beta', files: [] },
    ]
    const registry = new SkillRegistry(v1)

    const summary = registry.reload(
      [
        {
          name: 'alpha',
          description: 'A',
          content: 'body A',
          source: 'user' as const,
          dir: '/skills/alpha',
          files: [],
        },
      ],
      new Set(),
    )

    expect(summary.removed).toEqual(['beta'])
    expect(registry.get('beta')).toBeUndefined()
    expect(registry.names()).toEqual(['alpha'])
  })

  it('reload() reports a disable toggle as changed', () => {
    const defs = [
      { name: 'alpha', description: 'A', content: 'body', source: 'user' as const, dir: '/skills/alpha', files: [] },
    ]
    const registry = new SkillRegistry(defs)
    expect(registry.get('alpha')).toBeDefined()

    const summary = registry.reload(defs, new Set(['alpha']))
    expect(summary.changed).toEqual(['alpha'])
    // Disabled — hidden from list/get, still visible via listAll
    expect(registry.get('alpha')).toBeUndefined()
    expect(registry.listAll()).toHaveLength(1)
    expect(registry.listAll()[0].disabled).toBe(true)
  })
})

// ── reloadSkillRegistry (integration) ────────────────────────────────────────

describe('reloadSkillRegistry', () => {
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
  })

  afterEach(() => {
    process.chdir(originalCwd)
  })

  it('rescans disk + settings and mutates the registry in place', async () => {
    const { createSkillRegistry, reloadSkillRegistry } = await import('../src/skills/registry.js')

    // Initial state: one skill on disk, no disabledSkills setting
    const skillsDir = await makeTempSkillsDir([
      {
        dir: 'initial',
        frontmatter: 'name: initial\ndescription: First skill',
        body: 'initial body',
      },
    ])
    process.env.XC_SKILLS_DIR = skillsDir
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-refresh-int-'))
    process.chdir(projectDir)

    const registry = await createSkillRegistry()
    expect(registry.names()).toEqual(['initial'])

    // Simulate user adding a new skill on disk
    await fs.mkdir(path.join(skillsDir, 'added'), { recursive: true })
    await fs.writeFile(
      path.join(skillsDir, 'added', 'SKILL.md'),
      `---\nname: added\ndescription: Second skill\n---\nadded body`,
      'utf-8',
    )

    const summary = await reloadSkillRegistry(registry)
    expect(summary.added).toEqual(['added'])
    expect(summary.unchanged).toEqual(['initial'])
    expect(registry.names().sort()).toEqual(['added', 'initial'])
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

  it('union of user + project disabled lists', async () => {
    const { setSkillDisabled, loadDisabledSkillsSet } = await import('../src/skills/settings.js')
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-settings-test-home-'))
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-settings-test-proj-'))
    // utils.ts caches USER_XCODE_DIR at module-eval time, so X_CODE_HOME
    // alone won't redirect the user-scope path here. We chdir into a temp
    // project dir to point the project scope at a fresh location; the
    // user-scope path lives wherever utils.ts resolved it on first import.
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

// ── createSkillRegistry integration ───────────────────────────────────────────
// End-to-end through loader + settings + registry filter. The unit tests
// above each cover one layer in isolation; this guards against future
// refactors that decouple the layers and silently let a disabled skill
// reach the agent loop (the failure mode would be a settings.json entry
// that the registry stops honoring).

describe('createSkillRegistry', () => {
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
  })

  afterEach(() => {
    process.chdir(originalCwd)
  })

  it('reads skills from disk, applies project-scope disable, and filters list/names/get', async () => {
    const { createSkillRegistry } = await import('../src/skills/registry.js')
    const { skillSettingsPath } = await import('../src/skills/settings.js')

    const skillsDir = await makeTempSkillsDir([
      {
        dir: 'skill-on',
        frontmatter: 'name: skill-on\ndescription: Stays enabled',
        body: 'On body',
      },
      {
        dir: 'skill-off',
        frontmatter: 'name: skill-off\ndescription: Should be disabled',
        body: 'Off body',
      },
    ])
    process.env.XC_SKILLS_DIR = skillsDir

    // Project-scope settings live under cwd/.x-code/settings.local.json.
    // Chdir to a fresh temp dir so we don't pollute the real repo or the
    // user's home (utils.ts caches USER_XCODE_DIR at import time, so we
    // can't redirect user scope here — project scope is sufficient
    // because XC_SKILLS_DIR also tags loaded skills as source='project').
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-registry-int-'))
    process.chdir(projectDir)
    const settingsFile = skillSettingsPath('project')
    await fs.mkdir(path.dirname(settingsFile), { recursive: true })
    await fs.writeFile(settingsFile, JSON.stringify({ disabledSkills: ['skill-off'] }), 'utf-8')

    const registry = await createSkillRegistry()

    // listAll surfaces both, with disabled flag set correctly.
    const all = registry.listAll()
    expect(all).toHaveLength(2)
    const onEntry = all.find((s) => s.name === 'skill-on')!
    const offEntry = all.find((s) => s.name === 'skill-off')!
    expect(onEntry.disabled).toBe(false)
    expect(offEntry.disabled).toBe(true)

    // list / names / get all hide the disabled one — this is the contract
    // the agent loop and system-prompt builder rely on.
    expect(registry.list().map((s) => s.name)).toEqual(['skill-on'])
    expect(registry.names()).toEqual(['skill-on'])
    expect(registry.get('skill-off')).toBeUndefined()
    expect(registry.get('skill-on')).toBeDefined()

    // getEntry is the one accessor that still returns disabled skills,
    // for the /skill list + /skill enable handlers to act on them.
    expect(registry.getEntry('skill-off')?.disabled).toBe(true)
  })
})

// ── Cross-agent skill discovery (.agents / .claude / .x-code) ────────────────

describe('cross-agent skill discovery', () => {
  let originalXcodeHome: string | undefined
  const tempDirs: string[] = []

  async function makeTempDir(prefix: string): Promise<string> {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
    tempDirs.push(d)
    return d
  }

  async function writeSkill(
    baseRoot: string,
    dirFamily: '.agents' | '.claude' | '.x-code',
    skillDirName: string,
    frontmatter: string,
    body: string,
  ): Promise<string> {
    const dir = path.join(baseRoot, dirFamily, 'skills', skillDirName)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`, 'utf-8')
    return dir
  }

  beforeEach(() => {
    originalXcodeHome = process.env.X_CODE_HOME
    delete process.env.XC_SKILLS_DIR
  })

  afterEach(async () => {
    if (originalXcodeHome === undefined) delete process.env.X_CODE_HOME
    else process.env.X_CODE_HOME = originalXcodeHome
    for (const d of tempDirs.splice(0)) {
      await fs.rm(d, { recursive: true, force: true })
    }
  })

  it('discovers .agents, .claude, and .x-code skills across user and project scopes with expected precedence', async () => {
    const homeDir = await makeTempDir('xc-skill-home-')
    const repoDir = await makeTempDir('xc-skill-repo-')

    // Unique skills per origin
    await writeSkill(homeDir, '.claude', 'u-claude', 'name: u-claude\ndescription: User claude', 'uc')
    await writeSkill(homeDir, '.x-code', 'u-xcode', 'name: u-xcode\ndescription: User xcode', 'ux')
    await writeSkill(homeDir, '.agents', 'u-agents', 'name: u-agents\ndescription: User agents', 'ua')
    await writeSkill(repoDir, '.claude', 'p-claude', 'name: p-claude\ndescription: Proj claude', 'pc')
    await writeSkill(repoDir, '.x-code', 'p-xcode', 'name: p-xcode\ndescription: Proj xcode', 'px')
    await writeSkill(repoDir, '.agents', 'p-agents', 'name: p-agents\ndescription: Proj agents', 'pa')

    // User intra-scope collision: .agents > .x-code > .claude
    await writeSkill(homeDir, '.claude', 'u-collide', 'name: u-collide\ndescription: from claude', 'c')
    await writeSkill(homeDir, '.x-code', 'u-collide', 'name: u-collide\ndescription: from xcode', 'x')
    await writeSkill(homeDir, '.agents', 'u-collide', 'name: u-collide\ndescription: from agents', 'a')

    // Project intra-scope collision: .agents > .x-code > .claude
    await writeSkill(repoDir, '.claude', 'p-collide', 'name: p-collide\ndescription: proj claude', 'pc')
    await writeSkill(repoDir, '.x-code', 'p-collide', 'name: p-collide\ndescription: proj xcode', 'px')
    await writeSkill(repoDir, '.agents', 'p-collide', 'name: p-collide\ndescription: proj agents', 'pa')

    // Cross-scope collision: project .claude still overrides user .agents and plugin
    await writeSkill(homeDir, '.agents', 'cross', 'name: cross\ndescription: user agents', 'ua')
    await writeSkill(repoDir, '.claude', 'cross', 'name: cross\ndescription: project claude', 'pc')
    const pluginDir = await makeTempDir('xc-skill-plugin-')
    await fs.mkdir(path.join(pluginDir, 'cross'), { recursive: true })
    await fs.writeFile(
      path.join(pluginDir, 'cross', 'SKILL.md'),
      '---\nname: cross\ndescription: plugin cross\n---\np',
      'utf-8',
    )

    const skills = await loadSkills({
      homeDir,
      cwd: repoDir,
      extraDirs: [{ dir: pluginDir, pluginId: 'demo@local' }],
    })
    const registry = new SkillRegistry(skills)

    expect(registry.get('u-claude')).toMatchObject({ source: 'user', origin: 'claude' })
    expect(registry.get('u-xcode')).toMatchObject({ source: 'user', origin: 'xcode' })
    expect(registry.get('u-agents')).toMatchObject({ source: 'user', origin: 'agents' })
    expect(registry.get('p-claude')).toMatchObject({ source: 'project', origin: 'claude' })
    expect(registry.get('p-xcode')).toMatchObject({ source: 'project', origin: 'xcode' })
    expect(registry.get('p-agents')).toMatchObject({ source: 'project', origin: 'agents' })

    expect(registry.get('u-collide')).toMatchObject({ description: 'from agents', origin: 'agents', source: 'user' })
    expect(registry.get('p-collide')).toMatchObject({ description: 'proj agents', origin: 'agents', source: 'project' })
    expect(registry.get('cross')).toMatchObject({ description: 'project claude', origin: 'claude', source: 'project' })
  })

  it('walks upward from subdirectory cwd to enclosing .git root (root -> leaf precedence)', async () => {
    const homeDir = await makeTempDir('xc-mono-home-')
    const repoRoot = await makeTempDir('xc-mono-repo-')
    await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true })
    const pkgDir = path.join(repoRoot, 'packages', 'cli')
    await fs.mkdir(pkgDir, { recursive: true })

    await writeSkill(repoRoot, '.agents', 'shared', 'name: shared\ndescription: Root shared', 'root')
    await writeSkill(repoRoot, '.claude', 'claude-root', 'name: claude-root\ndescription: Root claude', 'rc')
    await writeSkill(repoRoot, '.agents', 'override-me', 'name: override-me\ndescription: Root version', 'rv')
    await writeSkill(pkgDir, '.agents', 'override-me', 'name: override-me\ndescription: Leaf version', 'lv')

    const registry = new SkillRegistry(await loadSkills({ homeDir, cwd: pkgDir }))
    expect(registry.get('shared')?.description).toBe('Root shared')
    expect(registry.get('claude-root')?.description).toBe('Root claude')
    expect(registry.get('override-me')?.description).toBe('Leaf version')
  })

  it('does not walk into parent directories when cwd is outside a Git repository', async () => {
    const homeDir = await makeTempDir('xc-nogit-home-')
    const parentDir = await makeTempDir('xc-nogit-parent-')
    const childDir = path.join(parentDir, 'workspace')
    await fs.mkdir(childDir, { recursive: true })

    await writeSkill(parentDir, '.agents', 'stray', 'name: stray\ndescription: Parent stray', 'stray')
    await writeSkill(childDir, '.agents', 'local', 'name: local\ndescription: Child local', 'local')

    const registry = new SkillRegistry(await loadSkills({ homeDir, cwd: childDir }))
    expect(registry.get('stray')).toBeUndefined()
    expect(registry.get('local')?.description).toBe('Child local')
  })

  it('does not promote user skills to project scope when launched directly in homeDir', async () => {
    const homeDir = await makeTempDir('xc-inhome-')
    await writeSkill(homeDir, '.agents', 'my-skill', 'name: my-skill\ndescription: User skill', 'body')

    const skills = await loadSkills({ homeDir, cwd: homeDir })
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ name: 'my-skill', source: 'user', origin: 'agents' })
  })

  it('confines user-scope discovery and userSkillsDir() to X_CODE_HOME when set', async () => {
    const { userSkillsDir } = await import('../src/skills/registry.js')
    const sandboxHome = await makeTempDir('xc-sandbox-home-')
    const emptyProj = await makeTempDir('xc-sandbox-proj-')
    process.env.X_CODE_HOME = sandboxHome

    expect(userSkillsDir()).toBe(path.join(sandboxHome, 'skills'))

    await fs.mkdir(path.join(sandboxHome, 'skills', 'sandboxed'), { recursive: true })
    await fs.writeFile(
      path.join(sandboxHome, 'skills', 'sandboxed', 'SKILL.md'),
      '---\nname: sandboxed\ndescription: Inside sandbox\n---\nsandbox body',
      'utf-8',
    )

    const skills = await loadSkills({ cwd: emptyProj })
    expect(skills.map((s) => s.name)).toEqual(['sandboxed'])
    expect(skills[0]).toMatchObject({ source: 'user', origin: 'xcode' })
  })

  it('supports omitted name (falls back to directory name) and YAML block scalar descriptions', async () => {
    const homeDir = await makeTempDir('xc-compat-home-')
    const repoDir = await makeTempDir('xc-compat-repo-')

    await writeSkill(
      repoDir,
      '.claude',
      'inferred-name',
      'description: >-\n  Multi-line folded\n  Claude skill description',
      'Skill body',
    )
    await writeSkill(
      repoDir,
      '.agents',
      'literal-block',
      'name: literal-block\ndescription: |\n  Literal block\n  second line',
      'Body 2',
    )
    await writeSkill(
      repoDir,
      '.agents',
      'quoted-angle',
      'name: quoted-angle\ndescription: "> keep leading angle"',
      'Body 3',
    )

    const registry = new SkillRegistry(await loadSkills({ homeDir, cwd: repoDir }))
    expect(registry.get('inferred-name')?.description).toBe('Multi-line folded Claude skill description')
    expect(registry.get('literal-block')?.description).toBe('Literal block second line')
    expect(registry.get('quoted-angle')?.description).toBe('> keep leading angle')
  })

  it('follows symlinked skill directories (npx skills layout)', async () => {
    const homeDir = await makeTempDir('xc-symlink-home-')
    const repoDir = await makeTempDir('xc-symlink-repo-')

    const targetDir = await writeSkill(
      repoDir,
      '.agents',
      'linked-skill',
      'name: linked-skill\ndescription: Canonical skill',
      'Body',
    )
    await fs.writeFile(path.join(targetDir, 'helper.txt'), 'helper', 'utf-8')

    // Also link an alias under .claude/skills using junction on Windows so
    // unprivileged Windows runners don't fail with EPERM.
    const claudeSkillsRoot = path.join(repoDir, '.claude', 'skills')
    await fs.mkdir(claudeSkillsRoot, { recursive: true })
    await fs.symlink(
      targetDir,
      path.join(claudeSkillsRoot, 'claude-only-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    // Rename frontmatter omission scenario: create a skill without `name` so the symlink's dir name wins
    const namelessTarget = path.join(repoDir, 'shared-store', 'nameless')
    await fs.mkdir(namelessTarget, { recursive: true })
    await fs.writeFile(
      path.join(namelessTarget, 'SKILL.md'),
      '---\ndescription: Linked nameless skill\n---\nBody',
      'utf-8',
    )
    await fs.writeFile(path.join(namelessTarget, 'ref.md'), '# Ref', 'utf-8')
    await fs.symlink(
      namelessTarget,
      path.join(claudeSkillsRoot, 'nameless-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    const registry = new SkillRegistry(await loadSkills({ homeDir, cwd: repoDir }))
    expect(registry.get('nameless-link')).toMatchObject({
      description: 'Linked nameless skill',
      origin: 'claude',
      files: ['ref.md'],
    })
  })

  it('reloadSkillRegistry preserves initial cwd and plugin extraDirs when called with no args', async () => {
    const { createSkillRegistry, reloadSkillRegistry } = await import('../src/skills/registry.js')
    const homeDir = await makeTempDir('xc-reload-home-')
    const repoDir = await makeTempDir('xc-reload-repo-')
    const pluginDir = await makeTempDir('xc-reload-plugin-')

    await fs.mkdir(path.join(pluginDir, 'p-skill'), { recursive: true })
    await fs.writeFile(
      path.join(pluginDir, 'p-skill', 'SKILL.md'),
      '---\nname: p-skill\ndescription: Plugin skill\n---\nplugin body',
      'utf-8',
    )

    const registry = await createSkillRegistry({
      homeDir,
      cwd: repoDir,
      extraDirs: [{ dir: pluginDir, pluginId: 'demo@local' }],
    })
    expect(registry.names()).toEqual(['p-skill'])

    await writeSkill(repoDir, '.agents', 'new-proj', 'name: new-proj\ndescription: Added project skill', 'body')
    const summary = await reloadSkillRegistry(registry)
    expect(summary.added).toEqual(['new-proj'])
    expect(summary.unchanged).toEqual(['p-skill'])
    expect(registry.names().sort()).toEqual(['new-proj', 'p-skill'])
  })

  it('preserves multi-paragraph YAML block scalars across blank lines and strips indented comments', async () => {
    const homeDir = await makeTempDir('xc-multipar-home-')
    const repoDir = await makeTempDir('xc-multipar-repo-')

    await writeSkill(
      repoDir,
      '.agents',
      'multi-para',
      'name: multi-para\ndescription: >\n  First paragraph.\n\n  # Indented comment\n  Note: second paragraph after blank line.',
      'Body',
    )

    const registry = new SkillRegistry(await loadSkills({ homeDir, cwd: repoDir }))
    expect(registry.get('multi-para')?.description).toBe('First paragraph. Note: second paragraph after blank line.')
  })

  it('resolves mixed-case skill names case-insensitively and honors repo-root disabledSkills from subdirectories', async () => {
    const { createSkillRegistry } = await import('../src/skills/registry.js')
    const { skillSettingsPath } = await import('../src/skills/settings.js')
    const homeDir = await makeTempDir('xc-case-home-')
    const sandboxSettings = await makeTempDir('xc-case-settings-')
    process.env.X_CODE_HOME = sandboxSettings

    const repoRoot = await makeTempDir('xc-case-repo-')
    await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true })
    const subDir = path.join(repoRoot, 'packages', 'sub')
    await fs.mkdir(subDir, { recursive: true })

    await writeSkill(repoRoot, '.claude', 'PR-Review', 'description: Mixed-case dir skill', 'Body')
    await writeSkill(repoRoot, '.agents', 'muted-at-root', 'name: muted-at-root\ndescription: Disabled at root', 'Body')

    const rootSettings = skillSettingsPath('project', repoRoot)
    await fs.mkdir(path.dirname(rootSettings), { recursive: true })
    await fs.writeFile(rootSettings, JSON.stringify({ disabledSkills: ['muted-at-root'] }), 'utf-8')

    const registry = await createSkillRegistry({ homeDir, cwd: subDir })
    // Router lowercases `/PR-Review` to `pr-review` — case-insensitive lookup must resolve it
    expect(registry.get('pr-review')?.name).toBe('PR-Review')
    expect(registry.get('muted-at-root')).toBeUndefined()
    expect(registry.getEntry('muted-at-root')?.disabled).toBe(true)
  })
})
