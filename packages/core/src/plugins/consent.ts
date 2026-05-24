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
import { parseHookConfig } from '../hooks/config-schema.js'
import type { HookEventName } from '../hooks/types.js'
import { parseServersBlock } from '../mcp/config-schema.js'
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

export interface BuildPreviewInput {
  pluginId: string
  manifest: PluginManifest
  source: PluginSource
  marketplace: string
  verified?: boolean
  fromReservedMarketplace?: boolean
}

/** Build a `ConsentPreview` from a parsed manifest. The hook + mcp
 *  fields are inspected only for the inline shape; path-form
 *  contributions are surfaced as `has*` booleans so the consent UI can
 *  warn "this plugin contributes MCP servers" even when their names
 *  aren't yet known. */
export function buildConsentPreview(input: BuildPreviewInput): ConsentPreview {
  const m = input.manifest

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
    hasSkillsDir: !!m.skills,
    hasAgentsDir: !!m.agents,
    hasCommandsDir: !!m.commands,
    hasPathMcpServers,
    hasPathHooks,
    author: m.author?.name,
    license: m.license,
    homepage: m.homepage,
  }
}
