// @x-code-cli/core — Hook command variable expansion
//
// Substitutes `${name}` and `${env:NAME}` patterns inside a hook command
// string. Unknown variables are left as the literal `${name}` so a typo
// surfaces in the resulting shell command's error message rather than
// silently expanding to an empty string (which would produce confusing
// "command not found" errors that don't point at the variable).
//
// Supported variables (cf. [[plugin-marketplace-design]] §8.4):
//
//    ${pluginDir}      absolute path to the owning plugin's installed dir
//                      (versioned cache dir; wiped on reinstall / upgrade)
//    ${pluginDataDir}  absolute path to the plugin's persistent data dir
//                      (~/.x-code/plugins/data/<sanitised-plugin-id>/) —
//                      survives uninstall+reinstall and version upgrades.
//                      Created on demand by the caller before expansion;
//                      this module just substitutes the string.
//    ${cwd}            current working directory
//    ${homedir}        user home dir
//    ${sep}            OS-specific path separator (`\` Windows, `/` elsewhere)
//    ${env:NAME}       process env var `NAME` (empty string when unset)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { pluginDataDir as pluginDataDirPath } from '../plugins/paths.js'

export interface VariableContext {
  pluginDir: string
  /** Persistent per-plugin data directory. Pre-created by
   *  [[buildVariableContext]] when a `pluginId` is supplied. */
  pluginDataDir?: string
  cwd: string
  homedir?: string
  sep?: string
}

/** Default variables derived from the current process + caller context.
 *  Pass `pluginId` to enable `${pluginDataDir}` — we'll resolve the
 *  per-plugin data dir path and `mkdir -p` it so the plugin can write
 *  there immediately. mkdirSync on an existing dir is a cheap no-op. */
export function buildVariableContext(input: { pluginDir: string; cwd: string; pluginId?: string }): VariableContext {
  let dataDir: string | undefined
  if (input.pluginId) {
    dataDir = pluginDataDirPath(input.pluginId)
    try {
      fs.mkdirSync(dataDir, { recursive: true })
    } catch {
      // mkdir failure (permissions, disk full) leaves the dir missing —
      // the plugin script will get a sane shell error when it tries to
      // write there. Better than throwing here and wedging the hook.
    }
  }
  return {
    pluginDir: input.pluginDir,
    pluginDataDir: dataDir,
    cwd: input.cwd,
    homedir: os.homedir(),
    sep: path.sep,
  }
}

/** Expand `${pluginDir}` / `${pluginDataDir}` / `${cwd}` / `${homedir}` /
 *  `${sep}` / `${env:NAME}` references. Unknown patterns are left verbatim. */
export function expandVariables(source: string, ctx: VariableContext): string {
  return source.replace(/\$\{([^}]+)\}/g, (whole, expr: string) => {
    const colonIdx = expr.indexOf(':')
    if (colonIdx > 0) {
      const ns = expr.slice(0, colonIdx)
      const key = expr.slice(colonIdx + 1)
      if (ns === 'env') return process.env[key] ?? ''
      // Unknown namespace — leave verbatim
      return whole
    }
    switch (expr) {
      case 'pluginDir':
        return ctx.pluginDir
      case 'pluginDataDir':
        return ctx.pluginDataDir ?? whole
      case 'cwd':
        return ctx.cwd
      case 'homedir':
        return ctx.homedir ?? ''
      case 'sep':
        return ctx.sep ?? path.sep
      default:
        return whole
    }
  })
}
