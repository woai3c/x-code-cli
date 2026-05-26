// @x-code-cli/core — Plugin filesystem layout
//
// Centralised path helpers for the plugin subsystem. Every other plugin
// module asks here rather than re-deriving paths so that the
// `XC_PLUGINS_DIR` test override has a single chokepoint.
//
// Layout (under ~/.x-code/plugins/ by default):
//
//   known_marketplaces.json          — subscribed marketplaces registry
//   marketplaces/<name>/marketplace.json
//                                    — cached marketplace index
//   cache/<marketplace>/<plugin>/<version>/
//                                    — actual installed plugin contents
//   data/<plugin-id>/                — plugin's persistent data dir
//                                      (survives upgrades; plugin-id is
//                                      "name@marketplace" with path
//                                      separators sanitised)
//   installed_plugins.json           — bookkeeping of installed plugins
import path from 'node:path'

import { XCODE_DIR, userXcodeDir } from '../utils.js'

const PLUGINS_DIR_NAME = 'plugins'

/** Root of the plugin subsystem. Two override knobs, checked in order:
 *  - `XC_PLUGINS_DIR` — plugin-specific override (parallels
 *    `XC_AGENTS_DIR` / `XC_SKILLS_DIR`; preferred when tests want to
 *    isolate JUST plugins without redirecting MCP / config / OAuth).
 *  - `X_CODE_HOME` — broad override of the whole `~/.x-code/` root
 *    (resolved via {@link userXcodeDir}). Reroutes plugins along with
 *    config, MCP state, etc. */
export function pluginsRoot(): string {
  const override = process.env.XC_PLUGINS_DIR
  if (override) return override
  return path.join(userXcodeDir(), PLUGINS_DIR_NAME)
}

/** ~/.x-code/plugins/known_marketplaces.json */
export function knownMarketplacesPath(): string {
  return path.join(pluginsRoot(), 'known_marketplaces.json')
}

/** ~/.x-code/plugins/marketplaces/<name>/ */
export function marketplaceDir(name: string): string {
  return path.join(pluginsRoot(), 'marketplaces', name)
}

/** ~/.x-code/plugins/marketplaces/<name>/marketplace.json */
export function marketplaceIndexPath(name: string): string {
  return path.join(marketplaceDir(name), 'marketplace.json')
}

/** ~/.x-code/plugins/cache/<marketplace>/<plugin>/ — all versions live
 *  under this directory; the active version is whichever the installer
 *  recorded most recently in installed_plugins.json. */
export function pluginCacheParent(marketplace: string, plugin: string): string {
  return path.join(pluginsRoot(), 'cache', marketplace, plugin)
}

/** ~/.x-code/plugins/cache/<marketplace>/<plugin>/<version>/ */
export function pluginCacheDir(marketplace: string, plugin: string, version: string): string {
  return path.join(pluginCacheParent(marketplace, plugin), version)
}

/** ~/.x-code/plugins/data/<sanitised-plugin-id>/ — persistent per-plugin
 *  data dir that survives upgrades. Plugin IDs ("name@marketplace") are
 *  sanitised so the `@` and any accidental path separators don't break
 *  on Windows. */
export function pluginDataDir(pluginId: string): string {
  const safe = pluginId.replace(/[/\\:]/g, '_')
  return path.join(pluginsRoot(), 'data', safe)
}

/** ~/.x-code/plugins/installed_plugins.json */
export function installedPluginsPath(): string {
  return path.join(pluginsRoot(), 'installed_plugins.json')
}

/** <cwd>/.x-code/plugins/ — rare; used when a project ships its own
 *  plugins committed to the repo (vs. installing from a marketplace).
 *  The loader scans this in addition to the user-scope cache. */
export function projectPluginsDir(cwd: string): string {
  return path.join(cwd, XCODE_DIR, 'plugins')
}

// ── Manifest discovery within a plugin root ─────────────────────────────

/** Relative manifest paths the loader probes, in priority order. The first
 *  one found wins. We deliberately accept Claude Code's path so plugins
 *  authored for Claude Code install in x-code-cli without modification —
 *  see [[plugin-marketplace-design]] §3 (cross-product compatibility). */
export const MANIFEST_CANDIDATES: ReadonlyArray<{ format: 'native' | 'claude' | 'bare'; rel: string }> = [
  { format: 'native', rel: '.x-code-plugin/plugin.json' },
  { format: 'claude', rel: '.claude-plugin/plugin.json' },
  { format: 'bare', rel: 'plugin.json' },
]

/** Gemini's manifest filename. Probed only to produce a helpful error
 *  message when a user tries to install a Gemini-only extension —
 *  installer rejects with a pointer to the design doc. */
export const GEMINI_MANIFEST_REL = 'gemini-extension.json'
