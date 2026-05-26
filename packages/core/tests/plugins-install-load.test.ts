// Tests for installer (local source path) + loader integration
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  InstallError,
  findInstalledPlugin,
  installPlugin,
  listInstalledPlugins,
  uninstallPlugin,
} from '../src/plugins/installer.js'
import { loadAllPlugins, resolveContributions } from '../src/plugins/loader.js'
import { pluginCacheDir } from '../src/plugins/paths.js'

let originalPluginsDir: string | undefined

async function makeTempPlugin(body: Record<string, unknown>, rel = 'plugin.json'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-src-'))
  const file = path.join(root, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(body, null, 2), 'utf-8')
  return root
}

beforeEach(async () => {
  originalPluginsDir = process.env.XC_PLUGINS_DIR
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugins-cache-test-'))
  process.env.XC_PLUGINS_DIR = tmp
})

afterEach(() => {
  if (originalPluginsDir === undefined) delete process.env.XC_PLUGINS_DIR
  else process.env.XC_PLUGINS_DIR = originalPluginsDir
})

// ── installer ──────────────────────────────────────────────────────────

describe('installPlugin (local source)', () => {
  it('copies a local plugin into the cache + records it', async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0', description: 'd' })

    const result = await installPlugin({
      source: { kind: 'local', path: src },
      marketplace: 'local',
    })

    expect(result.pluginId).toBe('demo@local')
    expect(result.manifest.name).toBe('demo')
    expect(result.rootDir).toBe(pluginCacheDir('local', 'demo', '1.0.0'))

    // Cached manifest should be present
    expect(
      await fs
        .access(path.join(result.rootDir, 'plugin.json'))
        .then(() => true)
        .catch(() => false),
    ).toBe(true)

    // Record landed
    const installed = await listInstalledPlugins()
    expect(installed).toHaveLength(1)
    expect(installed[0]!.id).toBe('demo@local')
    expect(installed[0]!.version).toBe('1.0.0')
  })

  it('rejects a Gemini-only source with a friendly error', async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' }, 'gemini-extension.json')

    await expect(installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })).rejects.toThrow(
      /Gemini extension/,
    )
  })

  it('rejects a source with no manifest', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-empty-'))
    await expect(installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })).rejects.toBeInstanceOf(
      InstallError,
    )
  })

  it('enforces expectedName when set', async () => {
    const src = await makeTempPlugin({ name: 'actually-this', version: '1.0.0' })
    await expect(
      installPlugin({
        source: { kind: 'local', path: src },
        marketplace: 'local',
        expectedName: 'something-else',
      }),
    ).rejects.toThrow(/does not match/)
  })

  it('re-installs over an existing same-version install (wipes first)', async () => {
    const src1 = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src1 }, marketplace: 'local' })

    // Stash a marker file in the cache dir
    const dir = pluginCacheDir('local', 'demo', '1.0.0')
    await fs.writeFile(path.join(dir, 'stale.txt'), 'should not survive')

    const src2 = await makeTempPlugin({ name: 'demo', version: '1.0.0', description: 'updated' })
    await installPlugin({ source: { kind: 'local', path: src2 }, marketplace: 'local' })

    // Stale file should be gone after the wipe-and-replace
    const staleExists = await fs
      .access(path.join(dir, 'stale.txt'))
      .then(() => true)
      .catch(() => false)
    expect(staleExists).toBe(false)
  })

  it('also copies non-manifest files (skills/, agents/, etc.) into the cache', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-rich-'))
    await fs.writeFile(
      path.join(src, 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', skills: './skills' }),
    )
    await fs.mkdir(path.join(src, 'skills', 'foo'), { recursive: true })
    await fs.writeFile(path.join(src, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\ndescription: d\n---\n')

    const result = await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })
    const skillFile = path.join(result.rootDir, 'skills', 'foo', 'SKILL.md')
    expect(
      await fs
        .access(skillFile)
        .then(() => true)
        .catch(() => false),
    ).toBe(true)
  })
})

describe('install policy gates (strictKnownMarketplaces + blockedPlugins)', () => {
  // These two known_marketplaces.json fields exist to give admins
  // enforceable control over what gets installed. Both used to be
  // parsed but never checked — these tests pin the new enforcement.

  it('strictKnownMarketplaces rejects installs from a non-subscribed marketplace', async () => {
    const file = path.join(process.env.XC_PLUGINS_DIR!, 'known_marketplaces.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ marketplaces: [], strictKnownMarketplaces: true }))

    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await expect(installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })).rejects.toThrow(
      /strict marketplace mode/,
    )
  })

  it('strictKnownMarketplaces accepts installs whose marketplace IS subscribed', async () => {
    const file = path.join(process.env.XC_PLUGINS_DIR!, 'known_marketplaces.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({
        marketplaces: [{ name: 'official', source: 'github:foo/official' }],
        strictKnownMarketplaces: true,
      }),
    )

    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    const result = await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'official' })
    expect(result.pluginId).toBe('demo@official')
  })

  it('blockedPlugins rejects matching id regardless of marketplace / consent', async () => {
    const file = path.join(process.env.XC_PLUGINS_DIR!, 'known_marketplaces.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ marketplaces: [], blockedPlugins: ['demo@local'] }))

    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await expect(installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })).rejects.toThrow(
      /blockedPlugins/,
    )
  })

  it('blockedPlugins also matches bare plugin name (block-everywhere shortcut)', async () => {
    // Admins reasonably expect `blockedPlugins: ['demo']` to block
    // every marketplace's "demo" plugin in one shot, npm-ignore style.
    // The fully-qualified form is still accepted for precision.
    const file = path.join(process.env.XC_PLUGINS_DIR!, 'known_marketplaces.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ marketplaces: [], blockedPlugins: ['demo'] }))

    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await expect(
      installPlugin({ source: { kind: 'local', path: src }, marketplace: 'some-other-marketplace' }),
    ).rejects.toThrow(/blockedPlugins/)
  })

  it('blockedPlugins does not match a different plugin sharing a prefix', async () => {
    // Make sure the bare-name match is strict equality, not substring —
    // blocking "demo" should not block "demo-extra".
    const file = path.join(process.env.XC_PLUGINS_DIR!, 'known_marketplaces.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ marketplaces: [], blockedPlugins: ['demo'] }))

    const src = await makeTempPlugin({ name: 'demo-extra', version: '1.0.0' })
    const result = await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })
    expect(result.pluginId).toBe('demo-extra@local')
  })
})

describe('uninstallPlugin', () => {
  it('removes cache + record + returns the version it cleaned up', async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const result = await uninstallPlugin('demo@local')
    expect(result.removedRecord).toBe(true)
    expect(result.removedVersions).toEqual(['1.0.0'])

    expect(await findInstalledPlugin('demo@local')).toBeUndefined()
  })

  it('is a no-op for an unknown plugin', async () => {
    const result = await uninstallPlugin('ghost@local')
    expect(result).toEqual({ removedRecord: false, removedVersions: [] })
  })
})

// ── loader ─────────────────────────────────────────────────────────────

describe('loadAllPlugins', () => {
  it('returns empty registry when disabled', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-loader-cwd-'))
    const result = await loadAllPlugins({ cwd, disabled: true })
    expect(result.registry.list()).toEqual([])
    expect(result.contributions.size).toBe(0)
  })

  it('loads user-scope installed plugins from installed_plugins.json', async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0', skills: './skills' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-loader-cwd-'))
    const result = await loadAllPlugins({ cwd })

    const list = result.registry.listAll()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('demo@local')
    expect(list[0]!.enabled).toBe(true) // default-enable

    const contrib = result.contributions.get('demo@local')
    expect(contrib?.skillsDir).toBe(path.resolve(list[0]!.rootDir, './skills'))
  })

  it('loads project-local plugins from <cwd>/.x-code/plugins/<name>/', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-loader-cwd-'))
    const pluginDir = path.join(cwd, '.x-code', 'plugins', 'inhouse')
    await fs.mkdir(pluginDir, { recursive: true })
    await fs.writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'inhouse', version: '0.1.0' }))

    const result = await loadAllPlugins({ cwd })
    const list = result.registry.listAll()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('inhouse@local')
    expect(list[0]!.scope).toBe('project')
  })

  it('records load errors for broken manifests without aborting', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-loader-cwd-'))
    const broken = path.join(cwd, '.x-code', 'plugins', 'broken')
    await fs.mkdir(broken, { recursive: true })
    await fs.writeFile(path.join(broken, 'plugin.json'), '{ not json', 'utf-8')

    const good = path.join(cwd, '.x-code', 'plugins', 'good')
    await fs.mkdir(good, { recursive: true })
    await fs.writeFile(path.join(good, 'plugin.json'), JSON.stringify({ name: 'good', version: '1.0.0' }))

    const result = await loadAllPlugins({ cwd })
    expect(result.registry.listAll()).toHaveLength(1)
    expect(result.registry.listAll()[0]!.id).toBe('good@local')
    expect(result.registry.loadErrors()).toHaveLength(1)
    expect(result.registry.loadErrors()[0]!.path).toBe(broken)
  })

  it('records a Gemini-extension load error without crashing', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-loader-cwd-'))
    const gemini = path.join(cwd, '.x-code', 'plugins', 'gemini-plugin')
    await fs.mkdir(gemini, { recursive: true })
    await fs.writeFile(
      path.join(gemini, 'gemini-extension.json'),
      JSON.stringify({ name: 'gemini-plugin', version: '1.0.0' }),
    )

    const result = await loadAllPlugins({ cwd })
    expect(result.registry.listAll()).toHaveLength(0)
    expect(result.registry.loadErrors()).toHaveLength(1)
    expect(result.registry.loadErrors()[0]!.message).toMatch(/Gemini/)
  })

  it('respects enable flags from <cwd>/.x-code/settings.local.json', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-loader-cwd-'))
    const pluginDir = path.join(cwd, '.x-code', 'plugins', 'disabled-one')
    await fs.mkdir(pluginDir, { recursive: true })
    await fs.writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'disabled-one', version: '1.0.0' }))

    await fs.writeFile(
      path.join(cwd, '.x-code', 'settings.local.json'),
      JSON.stringify({ enabledPlugins: { 'disabled-one@local': false } }),
    )

    const result = await loadAllPlugins({ cwd })
    const list = result.registry.listAll()
    expect(list).toHaveLength(1)
    expect(list[0]!.enabled).toBe(false)
    expect(result.registry.list()).toHaveLength(0) // hidden by .list() filter
  })
})

describe('resolveContributions', () => {
  it('resolves manifest-declared paths against rootDir', async () => {
    const plugin = {
      id: 'demo@local',
      manifest: {
        schemaVersion: '1',
        name: 'demo',
        version: '1.0.0',
        skills: './skills',
        agents: './agents',
        mcpServers: './mcp.json',
      },
      rootDir: '/abs/root',
      manifestPath: '/abs/root/plugin.json',
      manifestFormat: 'bare' as const,
      source: undefined,
      marketplace: 'local',
      scope: 'project' as const,
      enabled: true,
    }
    const c = await resolveContributions(plugin)
    expect(c.skillsDir).toBe(path.resolve('/abs/root', './skills'))
    expect(c.agentsDir).toBe(path.resolve('/abs/root', './agents'))
    expect(c.mcpServers).toEqual({ kind: 'path', path: path.resolve('/abs/root', './mcp.json') })
  })

  it('auto-discovers commands/ agents/ skills/ when manifest omits them (Claude Code convention)', async () => {
    // Build a real on-disk plugin so the convention-based fs.stat
    // probes have something to find.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-resolve-conv-'))
    await fs.writeFile(path.join(root, 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }))
    await fs.mkdir(path.join(root, 'commands'), { recursive: true })
    await fs.mkdir(path.join(root, 'agents'), { recursive: true })
    await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: {} }))

    const plugin = {
      id: 'demo@local',
      manifest: { schemaVersion: '1', name: 'demo', version: '1.0.0' },
      rootDir: root,
      manifestPath: path.join(root, 'plugin.json'),
      manifestFormat: 'bare' as const,
      source: undefined,
      marketplace: 'local',
      scope: 'project' as const,
      enabled: true,
    }
    const c = await resolveContributions(plugin)
    expect(c.commandsDir).toBe(path.join(root, 'commands'))
    expect(c.agentsDir).toBe(path.join(root, 'agents'))
    expect(c.skillsDir).toBeUndefined() // no skills/ dir → undefined
    expect(c.mcpServers).toEqual({ kind: 'path', path: path.join(root, '.mcp.json') })
  })
})

// ── userConfig install-time prompt ─────────────────────────────────────

describe('installPlugin (userConfig prompt)', () => {
  it('passes manifest userConfig fields to the callback and persists the returned values', async () => {
    const { getPluginUserConfig } = await import('../src/plugins/user-config.js')
    const src = await makeTempPlugin({
      name: 'cfg-demo',
      version: '1.0.0',
      userConfig: [
        { key: 'API_KEY', type: 'string', sensitive: true, prompt: 'Enter the key' },
        { key: 'BASE_URL', type: 'string', default: 'https://api.example.com' },
      ],
    })

    let receivedFields: unknown
    const result = await installPlugin({
      source: { kind: 'local', path: src },
      marketplace: 'local',
      userConfigPrompt: async (fields) => {
        receivedFields = fields
        return { API_KEY: 'sk-test', BASE_URL: 'https://override' }
      },
    })

    // Callback saw both fields verbatim.
    expect(Array.isArray(receivedFields)).toBe(true)
    expect((receivedFields as Array<{ key: string }>).map((f) => f.key)).toEqual(['API_KEY', 'BASE_URL'])

    // Persisted to user-config.json under the plugin id.
    const stored = await getPluginUserConfig(result.pluginId)
    expect(stored).toEqual({ API_KEY: 'sk-test', BASE_URL: 'https://override' })
  })

  it('aborts the install when the userConfig prompt returns null', async () => {
    const src = await makeTempPlugin({
      name: 'aborted',
      version: '1.0.0',
      userConfig: [{ key: 'TOKEN', type: 'string', required: true }],
    })

    await expect(
      installPlugin({
        source: { kind: 'local', path: src },
        marketplace: 'local',
        userConfigPrompt: async () => null,
      }),
    ).rejects.toThrow(/userConfig/)

    // No cache entry created (aborted before move).
    const installed = await listInstalledPlugins()
    expect(installed).toHaveLength(0)
  })

  it('skips the prompt entirely when manifest declares no userConfig', async () => {
    const src = await makeTempPlugin({ name: 'no-cfg', version: '1.0.0' })
    let calls = 0
    await installPlugin({
      source: { kind: 'local', path: src },
      marketplace: 'local',
      userConfigPrompt: async () => {
        calls++
        return {}
      },
    })
    expect(calls).toBe(0)
  })
})

// ── /plugin refresh hot reload ─────────────────────────────────────────

describe('refreshPluginContributions', () => {
  it('detects an added plugin between two scans and folds it into the skill registry', async () => {
    const { refreshPluginContributions } = await import('../src/plugins/refresh.js')
    const { createSkillRegistry } = await import('../src/skills/registry.js')

    // Install one plugin with a skill, build registries from that snapshot.
    const src1 = await makeTempPlugin({ name: 'p1', version: '1.0.0' })
    // Add a skill dir so resolveContributions auto-detects it.
    await fs.mkdir(path.join(src1, 'skills', 'hello'), { recursive: true })
    await fs.writeFile(
      path.join(src1, 'skills', 'hello', 'SKILL.md'),
      '---\nname: hello\ndescription: greet\n---\nBody',
      'utf-8',
    )
    await installPlugin({ source: { kind: 'local', path: src1 }, marketplace: 'local' })

    const initialLoad = await loadAllPlugins({ cwd: process.cwd() })
    const { buildPluginIntegration } = await import('../src/plugins/integration.js')
    const initialIntegration = await buildPluginIntegration(initialLoad)
    const skillRegistry = await createSkillRegistry({ extraDirs: initialIntegration.skillsDirs })
    expect(skillRegistry.get('hello')).toBeDefined()

    // Install a second plugin AFTER initial load. The new skill should
    // NOT show up until /plugin refresh runs.
    const src2 = await makeTempPlugin({ name: 'p2', version: '1.0.0' })
    await fs.mkdir(path.join(src2, 'skills', 'world'), { recursive: true })
    await fs.writeFile(
      path.join(src2, 'skills', 'world', 'SKILL.md'),
      '---\nname: world\ndescription: w\n---\nBody',
      'utf-8',
    )
    await installPlugin({ source: { kind: 'local', path: src2 }, marketplace: 'local' })
    expect(skillRegistry.get('world')).toBeUndefined()

    // Refresh: rebuilds plugin registry and folds new skills in.
    const summary = await refreshPluginContributions({
      pluginRegistry: initialLoad.registry,
      skillRegistry,
    })
    expect(summary.plugins.added).toContain('p2@local')
    expect(skillRegistry.get('world')).toBeDefined()
    // Existing plugin still loaded.
    expect(skillRegistry.get('hello')).toBeDefined()
  })

  it('restarts MCP servers when an mcpRegistry is wired (plugin install + refresh in one shot)', async () => {
    const { refreshPluginContributions } = await import('../src/plugins/refresh.js')
    const { McpRegistry } = await import('../src/mcp/registry.js')

    // Install a plugin that declares an inline mcpServer. We use an
    // unreachable stdio command so the server fails to connect — that's
    // fine because we only need to verify that restartAll was called with
    // the plugin's server in the merged map.
    const src = await makeTempPlugin({
      name: 'mcp-bringing-plugin',
      version: '1.0.0',
      mcpServers: {
        'plugin-mcp': { command: 'node', args: ['-e', 'process.exit(0)'] },
      },
    })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const initialLoad = await loadAllPlugins({ cwd: process.cwd() })
    // Build a stub McpRegistry whose restartAll just records what it saw,
    // so the test doesn't depend on real MCP child processes spawning.
    const seenConfigs: Array<Map<string, unknown>> = []
    const stub = Object.create(McpRegistry.prototype)
    stub.restartAll = async (configs: Map<string, unknown>) => {
      seenConfigs.push(configs)
      return { added: [...configs.keys()], removed: [], changed: [], unchanged: [] }
    }

    const summary = await refreshPluginContributions({
      pluginRegistry: initialLoad.registry,
      mcpRegistry: stub,
      // askUser never actually fires because the test has no project-level
      // MCP config to trust. Provide a stub that throws if invoked.
      askUser: async () => {
        throw new Error('askUser should not be invoked when project mcpServers is empty')
      },
    })

    expect(seenConfigs.length).toBe(1)
    expect(seenConfigs[0]!.has('plugin-mcp')).toBe(true)
    expect(summary.mcp).toBeDefined()
    expect(summary.mcp!.added).toContain('plugin-mcp')
  })

  it('skips MCP restart when mcpRegistry is omitted (backwards-compatible default)', async () => {
    const { refreshPluginContributions } = await import('../src/plugins/refresh.js')

    const src = await makeTempPlugin({ name: 'no-mcp-pass', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const initialLoad = await loadAllPlugins({ cwd: process.cwd() })
    const summary = await refreshPluginContributions({
      pluginRegistry: initialLoad.registry,
    })
    expect(summary.mcp).toBeUndefined()
  })
})

/** Spin up a local git repo with one commit and return both its path
 *  (usable as a `kind: 'git'` source URL — `git clone /path` works) and
 *  the resulting HEAD sha. Lets us test sha verification without needing
 *  network or a real GitHub repo. */
async function makeLocalGitRepo(manifest: Record<string, unknown>): Promise<{ url: string; sha: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-git-src-'))
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: root })
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  await execa('git', ['config', 'user.name', 'test'], { cwd: root })
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: root })
  await fs.writeFile(path.join(root, 'plugin.json'), JSON.stringify(manifest))
  await execa('git', ['add', '-A'], { cwd: root })
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: root })
  const sha = (await execa('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  return { url: root, sha }
}

describe('install sha integrity check (marketplace.json `sha` field)', () => {
  it('accepts an install when the declared sha matches the cloned HEAD', async () => {
    const { url, sha } = await makeLocalGitRepo({ name: 'demo', version: '1.0.0' })
    const result = await installPlugin({
      source: { kind: 'git', url, expectedSha: sha },
      marketplace: 'local',
    })
    expect(result.pluginId).toBe('demo@local')
  })

  it('rejects an install when the declared sha does not match', async () => {
    const { url } = await makeLocalGitRepo({ name: 'demo', version: '1.0.0' })
    const fakeSha = '0000000000000000000000000000000000000000'
    await expect(
      installPlugin({
        source: { kind: 'git', url, expectedSha: fakeSha },
        marketplace: 'local',
      }),
    ).rejects.toThrow(/sha integrity check failed/)
  })

  it('skips the check entirely when no sha is declared (back-compat with sha-less marketplaces)', async () => {
    const { url } = await makeLocalGitRepo({ name: 'demo', version: '1.0.0' })
    const result = await installPlugin({
      source: { kind: 'git', url }, // no expectedSha
      marketplace: 'local',
    })
    expect(result.pluginId).toBe('demo@local')
  })

  it('accepts a short (≥7 char) sha that prefix-matches the full HEAD — same tolerance as `git checkout <short>`', async () => {
    const { url, sha } = await makeLocalGitRepo({ name: 'demo', version: '1.0.0' })
    const shortSha = sha.slice(0, 7)
    const result = await installPlugin({
      source: { kind: 'git', url, expectedSha: shortSha },
      marketplace: 'local',
    })
    expect(result.pluginId).toBe('demo@local')
  })
})
