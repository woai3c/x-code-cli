import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createSkillRegistry } from '@x-code-cli/core'
import type { AgentOptions, SkillDefinition } from '@x-code-cli/core'

import { createSkillCommandHandler } from '../src/ui/app/commands/skill.js'

describe('/skill command handler', () => {
  const tempDirs: string[] = []
  let originalXcodeHome: string | undefined

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }

  beforeEach(() => {
    originalXcodeHome = process.env.X_CODE_HOME
    delete process.env.X_CODE_HOME
    delete process.env.XC_SKILLS_DIR
  })

  afterEach(async () => {
    if (originalXcodeHome === undefined) delete process.env.X_CODE_HOME
    else process.env.X_CODE_HOME = originalXcodeHome
    for (const d of tempDirs.splice(0)) {
      await fs.rm(d, { recursive: true, force: true })
    }
  })

  it('lists skills with provenance labels (.agents, .claude, .x-code, plugin)', async () => {
    const homeDir = await makeTempDir('xc-cli-skill-home-')
    const repoDir = await makeTempDir('xc-cli-skill-repo-')

    const agentsDir = path.join(repoDir, '.agents', 'skills', 'team-review')
    await fs.mkdir(agentsDir, { recursive: true })
    await fs.writeFile(
      path.join(agentsDir, 'SKILL.md'),
      '---\nname: team-review\ndescription: Team review workflow\n---\nBody',
      'utf-8',
    )

    const claudeDir = path.join(homeDir, '.claude', 'skills', 'claude-helper')
    await fs.mkdir(claudeDir, { recursive: true })
    await fs.writeFile(
      path.join(claudeDir, 'SKILL.md'),
      '---\nname: claude-helper\ndescription: Claude helper skill\n---\nBody',
      'utf-8',
    )

    const skillRegistry = await createSkillRegistry({ homeDir, cwd: repoDir })
    const messages: string[] = []
    const { handleSkill } = createSkillCommandHandler({
      options: { skillRegistry } as AgentOptions,
      addCommandMessage: (_text, content) => messages.push(content),
      invalidateSystemPromptCache: vi.fn(),
      pendingSkillRef: { current: null },
      bumpSkillRegistryVersion: vi.fn(),
    })

    await handleSkill('/skill list', 'list')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('**team-review** (project · .agents): Team review workflow')
    expect(messages[0]).toContain('**claude-helper** (user · ~/.claude): Claude helper skill')
  })

  it('protects .claude skills as read-only during /skill uninstall while allowing .agents uninstall', async () => {
    const homeDir = await makeTempDir('xc-cli-uninst-home-')
    const repoDir = await makeTempDir('xc-cli-uninst-repo-')
    // Redirect X_CODE_HOME only after registry creation? Better: isolate settings writes via X_CODE_HOME + explicit homeDir
    const sandboxSettingsHome = await makeTempDir('xc-cli-settings-home-')
    process.env.X_CODE_HOME = sandboxSettingsHome

    const claudeSkillDir = path.join(repoDir, '.claude', 'skills', 'claude-skill')
    await fs.mkdir(claudeSkillDir, { recursive: true })
    await fs.writeFile(
      path.join(claudeSkillDir, 'SKILL.md'),
      '---\nname: claude-skill\ndescription: Read-only compat skill\n---\nBody',
      'utf-8',
    )

    const agentsSkillDir = path.join(repoDir, '.agents', 'skills', 'agents-skill')
    await fs.mkdir(agentsSkillDir, { recursive: true })
    await fs.writeFile(
      path.join(agentsSkillDir, 'SKILL.md'),
      '---\nname: agents-skill\ndescription: Removable standard skill\n---\nBody',
      'utf-8',
    )

    const skillRegistry = await createSkillRegistry({ homeDir, cwd: repoDir })
    const messages: string[] = []
    const pendingSkillRef: { current: SkillDefinition | null } = { current: null }
    const { handleSkill } = createSkillCommandHandler({
      options: { skillRegistry } as AgentOptions,
      addCommandMessage: (_text, content) => messages.push(content),
      invalidateSystemPromptCache: vi.fn(),
      pendingSkillRef,
      bumpSkillRegistryVersion: vi.fn(),
    })

    // 1. Attempting to uninstall a .claude skill must NOT delete the directory
    await handleSkill('/skill uninstall claude-skill', 'uninstall claude-skill')
    expect(messages.at(-1)).toContain('read-only')
    expect(messages.at(-1)).toContain('/skill disable claude-skill')
    await expect(fs.access(path.join(claudeSkillDir, 'SKILL.md'))).resolves.toBeUndefined()

    // 2. Uninstalling a .agents skill removes its exact directory
    await handleSkill('/skill uninstall agents-skill', 'uninstall agents-skill')
    expect(messages.at(-1)).toContain('Uninstalled skill **agents-skill**')
    await expect(fs.access(agentsSkillDir)).rejects.toThrow()
  })

  it('installs fetched skills into userSkillsDir() and rejects path-traversal names', async () => {
    const sandboxHome = await makeTempDir('xc-cli-install-home-')
    process.env.X_CODE_HOME = sandboxHome

    let payload = '---\nname: fetched-skill\ndescription: Installed over HTTP\n---\nFollow steps.'
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(payload)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as { port: number }
    const url = `http://127.0.0.1:${addr.port}/SKILL.md`

    try {
      const messages: string[] = []
      const { handleSkill } = createSkillCommandHandler({
        options: {} as AgentOptions,
        addCommandMessage: (_text, content) => messages.push(content),
        invalidateSystemPromptCache: vi.fn(),
        pendingSkillRef: { current: null },
        bumpSkillRegistryVersion: vi.fn(),
      })

      await handleSkill(`/skill install ${url}`, `install ${url}`)
      const expectedFile = path.join(sandboxHome, 'skills', 'fetched-skill', 'SKILL.md')
      expect(messages.at(-1)).toContain(expectedFile)
      await expect(fs.readFile(expectedFile, 'utf-8')).resolves.toContain('Installed over HTTP')

      // Unsafe traversal name is rejected before touching disk
      payload = '---\nname: ../escape\ndescription: Bad\n---\nBad'
      await handleSkill(`/skill install ${url}`, `install ${url}`)
      expect(messages.at(-1)).toContain('unsafe skill name')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('unlinks symlinked .agents skill without deleting target directory contents and canonicalizes case on disable', async () => {
    const homeDir = await makeTempDir('xc-cli-link-home-')
    const repoDir = await makeTempDir('xc-cli-link-repo-')
    const sandboxSettings = await makeTempDir('xc-cli-link-settings-')
    process.env.X_CODE_HOME = sandboxSettings

    const externalTarget = path.join(repoDir, 'shared-store', 'MixedCase')
    await fs.mkdir(externalTarget, { recursive: true })
    await fs.writeFile(path.join(externalTarget, 'SKILL.md'), '---\ndescription: Shared skill\n---\nBody', 'utf-8')

    const agentsRoot = path.join(repoDir, '.agents', 'skills')
    await fs.mkdir(agentsRoot, { recursive: true })
    const linkPath = path.join(agentsRoot, 'MixedCase')
    await fs.symlink(externalTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir')

    const skillRegistry = await createSkillRegistry({ homeDir, cwd: repoDir })
    const messages: string[] = []
    const { handleSkill } = createSkillCommandHandler({
      options: { skillRegistry } as AgentOptions,
      addCommandMessage: (_text, content) => messages.push(content),
      invalidateSystemPromptCache: vi.fn(),
      pendingSkillRef: { current: null },
      bumpSkillRegistryVersion: vi.fn(),
    })

    // Case-insensitive disable records canonical `MixedCase`
    await handleSkill('/skill disable mixedcase --scope=project', 'disable mixedcase --scope=project')
    expect(messages.at(-1)).toContain('Disabled skill **MixedCase**')

    // Uninstalling symlink removes only the link, preserving externalTarget/SKILL.md
    await handleSkill('/skill uninstall mixedcase', 'uninstall mixedcase')
    await expect(fs.lstat(linkPath)).rejects.toThrow()
    await expect(fs.access(path.join(externalTarget, 'SKILL.md'))).resolves.toBeUndefined()
  })
})
