// @x-code-cli/core — Install-time consent preview
//
// Before a plugin's contents are committed to the cache, the installer
// builds a `ConsentPreview` summarising what the plugin will contribute
// (hooks, MCP servers, scopes etc.) and hands it to the caller-supplied
// consent callback. If the callback returns false, the install aborts
// and the temp dir is cleaned up.
//
// The preview is built from the already-parsed manifest, so all the
// validation work has already happened — by the time we ask the user
// "do you accept?" we know the plugin parses cleanly and what it will
// touch on their system.
//
// What it intentionally does NOT include:
//
//   - Skill / agent / command counts (they're hidden inside subdirs;
//     scanning them just to build a preview would slow every install,
//     and the preview is meant to be a glance, not an audit).
//   - LICENSE file contents — surfaced as a name only; readers should
//     follow the homepage / source URL to read the actual terms.
//
// What it DOES include — the things with real security blast radius:
// hooks (arbitrary shell), MCP servers (arbitrary subprocesses), and
// source (so the user knows whether it came from a trusted marketplace
// or a random GitHub repo).
import fs from 'node:fs/promises'
import path from 'node:path'

import { parseHookConfig } from '../hooks/config-schema.js'
import type { HookEventName } from '../hooks/types.js'
import { parseServersBlock } from '../mcp/config-schema.js'
import { extractMcpServersBlock } from './integration.js'
import type { PluginManifest, PluginSource } from './types.js'

export interface ConsentPreview {
  pluginId: string
  version: string
  description?: string
  source: PluginSource
  marketplace: string
  /** True when the install came from a marketplace flagged `verified`. */
  verified: boolean
  /** True when the marketplace's name is one of `RESERVED_MARKETPLACE_NAMES`. */
  fromReservedMarketplace: boolean
  /** Hook event names the plugin registers. Empty means no hooks. */
  hookEvents: HookEventName[]
  /** MCP server names contributed inline (path-form not previewed —
   *  requires reading another file before consent). */
  inlineMcpServerNames: string[]
  hasSkillsDir: boolean
  hasAgentsDir: boolean
  hasCommandsDir: boolean
  /** True when manifest declares `mcpServers` as a file path (not
   *  inline) — we don't have the names yet at consent time, but we can
   *  warn the user that the plugin DOES bring MCP servers. */
  hasPathMcpServers: boolean
  /** Same as above for hooks declared via path rather than inline. */
  hasPathHooks: boolean
  author?: string
  license?: string
  homepage?: string
}

/** Filesystem-side info about a plugin's root directory — the things
 *  a manifest-only inspection can't see. Populated by [[probePluginRoot]]
 *  and passed to [[buildConsentPreview]] so the install-time "Will
 *  contribute" line reflects auto-discovered contributions (e.g.
 *  Claude Code's convention of dropping `.mcp.json` next to plugin.json
 *  instead of declaring `mcpServers` in the manifest). */
export interface RootProbe {
  hasSkillsDir: boolean
  hasAgentsDir: boolean
  hasCommandsDir: boolean
  /** Server names parsed from a root-level `.mcp.json` / `mcp.json`
   *  (both flat and wrapped shapes accepted; see
   *  [[extractMcpServersBlock]]). Empty when neither file is present
   *  or the file failed to parse. */
  rootMcpServerNames: string[]
  /** True when a root-level mcp file exists, even if no names could
   *  be parsed from it. Lets the consent UI still warn "this plugin
   *  contributes MCP servers" when names are momentarily unknown. */
  hasRootMcpFile: boolean
  /** Hook event names parsed from `hooks/hooks.json` at root, if present. */
  rootHookEvents: HookEventName[]
  /** True when `hooks/hooks.json` exists, regardless of parse result. */
  hasRootHooksFile: boolean
}

export interface BuildPreviewInput {
  pluginId: string
  manifest: PluginManifest
  source: PluginSource
  marketplace: string
  verified?: boolean
  fromReservedMarketplace?: boolean
  /** Optional probe of the plugin's root directory. Without it,
   *  consent shows only what the manifest declares — which misses
   *  Claude Code-convention plugins that ship contributions as
   *  conventional files / dirs alongside `plugin.json`. */
  rootProbe?: RootProbe
}

/** Stat the plugin root for the conventional contribution files / dirs
 *  the loader's `resolveContributions` will pick up at runtime. The
 *  consent UI uses this so "Will contribute" doesn't lie when a plugin
 *  drops `skills/`, `.mcp.json`, etc. at root without naming them in
 *  the manifest. Safe to call on any directory — every probe is a
 *  best-effort stat / read and missing or unreadable files just count
 *  as "absent". */
export async function probePluginRoot(rootDir: string): Promise<RootProbe> {
  const [hasSkillsDir, hasAgentsDir, hasCommandsDir] = await Promise.all([
    isDir(path.join(rootDir, 'skills')),
    isDir(path.join(rootDir, 'agents')),
    isDir(path.join(rootDir, 'commands')),
  ])

  let rootMcpServerNames: string[] = []
  let hasRootMcpFile = false
  for (const conv of ['.mcp.json', 'mcp.json']) {
    const p = path.join(rootDir, conv)
    if (!(await isFile(p))) continue
    hasRootMcpFile = true
    try {
      const raw = await fs.readFile(p, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      const block = extractMcpServersBlock(parsed)
      const { servers } = parseServersBlock(block)
      rootMcpServerNames = Object.keys(servers)
    } catch {
      // parse errors are deliberately swallowed — they'll surface
      // with a precise message at load time. The consent preview
      // just needs to know the file exists.
    }
    break
  }

  let rootHookEvents: HookEventName[] = []
  let hasRootHooksFile = false
  const hooksPath = path.join(rootDir, 'hooks', 'hooks.json')
  if (await isFile(hooksPath)) {
    hasRootHooksFile = true
    try {
      const raw = await fs.readFile(hooksPath, 'utf-8')
      const parsed = JSON.parse(raw)
      const cfg = parseHookConfig(parsed, rootDir)
      rootHookEvents = Object.keys(cfg) as HookEventName[]
    } catch {
      // Same reasoning as the mcp probe — load-time errors win.
    }
  }

  return {
    hasSkillsDir,
    hasAgentsDir,
    hasCommandsDir,
    rootMcpServerNames,
    hasRootMcpFile,
    rootHookEvents,
    hasRootHooksFile,
  }
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

/** Build a `ConsentPreview` from a parsed manifest. The hook + mcp
 *  fields are inspected only for the inline shape; path-form
 *  contributions are surfaced as `has*` booleans so the consent UI can
 *  warn "this plugin contributes MCP servers" even when their names
 *  aren't yet known.
 *
 *  When `input.rootProbe` is present, conventional root-level
 *  contributions (an undeclared `.mcp.json`, `hooks/hooks.json`,
 *  `skills/`, etc.) are merged in too — the loader will pick those up
 *  at runtime, so the consent UI needs to know about them now. */
export function buildConsentPreview(input: BuildPreviewInput): ConsentPreview {
  const m = input.manifest
  const probe = input.rootProbe

  let hookEvents: HookEventName[] = []
  let hasPathHooks = false
  if (m.hooks !== undefined) {
    if (typeof m.hooks === 'string') {
      hasPathHooks = true
    } else {
      try {
        const cfg = parseHookConfig(m.hooks, input.pluginId)
        hookEvents = Object.keys(cfg) as HookEventName[]
      } catch {
        // Don't fail consent on hook parse errors — the install path
        // will surface them properly. Just leave hookEvents empty so
        // the preview doesn't lie about what's registered.
      }
    }
  } else if (probe?.hasRootHooksFile) {
    hookEvents = probe.rootHookEvents
    hasPathHooks = true
  }

  let inlineMcpServerNames: string[] = []
  let hasPathMcpServers = false
  if (m.mcpServers !== undefined) {
    if (typeof m.mcpServers === 'string') {
      hasPathMcpServers = true
    } else {
      const { servers } = parseServersBlock(m.mcpServers)
      inlineMcpServerNames = Object.keys(servers)
    }
  } else if (probe?.hasRootMcpFile) {
    // Convention-discovered `.mcp.json` at the plugin root — same blast
    // radius as a manifest-declared path entry. Surface names when we
    // were able to parse them; otherwise just flag the file's presence.
    inlineMcpServerNames = probe.rootMcpServerNames
    hasPathMcpServers = true
  }

  return {
    pluginId: input.pluginId,
    version: m.version,
    description: m.description,
    source: input.source,
    marketplace: input.marketplace,
    verified: input.verified ?? false,
    fromReservedMarketplace: input.fromReservedMarketplace ?? false,
    hookEvents,
    inlineMcpServerNames,
    hasSkillsDir: !!m.skills || !!probe?.hasSkillsDir,
    hasAgentsDir: !!m.agents || !!probe?.hasAgentsDir,
    hasCommandsDir: !!m.commands || !!probe?.hasCommandsDir,
    hasPathMcpServers,
    hasPathHooks,
    author: m.author?.name,
    license: m.license,
    homepage: m.homepage,
  }
}
