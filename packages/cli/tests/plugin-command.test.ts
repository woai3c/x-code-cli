import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { PluginRegistry, createBuiltInRegistry, createCommandRegistry, createSkillRegistry } from '@x-code-cli/core'
import type { AgentOptions } from '@x-code-cli/core'

import { createPluginCommandHandler } from '../src/ui/app/commands/plugin.js'

describe('/plugin command handler', () => {
  const tempDirs: string[] = []
  let originalXcodeHome: string | undefined
  let originalCwd: string

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }

  beforeEach(async () => {
    originalXcodeHome = process.env.X_CODE_HOME
    originalCwd = process.cwd()
    delete process.env.XC_PLUGINS_DIR
    const home = await makeTempDir('xc-plugin-cmd-home-')
    const repo = await makeTempDir('xc-plugin-cmd-repo-')
    process.env.X_CODE_HOME = home
    process.chdir(repo)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    if (originalXcodeHome === undefined) delete process.env.X_CODE_HOME
    else process.env.X_CODE_HOME = originalXcodeHome
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('installs a local plugin, refreshes live registries, toggles --scope enablement, and uninstalls cleanly', async () => {
    const pluginSrc = await makeTempDir('xc-local-plugin-src-')
    await fs.mkdir(path.join(pluginSrc, '.x-code-plugin'), { recursive: true })
    await fs.writeFile(
      path.join(pluginSrc, '.x-code-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'demo-pack',
        version: '1.2.0',
        description: 'Demo workflow pack',
      }),
      'utf-8',
    )
    await fs.mkdir(path.join(pluginSrc, 'commands'), { recursive: true })
    await fs.writeFile(
      path.join(pluginSrc, 'commands', 'ship.md'),
      '---\ndescription: Ship release\n---\nRun ship checks.',
      'utf-8',
    )

    const pluginRegistry = new PluginRegistry([], [])
    const skillRegistry = await createSkillRegistry({ homeDir: process.env.X_CODE_HOME!, cwd: process.cwd() })
    const subAgentRegistry = createBuiltInRegistry()
    const commandRegistry = await createCommandRegistry()

    const messages: string[] = []
    const invalidateSystemPromptCache = vi.fn()
    const bumpSkillRegistryVersion = vi.fn()

    const { handlePlugin } = createPluginCommandHandler({
      options: {
        pluginRegistry,
        skillRegistry,
        subAgentRegistry,
        commandRegistry,
      } as unknown as AgentOptions,
      addCommandMessage: (_text, content) => messages.push(content),
      askQuestion: vi.fn(async () => 'Trust'),
      invalidateSystemPromptCache,
      bumpSkillRegistryVersion,
    })

    // 1. Install local plugin and refresh active session registries
    await handlePlugin(`/plugin install ${pluginSrc}`, `install ${pluginSrc}`)
    expect(messages.at(-1)).toContain('Installed **demo-pack@local** v1.2.0')

    await handlePlugin('/plugin refresh', 'refresh')
    await vi.waitFor(() => expect(messages.at(-1)).toContain('Reloaded plugins — added: demo-pack@local.'))
    expect(invalidateSystemPromptCache).toHaveBeenCalledTimes(1)
    expect(bumpSkillRegistryVersion).toHaveBeenCalledTimes(1)
    expect(commandRegistry.get('ship')?.description).toBe('Ship release')

    // 2. Inspect via /plugin list and /plugin info
    await handlePlugin('/plugin list --enabled', 'list --enabled')
    expect(messages.at(-1)).toContain('[on]  demo-pack@local')
    expect(messages.at(-1)).toContain('v1.2.0')

    await handlePlugin('/plugin info demo-pack@local', 'info demo-pack@local')
    expect(messages.at(-1)).toContain('**demo-pack@local** v1.2.0')
    expect(messages.at(-1)).toContain('- commands:')

    // 3. Scope-aware disable & enable (--scope=project and -s=user)
    await handlePlugin('/plugin disable demo-pack@local --scope=project', 'disable demo-pack@local --scope=project')
    expect(messages.at(-1)).toContain('Plugin **demo-pack@local** disabled in project scope.')

    await handlePlugin('/plugin refresh', 'refresh')
    await vi.waitFor(() => expect(pluginRegistry.getEntry('demo-pack@local')?.enabled).toBe(false))
    await handlePlugin('/plugin list --disabled', 'list --disabled')
    expect(messages.at(-1)).toContain('[off] demo-pack@local')

    await handlePlugin('/plugin enable -s=project demo-pack@local', 'enable -s=project demo-pack@local')
    expect(messages.at(-1)).toContain('Plugin **demo-pack@local** enabled in project scope.')

    // 4. Uninstall removes cached versions
    await handlePlugin('/plugin uninstall demo-pack@local', 'uninstall demo-pack@local')
    expect(messages.at(-1)).toContain('Uninstalled **demo-pack@local** (removed 1 cached version).')
  })

  it('subscribes to a marketplace, searches cached indexes case-insensitively, and reports plugin doctor diagnostics', async () => {
    const pluginRegistry = new PluginRegistry(
      [],
      [{ id: 'broken@local', path: '/tmp/broken/plugin.json', message: 'Invalid manifest version' }],
    )
    const messages: string[] = []
    const { handlePlugin } = createPluginCommandHandler({
      options: { pluginRegistry } as unknown as AgentOptions,
      addCommandMessage: (_text, content) => messages.push(content),
      askQuestion: vi.fn(async () => 'Cancel'),
      invalidateSystemPromptCache: vi.fn(),
      bumpSkillRegistryVersion: vi.fn(),
    })

    await handlePlugin(
      '/plugin marketplace add community github:example/plugins',
      'marketplace add community github:example/plugins',
    )
    expect(messages.at(-1)).toContain('Subscribed to **community**')

    const mpDir = path.join(process.env.X_CODE_HOME!, 'plugins', 'marketplaces', 'community')
    await fs.mkdir(mpDir, { recursive: true })
    await fs.writeFile(
      path.join(mpDir, 'marketplace.json'),
      JSON.stringify({
        schemaVersion: '1',
        name: 'community',
        plugins: [
          {
            name: 'pr-reviewer',
            description: 'Automated pull request reviews',
            keywords: ['Quality', 'Security'],
            verified: true,
            source: { kind: 'github', owner: 'example', repo: 'pr-reviewer' },
          },
          {
            name: 'formatter',
            description: 'Code style helper',
            source: { kind: 'github', owner: 'example', repo: 'formatter' },
          },
        ],
      }),
      'utf-8',
    )

    await handlePlugin('/plugin search SECURITY', 'search SECURITY')
    expect(messages.at(-1)).toContain('Found 1 match:')
    expect(messages.at(-1)).toContain('pr-reviewer@community [verified]')
    expect(messages.at(-1)).toContain('Automated pull request reviews')
    expect(messages.at(-1)).not.toContain('formatter')

    await handlePlugin('/plugin doctor', 'doctor')
    expect(messages.at(-1)).toContain('- Load errors:  1')
    expect(messages.at(-1)).toContain('broken@local at `/tmp/broken/plugin.json`')
    expect(messages.at(-1)).toContain('Invalid manifest version')
  })
})
