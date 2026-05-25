// @x-code-cli/core — Plugin system core types
//
// A plugin bundles skills / sub-agents / slash commands / MCP servers /
// hooks behind a single manifest and namespace. Plugins are discovered
// at CLI startup, frozen for the session (same byte-stability constraint
// as skills + sub-agents — see CLAUDE.md on systemPromptCache), and
// re-loaded only via `/plugin refresh` which explicitly invalidates the
// prompt cache.
//
// Manifest format is intentionally byte-compatible with Claude Code's
// `.claude-plugin/plugin.json` so the same plugin tarball can be installed
// in either CLI. The native `.x-code-plugin/plugin.json` path is also
// accepted (preferred for newly-authored x-code-only plugins) and a bare
// `plugin.json` in the root is tolerated.

// ── Plugin source (where it came from) ───────────────────────────────────

/** Where a plugin was installed from — the internal canonical form used
 *  by the installer and recorded in `installed_plugins.json`. Marketplace
 *  entries arrive in a different on-disk wire format (string shortcut,
 *  `git-subdir`, `url`) and are normalised to this shape by
 *  [[normalizeMarketplaceSource]]. `subdir` is supported on both git and
 *  github so monorepo-published plugins (common in real Claude Code
 *  marketplaces like `anthropics/claude-plugins-official`) install
 *  correctly.
 *
 *  `expectedSha` is an optional integrity pin propagated from the
 *  marketplace.json's `sha` field on git-backed sources. When set, the
 *  installer clones, runs `git rev-parse HEAD`, and aborts with
 *  `InstallError` on mismatch. Defends against the upstream ref being
 *  force-pushed or the repo being compromised between when the
 *  marketplace author reviewed it and when a user installs. Absent
 *  field skips the check (so marketplaces that haven't pinned shas
 *  still install). */
export type PluginSource =
  | { kind: 'git'; url: string; ref?: string; subdir?: string; expectedSha?: string }
  | { kind: 'github'; owner: string; repo: string; ref?: string; subdir?: string; expectedSha?: string }
  | { kind: 'local'; path: string }

/** Two-scope plugin enablement, mirroring the convention used by mcp and
 *  skill (see packages/core/src/skills/settings.ts):
 *
 *    'user'     →  ~/.x-code/settings.json
 *    'project'  →  <cwd>/.x-code/settings.local.json  (gitignored)
 *
 *  `'project'` reading a `.local.json` file is a slight naming quirk
 *  inherited from skills — it's a per-user override scoped to one repo,
 *  not a team-shared file. A separate team-shared scope (committed) can
 *  be layered on later without changing this union. */
export type PluginScope = 'user' | 'project'

// ── Manifest (the contract authors write) ───────────────────────────────

export interface PluginAuthor {
  name?: string
  email?: string
  url?: string
}

/** A single user-prompted config item (API key, base URL, etc.). When
 *  `sensitive: true`, the value lives in the system keyring rather than
 *  settings.json. Schema mirrors Claude Code's so the same plugin works
 *  in either CLI without authors writing a separate config block. */
export interface UserConfigItem {
  key: string
  type: 'string' | 'number' | 'boolean'
  sensitive?: boolean
  prompt?: string
  required?: boolean
  default?: string | number | boolean
  description?: string
}

/** Inline hook configuration (the alternative to a hooks file path).
 *  Loose shape here — full validation lives in
 *  packages/core/src/hooks/config-schema.ts so that hooks-only changes
 *  don't reach into the plugin layer. */
export type InlineHookConfig = Record<string, unknown>

/** Inline mcpServers record (the alternative to a path string). Matches
 *  the shape of `mcpServers` in ~/.x-code/config.json — validated by
 *  the existing mcp config-schema, not duplicated here. */
export type InlineMcpServers = Record<string, unknown>

/** The plugin manifest as parsed from disk. All paths are STORED RAW —
 *  resolution against the plugin root happens in [[loader]]. Unknown
 *  fields in the source JSON are silently stripped (zod default) so that
 *  newer Claude Code manifests with fields we don't understand still
 *  load cleanly. */
export interface PluginManifest {
  /** Schema version. Defaults to "1" when missing. Bumped by us only on
   *  breaking changes to the manifest contract; older plugins still load
   *  as long as their fields validate. */
  schemaVersion: string
  name: string
  version: string
  description?: string
  author?: PluginAuthor
  keywords?: string[]
  homepage?: string
  license?: string

  // ── Contributions (all optional, all relative to plugin root) ─────────
  /** Path to a directory of skills, each in `<name>/SKILL.md` form (same
   *  layout as `~/.x-code/skills/`). Or a single file path. */
  skills?: string
  /** Path to a directory of sub-agent `.md` files (same layout as
   *  `~/.x-code/agents/`). */
  agents?: string
  /** Path to a directory of slash command `.md` files. */
  commands?: string
  /** Either a path to a JSON file with `{ mcpServers: { ... } }` OR an
   *  inline `mcpServers` record. Inline form matches the shape used in
   *  ~/.x-code/config.json. */
  mcpServers?: string | InlineMcpServers
  /** Either a path to a hooks.json OR an inline hook config. */
  hooks?: string | InlineHookConfig

  // ── Author-visible config the user fills in at install time ───────────
  userConfig?: UserConfigItem[]

  // ── Plugin-to-plugin deps & runtime compat ────────────────────────────
  /** Dependencies as `name@marketplace` IDs. Bare `name` resolves against
   *  the same marketplace as the dependent plugin. */
  dependencies?: string[]
  engines?: { 'x-code'?: string }
}

// ── Loaded plugin (what the registry holds at runtime) ──────────────────

/** Which manifest file we loaded. `'gemini'` is never reached — Gemini
 *  extensions are rejected at install time by design (see plugin-marketplace-design.md
 *  §3.4) and the value is only used in error reporting to say "this looks
 *  like a Gemini extension, we don't support those". */
export type ManifestFormat = 'native' | 'claude' | 'bare' | 'gemini'

export interface LoadedPlugin {
  /** Composite id `name@marketplace`. `marketplace` is `"local"` for
   *  plugins installed from a local path (i.e. authored in-tree). */
  id: string
  manifest: PluginManifest
  /** Absolute path to the plugin's root directory. */
  rootDir: string
  /** Absolute path to the manifest file we loaded. */
  manifestPath: string
  manifestFormat: ManifestFormat
  /** Where this plugin originally came from. `undefined` only for the
   *  rare case of a plugin manually dropped into cache without metadata. */
  source: PluginSource | undefined
  /** Marketplace name this plugin belongs to. `"local"` for plugins
   *  installed from a local path / authored in-tree. */
  marketplace: string
  scope: PluginScope
  /** Effective enabled state after merging all three scopes. */
  enabled: boolean
}

/** A non-fatal load error — collected by the loader and surfaced via
 *  `/plugin doctor`. One broken plugin must never crash the CLI. */
export interface PluginLoadError {
  /** `name@marketplace` if we got far enough to know it. */
  id?: string
  /** Filesystem path that triggered the error, even if no manifest parsed. */
  path: string
  message: string
}

// ── Marketplace (the index / catalog format) ────────────────────────────

/** One plugin listing within a marketplace. `source` tells the installer
 *  where to fetch the plugin from. */
export interface MarketplaceEntry {
  name: string
  description?: string
  category?: string
  /** Marketplace-curator's claim of vetted-ness. We surface this in the UI
   *  but never grant additional trust based on it — install consent still
   *  runs. */
  verified?: boolean
  source: PluginSource
  /** Pinned version, if any. Otherwise installer reads version from the
   *  fetched manifest. */
  version?: string
  homepage?: string
  keywords?: string[]
}

export interface Marketplace {
  schemaVersion: string
  /** The user-facing canonical identity of this marketplace — the
   *  subscription alias the user typed (e.g. `anthropic-marketplace`).
   *  Storage paths, install ids (`<plugin>@<name>`), and lookups all key
   *  off this. */
  name: string
  /** The marketplace's own self-declared `name` from its `marketplace.json`
   *  (e.g. `claude-plugins-official`). Kept so `info` can show users what
   *  the upstream calls itself when it differs from their subscription
   *  alias. Never used as an identity for lookup. */
  upstreamName?: string
  displayName?: string
  description?: string
  owner?: { name?: string; url?: string }
  plugins: MarketplaceEntry[]
}

/** One entry in `~/.x-code/plugins/known_marketplaces.json` — a
 *  marketplace the user has subscribed to. The `source` string can be a
 *  git URL (`github:owner/repo`, `https://...`) or a direct HTTPS URL
 *  to the marketplace.json. */
export interface KnownMarketplace {
  name: string
  source: string
  /** Set on built-in entries (e.g., the default `anthropic-marketplace`).
   *  Reserved names only accept their canonical source — see
   *  RESERVED_MARKETPLACE_NAMES in [[marketplace]]. */
  reservedName?: boolean
  /** Expected GitHub org for reserved names. The installer rejects any
   *  attempt to register a reserved name pointing elsewhere. */
  officialSource?: string
}

export interface KnownMarketplaces {
  marketplaces: KnownMarketplace[]
  /** When true, plugins can only be installed from a marketplace in the
   *  `marketplaces` list. Off by default; enterprise admins flip it on. */
  strictKnownMarketplaces?: boolean
  /** Plugin IDs (`name@marketplace`) that are force-disabled regardless of
   *  user settings. Admin-style block list. */
  blockedPlugins?: string[]
}

// ── Installed plugin registry (~/.x-code/plugins/installed_plugins.json) ─

/** One entry in the installed registry — the bookkeeping we keep about
 *  each cached install so updates / uninstalls / scope changes work
 *  without re-reading every manifest. */
export interface InstalledPluginRecord {
  id: string
  name: string
  marketplace: string
  version: string
  source: PluginSource
  installedAt: string
  /** Which scope's settings.json triggered the install (where to record
   *  the enable). User scope is the default. */
  installScope: PluginScope
}

export interface InstalledPlugins {
  schemaVersion: string
  plugins: InstalledPluginRecord[]
}
