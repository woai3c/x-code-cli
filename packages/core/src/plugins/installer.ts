// @x-code-cli/core — Plugin installer
//
// Three supported source kinds:
//
//   - 'local'   filesystem directory → copied recursively into cache
//                (skipping .git / node_modules / OS junk)
//   - 'git'     arbitrary git URL    → shallow-cloned (depth 1, optional ref)
//   - 'github'  github:owner/repo    → shallow-cloned via resolveCloneUrl
//                Monorepo `subdir` supported: whole repo is shallow-cloned,
//                the named subdir is copied into a fresh temp dir, the rest
//                discarded.
//
// Install flow:
//   1. Fetch source into a temp dir
//   2. Discover + parse manifest (reject Gemini-only sources here)
//   3. Compute final cache path: cache/<marketplace>/<plugin>/<version>/
//   4. Wipe any existing install at that path (re-install / same-version upgrade)
//   5. Move temp → final (rename when possible, copy+rm fallback for EXDEV)
//   6. Append/update installed_plugins.json
//
// AbortSignal threads through git clone (via execa's `signal`) and the
// recursive copy (cooperative check between entries) so Esc during a long
// install cleanly cancels in-flight work.
//
// Cache layout is deliberately per-version so `/plugin update` can install
// a new version side-by-side and atomically switch (a later improvement);
// today we just overwrite same-version installs.
import { execa } from 'execa'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { debugLog } from '../utils.js'
import { type ConsentPreview, buildConsentPreview, probePluginRoot } from './consent.js'
import { ManifestParseError, discoverManifest, parseManifest } from './manifest.js'
import { RESERVED_MARKETPLACE_NAMES, readKnownMarketplaces, resolveCloneUrl } from './marketplace.js'
import { installedPluginsPath, pluginCacheDir, pluginCacheParent } from './paths.js'
import type {
  InstalledPluginRecord,
  InstalledPlugins,
  ManifestFormat,
  PluginManifest,
  PluginScope,
  PluginSource,
} from './types.js'
import { type UserConfigValue, setPluginUserConfig } from './user-config.js'

export interface InstallRequest {
  source: PluginSource
  /** Marketplace this plugin belongs to. Use `"local"` for direct
   *  git/local installs that aren't associated with a subscribed
   *  marketplace — the resulting plugin id will be `<name>@local`. */
  marketplace: string
  /** Scope where the install is recorded (which settings.json's
   *  `enabledPlugins` map will mention it). Defaults to `'user'`. */
  scope?: PluginScope
  /** If set, the installer aborts when the manifest's `name` field
   *  doesn't match — used by the marketplace install path to catch
   *  spoofed entries. */
  expectedName?: string
  /** Whether the marketplace listing marked this plugin as verified.
   *  Surfaced to the consent callback so users know whether the listing
   *  came with curator endorsement. Pure metadata — we don't grant
   *  extra trust based on the flag. */
  verified?: boolean
  /** Called after manifest parse but BEFORE the temp dir is moved to
   *  the cache. Return false to abort the install — the temp dir is
   *  cleaned up and the cache is untouched. Absent ⇒ install proceeds
   *  without prompting (used by tests + the `--yes` CLI flag). */
  consent?: (preview: ConsentPreview) => Promise<boolean> | boolean
  /** Called AFTER consent passes when the manifest declares `userConfig`.
   *  The caller (a CLI / TUI handler) collects values for each field —
   *  typically by prompting the user one field at a time, masking input
   *  for `sensitive: true` fields — and resolves to a `{ key: value }`
   *  map that gets persisted via user-config.ts. Returning `null`
   *  aborts the install (treat it like consent denial). Absent ⇒ we
   *  skip the prompt; non-sensitive fields fall back to manifest
   *  defaults, sensitive fields are simply unset (the plugin's hooks /
   *  MCP entries will see empty env vars, which is the same as today). */
  userConfigPrompt?: (fields: PluginManifest['userConfig']) => Promise<Record<string, UserConfigValue> | null>
  signal?: AbortSignal
}

export interface InstallResult {
  pluginId: string
  rootDir: string
  manifest: PluginManifest
  manifestFormat: ManifestFormat
  record: InstalledPluginRecord
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstallError'
  }
}

export async function installPlugin(req: InstallRequest): Promise<InstallResult> {
  // ── Pre-flight policy checks (cheap, fail-fast) ──
  // `strictKnownMarketplaces` and `blockedPlugins` come from
  // ~/.x-code/plugins/known_marketplaces.json. When the admin
  // (typically enterprise) has opted into strict mode, every install
  // must come from a subscribed marketplace — direct git / github /
  // local installs are denied. `blockedPlugins` is checked after the
  // manifest is parsed (we need the canonical id).
  const km = await readKnownMarketplaces()
  if (km.strictKnownMarketplaces) {
    const subscribed = km.marketplaces.some((m) => m.name === req.marketplace)
    if (!subscribed) {
      throw new InstallError(
        `strict marketplace mode is enabled (known_marketplaces.json:strictKnownMarketplaces=true) — ` +
          `plugins can only be installed from a subscribed marketplace, but "${req.marketplace}" is not one. ` +
          `Either subscribe it first (\`xc plugin marketplace add\`) or turn strict mode off.`,
      )
    }
  }

  const tempDir = await fetchToTemp(req.source, req.signal)

  try {
    const discovery = await discoverManifest(tempDir)
    if (!discovery) {
      throw new InstallError(
        'no plugin manifest found in source (looked for .x-code-plugin/plugin.json, .claude-plugin/plugin.json, plugin.json)',
      )
    }
    if (discovery.format === 'gemini') {
      throw new InstallError(
        'this is a Gemini extension (gemini-extension.json) — x-code-cli does not support Gemini extensions; see docs/plugins.md',
      )
    }

    let manifest: PluginManifest
    try {
      manifest = await parseManifest(discovery.manifestPath)
    } catch (err) {
      if (err instanceof ManifestParseError) throw new InstallError(err.message)
      throw err
    }

    if (req.expectedName && manifest.name !== req.expectedName) {
      throw new InstallError(`manifest name "${manifest.name}" does not match expected "${req.expectedName}"`)
    }

    // Now that we know the canonical plugin id, run the second
    // policy check: blockedPlugins from known_marketplaces.json. This
    // is an admin-style force-disable list — an install attempt for
    // a blocked id is rejected regardless of marketplace / consent.
    // Two match forms are accepted:
    //   - Fully-qualified id `name@marketplace` — precise (admin can
    //     block one marketplace's variant without affecting forks)
    //   - Bare name `name` — broad (admin can block every marketplace's
    //     plugin with that name in one shot; matches the npm `--ignore`
    //     style some admins expect)
    const earlyId = `${manifest.name}@${req.marketplace}`
    const blocked = km.blockedPlugins?.find((b) => b === earlyId || b === manifest.name)
    if (blocked) {
      throw new InstallError(
        `plugin "${earlyId}" is on the blockedPlugins list in known_marketplaces.json ` +
          `(matched entry: "${blocked}") — remove it from that list (or use a different plugin) to install.`,
      )
    }

    // ── Consent gate ──
    // Built from the parsed manifest so the caller can render a
    // preview of what the plugin will contribute (hooks, mcp, scopes)
    // and ask the user explicitly. Skipping the prompt (callback
    // absent) is intentional for non-interactive paths — the CLI
    // implements `--yes` by simply not passing `consent`.
    if (req.consent) {
      const rootProbe = await probePluginRoot(tempDir)
      const preview = buildConsentPreview({
        pluginId: `${manifest.name}@${req.marketplace}`,
        manifest,
        source: req.source,
        marketplace: req.marketplace,
        verified: req.verified,
        fromReservedMarketplace: req.marketplace in RESERVED_MARKETPLACE_NAMES,
        rootProbe,
      })
      const accepted = await req.consent(preview)
      if (!accepted) {
        throw new InstallError('install cancelled by user (consent declined)')
      }
    }

    // ── userConfig prompt (post-consent, pre-commit) ──
    // Only fires when the manifest declares userConfig fields AND the
    // caller wired a prompt callback. Non-interactive paths (--yes, CI)
    // skip the prompt — fields stay unset and the plugin sees empty env
    // vars at hook / mcp launch time, same as before this feature.
    // Returning null from the prompt aborts the install (treated like
    // consent denial); a non-null object is persisted via setPluginUserConfig.
    if (manifest.userConfig && manifest.userConfig.length > 0 && req.userConfigPrompt) {
      const collected = await req.userConfigPrompt(manifest.userConfig)
      if (collected === null) {
        throw new InstallError('install cancelled by user (userConfig prompt aborted)')
      }
      // Persist BEFORE moving the temp dir to cache so a crash between
      // the two phases leaves the user with no broken plugin and no
      // orphaned secret. The settings file is keyed by plugin id and
      // overwrites cleanly on reinstall.
      const pluginIdForConfig = `${manifest.name}@${req.marketplace}`
      await setPluginUserConfig(pluginIdForConfig, collected)
    }

    const finalDir = pluginCacheDir(req.marketplace, manifest.name, manifest.version)

    // Same-version reinstall: wipe existing install first. Skipping this
    // would leave stale files mixed with new ones if the new version drops
    // a file the old version had.
    await fs.rm(finalDir, { recursive: true, force: true })
    await fs.mkdir(path.dirname(finalDir), { recursive: true })
    await moveOrCopy(tempDir, finalDir, req.signal)

    const pluginId = `${manifest.name}@${req.marketplace}`
    const record: InstalledPluginRecord = {
      id: pluginId,
      name: manifest.name,
      marketplace: req.marketplace,
      version: manifest.version,
      source: req.source,
      installedAt: new Date().toISOString(),
      installScope: req.scope ?? 'user',
    }
    await recordInstallation(record)

    return { pluginId, rootDir: finalDir, manifest, manifestFormat: discovery.format, record }
  } catch (err) {
    // Best-effort cleanup of the temp dir on any failure mid-install. The
    // moveOrCopy success path renames the temp away, so this only fires
    // when something went wrong before the move.
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {
      /* nothing useful to do */
    })
    if (err instanceof InstallError || err instanceof ManifestParseError) throw err
    throw new InstallError(err instanceof Error ? err.message : String(err))
  }
}

// ── Source → temp dir ───────────────────────────────────────────────────

async function fetchToTemp(source: PluginSource, signal?: AbortSignal): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-install-'))

  if (source.kind === 'local') {
    const resolved = path.resolve(source.path)
    const stat = await fs.stat(resolved).catch(() => null)
    if (!stat || !stat.isDirectory()) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      // Surface cwd in the error: relative paths get resolved against
      // process.cwd(), and when xc is launched via `pnpm dev` the cwd
      // is `packages/cli/`, not the repo root — that mismatch confuses
      // users typing `./foo` in the slash command. Showing both the
      // resolved absolute path and the cwd makes the cause obvious.
      const isRelative = !path.isAbsolute(source.path)
      const cwdHint = isRelative ? ` (resolved relative to cwd: ${process.cwd()})` : ''
      throw new InstallError(`local source is not a directory: ${resolved}${cwdHint}`)
    }
    await copyDirFiltered(resolved, tempDir, signal)
    return tempDir
  }

  if (source.kind === 'git' || source.kind === 'github') {
    const cloneUrl = source.kind === 'git' ? source.url : resolveCloneUrl(`github:${source.owner}/${source.repo}`)
    const args = ['clone', '--depth', '1']
    if (source.ref) args.push('--branch', source.ref)
    // For subdir installs we still shallow-clone the whole repo. Real
    // sparse-checkout would be faster on huge monorepos but the
    // `--depth 1 --filter=blob:none --sparse` sequence is fragile across
    // git versions; a depth-1 clone of even a large monorepo is usually
    // <100 MB. Revisit if it becomes a pain point.
    args.push(cloneUrl, tempDir)

    try {
      await execa('git', args, { signal, stdio: 'pipe' })
    } catch (err) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw new InstallError(`git clone failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Integrity check: when the marketplace.json pinned a `sha`, verify
    // that the commit we actually cloned matches it. Defends against the
    // upstream ref being force-pushed or the repo being compromised
    // between marketplace review and end-user install. Must run BEFORE
    // we drop `.git` below (rev-parse needs the repo metadata).
    //
    // Prefix-match semantics: declared sha can be a short sha (≥7 hex)
    // and still validate against the full 40-char HEAD — same tolerance
    // as `git checkout <short-sha>` and what real marketplaces produce
    // (anthropics/claude-plugins-official sometimes ships 7-char shas).
    //
    // Why hard fail and not warn: a sha mismatch is by definition either
    // a misconfigured marketplace.json (author bug) or a real
    // supply-chain anomaly. Either way the user shouldn't end up with
    // unreviewed code on disk. Better to surface a loud error pointing
    // at the marketplace author than to silently install whatever HEAD
    // happens to be.
    if (source.expectedSha) {
      try {
        const result = await execa('git', ['rev-parse', 'HEAD'], { cwd: tempDir, stdio: 'pipe', signal })
        const actualSha = result.stdout.trim().toLowerCase()
        const expected = source.expectedSha.toLowerCase()
        if (!actualSha.startsWith(expected)) {
          await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
          throw new InstallError(
            `sha integrity check failed for ${cloneUrl}${source.ref ? `@${source.ref}` : ''}: ` +
              `marketplace.json declared sha=${expected}, actual HEAD=${actualSha}. ` +
              `The upstream ref may have been force-pushed or the repo compromised. ` +
              `Contact the marketplace author or pin to a different version.`,
          )
        }
      } catch (err) {
        if (err instanceof InstallError) throw err
        // rev-parse failed (shouldn't happen on a fresh clone) — treat
        // as integrity failure so we don't silently install unchecked.
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
        throw new InstallError(
          `failed to verify sha for ${cloneUrl}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // Drop the .git dir — we never need it after install and it would
    // bloat the cache significantly for large-history repos.
    await fs.rm(path.join(tempDir, '.git'), { recursive: true, force: true }).catch(() => {})

    // Subdir handling: the plugin actually lives at <tempDir>/<subdir>.
    // Re-stage so the rest of the install flow (manifest discovery +
    // moveOrCopy to cache) operates on just that subdir. Simplest
    // approach: copy the subdir into a fresh temp dir, discard the
    // original clone.
    const subdir = source.subdir
    if (subdir) {
      const subdirPath = path.join(tempDir, subdir)
      const stat = await fs.stat(subdirPath).catch(() => null)
      if (!stat || !stat.isDirectory()) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
        throw new InstallError(`subdir "${subdir}" not found in cloned repo ${cloneUrl}`)
      }
      const subdirTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-subdir-'))
      try {
        await copyDirFiltered(subdirPath, subdirTemp, signal)
      } catch (err) {
        await fs.rm(subdirTemp, { recursive: true, force: true }).catch(() => {})
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
        throw new InstallError(`failed to extract subdir: ${err instanceof Error ? err.message : String(err)}`)
      }
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      return subdirTemp
    }
    return tempDir
  }

  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  throw new InstallError(`unknown source kind: ${(source as PluginSource).kind}`)
}

/** Names we never copy through. `node_modules` is excluded because a
 *  bundled-deps plugin should reinstall on the user's machine; if a
 *  plugin genuinely needs node_modules we'll revisit. */
const COPY_SKIP = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db'])

async function copyDirFiltered(src: string, dst: string, signal?: AbortSignal, root?: string): Promise<void> {
  // `root` is captured on the first (non-recursive) call so the symlink
  // escape check below validates against the original plugin source, not
  // the current recursion's `src` (which moves with each subdir).
  const rootDir = root ?? src
  await fs.mkdir(dst, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    signal?.throwIfAborted()
    if (COPY_SKIP.has(entry.name)) continue
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      await copyDirFiltered(s, d, signal, rootDir)
    } else if (entry.isFile()) {
      await fs.copyFile(s, d)
    } else if (entry.isSymbolicLink()) {
      // Resolve the symlink target relative to its containing directory.
      // If the resolved target escapes the plugin source root, drop the
      // symlink rather than preserve it: on POSIX a `evil -> /etc/passwd`
      // in the plugin tree would put a host-file pointer in the cache for
      // loader / hooks to deref at runtime; on Windows the fallback below
      // would copy `/etc/passwd`-equivalents straight into the cache.
      // We don't follow the symlink to validate that the target exists —
      // a broken-but-in-bounds symlink is still safe to preserve.
      const target = await fs.readlink(s)
      const resolved = path.resolve(path.dirname(s), target)
      const rel = path.relative(rootDir, resolved)
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        debugLog('plugins.copy-symlink-escape', `${s} -> ${target} (resolved ${resolved}, outside ${rootDir})`)
        continue
      }
      try {
        await fs.symlink(target, d)
      } catch {
        // Windows without symlink privilege: fall back to copying the
        // resolved file. Best effort — broken symlinks just get dropped.
        await fs.copyFile(s, d).catch(() => {})
      }
    }
  }
}

/** Move from temp → final dir. Rename is atomic + cheap when src and dst
 *  are on the same filesystem; otherwise (EXDEV on Windows mostly) we
 *  fall back to copy + rm. */
async function moveOrCopy(src: string, dst: string, signal?: AbortSignal): Promise<void> {
  try {
    await fs.rename(src, dst)
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTEMPTY') {
      // Surfacing the original error here would block install for transient
      // weirdness; the copy fallback below succeeds in all the cases we've
      // seen in the wild. Still log for postmortem.
      debugLog('plugins.install-rename-fallback', String(err))
    }
  }
  await copyDirFiltered(src, dst, signal)
  await fs.rm(src, { recursive: true, force: true }).catch(() => {})
}

// ── installed_plugins.json bookkeeping ──────────────────────────────────

async function readInstalledPlugins(): Promise<InstalledPlugins> {
  const file = installedPluginsPath()
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as InstalledPlugins
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.plugins)) {
      return { schemaVersion: '1', plugins: [] }
    }
    return { schemaVersion: parsed.schemaVersion ?? '1', plugins: parsed.plugins }
  } catch {
    return { schemaVersion: '1', plugins: [] }
  }
}

async function writeInstalledPlugins(data: InstalledPlugins): Promise<void> {
  const file = installedPluginsPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

async function recordInstallation(record: InstalledPluginRecord): Promise<void> {
  const data = await readInstalledPlugins()
  const idx = data.plugins.findIndex((p) => p.id === record.id)
  if (idx >= 0) data.plugins[idx] = record
  else data.plugins.push(record)
  await writeInstalledPlugins(data)
}

export async function listInstalledPlugins(): Promise<InstalledPluginRecord[]> {
  const data = await readInstalledPlugins()
  return data.plugins
}

export async function findInstalledPlugin(id: string): Promise<InstalledPluginRecord | undefined> {
  const data = await readInstalledPlugins()
  return data.plugins.find((p) => p.id === id)
}

// ── Uninstall ──────────────────────────────────────────────────────────

export interface UninstallResult {
  /** Versions that were removed from cache. Empty if the plugin wasn't
   *  cached. */
  removedVersions: string[]
  /** Whether the installed_plugins.json record was removed. */
  removedRecord: boolean
}

/** Remove all cached versions of a plugin + drop its
 *  installed_plugins.json record. Leaves the data dir
 *  (`~/.x-code/plugins/data/<id>/`) intact so the user doesn't lose
 *  state if they reinstall later. */
export async function uninstallPlugin(id: string): Promise<UninstallResult> {
  const record = await findInstalledPlugin(id)
  const result: UninstallResult = { removedVersions: [], removedRecord: false }

  if (record) {
    const parent = pluginCacheParent(record.marketplace, record.name)
    try {
      const versions = await fs.readdir(parent)
      result.removedVersions = versions
      await fs.rm(parent, { recursive: true, force: true })
    } catch {
      // No cache entries — the record might be stale. Removing the record
      // below still happens.
    }
  }

  const data = await readInstalledPlugins()
  const before = data.plugins.length
  data.plugins = data.plugins.filter((p) => p.id !== id)
  if (data.plugins.length !== before) {
    await writeInstalledPlugins(data)
    result.removedRecord = true
  }

  return result
}
