// @x-code-cli/core — Plugin startup loader
//
// One-shot orchestration called from the CLI entry. Two passes:
//
//   Pass 1 — user-scope installs from installed_plugins.json. Each
//            record points at a versioned cache dir; we load whichever
//            version the record names. Orphan records (record present but
//            cache dir missing) surface as PluginLoadError.
//
//   Pass 2 — project-local plugins under <cwd>/.x-code/plugins/<name>/.
//            These aren't tracked in installed_plugins.json — they're
//            committed to the repo as in-tree plugins. Marketplace name
//            is always "local" for these.
//
// `installed_plugins.json` is the source of truth for user-scope installs.
// Orphan cache dirs (no record) are silently ignored — they'll be cleaned
// up next time the user runs `/plugin uninstall`.
//
// One broken plugin (bad JSON, missing manifest, schema violation) never
// aborts the boot — errors collect into a `PluginLoadError[]` for
// `/plugin doctor` to surface.
//
// The returned `PluginRegistry` is meant to be frozen for the session
// (same byte-stability constraint as MCP / skills — see CLAUDE.md). The
// CLI calls `loadAllPlugins()` once at startup and stashes the result on
// `AgentOptions`. `/plugin refresh` swaps the in-memory state via
// `registry.reload(...)` and invalidates `systemPromptCache`.
import fs from 'node:fs/promises'
import path from 'node:path'

import { EnableState } from './enable-state.js'
import { listInstalledPlugins } from './installer.js'
import { ManifestParseError, discoverManifest, parseManifest } from './manifest.js'
import { pluginCacheDir, projectPluginsDir } from './paths.js'
import { PluginRegistry } from './registry.js'
import type {
  InlineHookConfig,
  InlineMcpServers,
  LoadedPlugin,
  PluginLoadError,
  PluginManifest,
  PluginScope,
  PluginSource,
} from './types.js'

export interface LoadOptions {
  /** Current working directory. Used to find project-local plugins. */
  cwd: string
  /** Skip plugin loading entirely. Wired to the `--no-plugins` startup
   *  flag. Returns an empty registry. */
  disabled?: boolean
}

export interface LoadResult {
  registry: PluginRegistry
  /** Per-plugin resolved contribution paths. Workflow B (skill / agent /
   *  mcp loader integration) reads from here to merge in plugin-provided
   *  content. Keyed by plugin id. */
  contributions: Map<string, ResolvedContributions>
}

/** A plugin's manifest contributions, with relative paths resolved
 *  against `rootDir`. The `path` / `inline` discriminator on `mcpServers`
 *  and `hooks` reflects the manifest's union — authors can either point
 *  at a file or inline the config. */
export interface ResolvedContributions {
  /** Absolute path to the plugin's skills directory, if any. Each
   *  subdir under here is expected to follow the existing
   *  `<name>/SKILL.md` layout (so the skill loader can scan it
   *  without changes). */
  skillsDir?: string
  /** Absolute path to the plugin's sub-agent .md files dir. */
  agentsDir?: string
  /** Absolute path to the plugin's slash-command .md files dir. */
  commandsDir?: string
  /** mcpServers contribution — either a path to a JSON file shaped like
   *  `{ mcpServers: { ... } }` or the inline record (matches the
   *  ~/.x-code/config.json `mcpServers` shape). */
  mcpServers?: { kind: 'path'; path: string } | { kind: 'inline'; data: InlineMcpServers }
  /** hooks contribution — path to hooks.json or inline object. Schema
   *  validation lives in packages/core/src/hooks (workflow C). */
  hooks?: { kind: 'path'; path: string } | { kind: 'inline'; data: InlineHookConfig }
}

export async function loadAllPlugins(opts: LoadOptions): Promise<LoadResult> {
  if (opts.disabled) {
    return { registry: new PluginRegistry([], []), contributions: new Map() }
  }

  const enableState = await EnableState.load(opts.cwd)
  const plugins: LoadedPlugin[] = []
  const errors: PluginLoadError[] = []
  const contributions = new Map<string, ResolvedContributions>()

  // ── Pass 1: user-scope installs ────────────────────────────────────────
  const installed = await listInstalledPlugins()
  for (const record of installed) {
    const rootDir = pluginCacheDir(record.marketplace, record.name, record.version)
    await loadOnePlugin({
      rootDir,
      fallbackId: record.id,
      marketplace: record.marketplace,
      scope: record.installScope,
      source: record.source,
      enableState,
      plugins,
      errors,
      contributions,
    })
  }

  // ── Pass 2: project-local plugins ──────────────────────────────────────
  const projectRoot = projectPluginsDir(opts.cwd)
  let projectEntries: import('node:fs').Dirent[] = []
  try {
    projectEntries = await fs.readdir(projectRoot, { withFileTypes: true })
  } catch {
    /* no project plugins dir — common case */
  }
  for (const entry of projectEntries) {
    if (!entry.isDirectory()) continue
    const pluginRoot = path.join(projectRoot, entry.name)
    await loadOnePlugin({
      rootDir: pluginRoot,
      // Provisional id from dirname; overridden by manifest.name when we
      // parse it.
      fallbackId: `${entry.name}@local`,
      marketplace: 'local',
      scope: 'project',
      source: undefined,
      enableState,
      plugins,
      errors,
      contributions,
    })
  }

  return { registry: new PluginRegistry(plugins, errors), contributions }
}

interface LoadOneArgs {
  rootDir: string
  fallbackId: string
  marketplace: string
  scope: PluginScope
  source: PluginSource | undefined
  enableState: EnableState
  plugins: LoadedPlugin[]
  errors: PluginLoadError[]
  contributions: Map<string, ResolvedContributions>
}

async function loadOnePlugin(args: LoadOneArgs): Promise<void> {
  try {
    const discovery = await discoverManifest(args.rootDir)
    if (!discovery) {
      args.errors.push({
        id: args.fallbackId,
        path: args.rootDir,
        message:
          'no plugin manifest found (looked for .x-code-plugin/plugin.json, .claude-plugin/plugin.json, plugin.json)',
      })
      return
    }
    if (discovery.format === 'gemini') {
      args.errors.push({
        id: args.fallbackId,
        path: args.rootDir,
        message: 'Gemini extensions are not supported (gemini-extension.json detected); see docs/plugins.md',
      })
      return
    }

    let manifest: PluginManifest
    try {
      manifest = await parseManifest(discovery.manifestPath)
    } catch (err) {
      args.errors.push({
        id: args.fallbackId,
        path: args.rootDir,
        message: err instanceof ManifestParseError ? err.message : String(err),
      })
      return
    }

    // Canonical id always comes from the manifest, never from the cache
    // dir name. For installed plugins this matches the recorded id; for
    // project-local plugins it may differ from the dirname and the
    // manifest wins.
    const id = `${manifest.name}@${args.marketplace}`
    const enableResolution = args.enableState.resolve(id)

    const plugin: LoadedPlugin = {
      id,
      manifest,
      rootDir: args.rootDir,
      manifestPath: discovery.manifestPath,
      manifestFormat: discovery.format,
      source: args.source,
      marketplace: args.marketplace,
      scope: args.scope,
      enabled: enableResolution.enabled,
    }
    args.plugins.push(plugin)
    args.contributions.set(id, await resolveContributions(plugin))
  } catch (err) {
    args.errors.push({
      id: args.fallbackId,
      path: args.rootDir,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Resolve a plugin's manifest contribution fields into absolute paths
 *  (or inline objects). Exported because individual callers occasionally
 *  need to recompute this (e.g. `/plugin info` for a single plugin).
 *
 *  **Two discovery passes per contribution kind:**
 *
 *  1. **Manifest-declared** — if the manifest names a path (e.g.
 *     `"skills": "./my-skills"`), use that.
 *  2. **Convention-based fallback** — if not declared, probe the
 *     conventional directory (`skills/`, `agents/`, `commands/`) and
 *     the conventional file (`hooks/hooks.json`, `.mcp.json`,
 *     `mcp.json`). This is how real Claude Code plugins work — their
 *     manifests typically only carry `name`/`version`/`description` and
 *     drop the contributions next to it.
 *
 *  Async because the convention probe has to stat directories. */
export async function resolveContributions(plugin: LoadedPlugin): Promise<ResolvedContributions> {
  const m = plugin.manifest
  const root = plugin.rootDir
  const result: ResolvedContributions = {}

  // skills / agents / commands — directory contributions
  if (m.skills) {
    result.skillsDir = path.resolve(root, m.skills)
  } else if (await isDir(path.join(root, 'skills'))) {
    result.skillsDir = path.join(root, 'skills')
  }
  if (m.agents) {
    result.agentsDir = path.resolve(root, m.agents)
  } else if (await isDir(path.join(root, 'agents'))) {
    result.agentsDir = path.join(root, 'agents')
  }
  if (m.commands) {
    result.commandsDir = path.resolve(root, m.commands)
  } else if (await isDir(path.join(root, 'commands'))) {
    result.commandsDir = path.join(root, 'commands')
  }

  // mcpServers — either declared (path / inline) or auto-discovered
  // from a conventional file
  if (m.mcpServers !== undefined) {
    if (typeof m.mcpServers === 'string') {
      result.mcpServers = { kind: 'path', path: path.resolve(root, m.mcpServers) }
    } else {
      result.mcpServers = { kind: 'inline', data: m.mcpServers }
    }
  } else {
    // Claude Code convention: `.mcp.json` at plugin root. We also
    // accept `mcp.json` (without dot) as a pragmatic fallback —
    // some authors use the visible form.
    for (const conv of ['.mcp.json', 'mcp.json']) {
      const p = path.join(root, conv)
      if (await isFile(p)) {
        result.mcpServers = { kind: 'path', path: p }
        break
      }
    }
  }

  // hooks — same pattern, conventional file `hooks/hooks.json`
  if (m.hooks !== undefined) {
    if (typeof m.hooks === 'string') {
      result.hooks = { kind: 'path', path: path.resolve(root, m.hooks) }
    } else {
      result.hooks = { kind: 'inline', data: m.hooks }
    }
  } else {
    const conv = path.join(root, 'hooks', 'hooks.json')
    if (await isFile(conv)) {
      result.hooks = { kind: 'path', path: conv }
    }
  }

  return result
}

async function isDir(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p)
    return s.isFile()
  } catch {
    return false
  }
}
