// @x-code-cli/core — Plugin userConfig storage
//
// Each plugin can declare a `userConfig` block in its manifest — a list of
// fields the plugin needs from the user (API keys, account ids, working
// directories, etc). At install time the CLI prompts for each field's
// value; this module owns the on-disk persistence layer.
//
// Layout:
//
//   ~/.x-code/plugins/user-config.json    →  {
//                                              [pluginId]: { [key]: <value> }
//                                            }
//
// Storage format is a plain JSON map; the file is created with 0600
// (owner-read-write only) so a process in another user's session can't
// read sensitive values. This is NOT a substitute for a real OS keychain
// (macOS Keychain / Windows Credential Manager / Linux libsecret) — it's
// a pragmatic v1 that avoids the native-build complexity. The
// `sensitive: true` field still drives mask-on-input at prompt time; only
// the at-rest storage shares one file.
//
// A future enhancement will move `sensitive` entries to a real keychain.
// The reader merges from both sources, so adding it later is a non-
// breaking change.
//
// Why not split sensitive vs non-sensitive into separate files: it would
// just multiply file IO without raising the security bar (both files live
// in the same dir with the same perms). Real protection requires a real
// keychain; until then, one file is honest about what we're doing.
import fs from 'node:fs/promises'
import path from 'node:path'

import { debugLog } from '../utils.js'
import { pluginsRoot } from './paths.js'

/** Value type for a single field. The manifest `type` field (string /
 *  number / boolean) is enforced at prompt time, but we round-trip
 *  through JSON which only knows these three primitives anyway. */
export type UserConfigValue = string | number | boolean

/** Per-plugin user-config map: keyed by the manifest's `key` field. */
export type PluginUserConfig = Record<string, UserConfigValue>

/** Full file layout: { [pluginId]: PluginUserConfig }. */
type UserConfigFile = Record<string, PluginUserConfig>

function userConfigPath(): string {
  return path.join(pluginsRoot(), 'user-config.json')
}

async function readFile(): Promise<UserConfigFile> {
  try {
    const raw = await fs.readFile(userConfigPath(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as UserConfigFile
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    debugLog('plugins.user-config-read-error', String(err))
    return {}
  }
}

async function writeFile(data: UserConfigFile): Promise<void> {
  const p = userConfigPath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  // 0600 keeps the file readable only by the owning user. On Windows
  // this is a no-op (fs.chmod doesn't translate to ACLs the same way) —
  // there's nothing meaningful we can do without shelling out to icacls.
  // The keychain followup will solve Windows properly.
  await fs.writeFile(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

/** Read the saved config for one plugin. Returns an empty object when
 *  the plugin has no saved config yet — caller can default keys from
 *  the manifest. */
export async function getPluginUserConfig(pluginId: string): Promise<PluginUserConfig> {
  const all = await readFile()
  return all[pluginId] ?? {}
}

/** Write the config for one plugin. Merges with existing fields rather
 *  than replacing — caller can call this once per field if they want
 *  (e.g. interactive prompt loop). */
export async function setPluginUserConfig(pluginId: string, values: PluginUserConfig): Promise<void> {
  const all = await readFile()
  all[pluginId] = { ...(all[pluginId] ?? {}), ...values }
  await writeFile(all)
}

/** Drop the config for one plugin (e.g. on uninstall). */
export async function clearPluginUserConfig(pluginId: string): Promise<void> {
  const all = await readFile()
  if (!(pluginId in all)) return
  delete all[pluginId]
  await writeFile(all)
}

/** Materialise a plugin's user-config map as an env-var record ready to
 *  be merged into a child process's environment. Each manifest key
 *  becomes the env var name; numbers and booleans coerce to their
 *  string forms. Unset fields are skipped (env vars left untouched). */
export async function getPluginUserConfigEnv(pluginId: string): Promise<Record<string, string>> {
  const cfg = await getPluginUserConfig(pluginId)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(cfg)) {
    env[k] = String(v)
  }
  return env
}
