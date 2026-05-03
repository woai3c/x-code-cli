// @x-code-cli/cli — CLI version.
//
// Resolved at build time via esbuild's `define`. The global `__CLI_VERSION__`
// is injected by esbuild.config.js from package.json, so there is zero
// runtime cost. For `tsx src/index.ts` dev mode, falls back to reading from
// the local package.json.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

declare const __CLI_VERSION__: string | undefined

function resolveVersion(): string {
  // Build-time define takes precedence
  if (typeof __CLI_VERSION__ === 'string' && __CLI_VERSION__) {
    return __CLI_VERSION__
  }
  // Dev-mode fallback (tsx): walk up to find package.json
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 6; i++) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string }
        if (pkg.name === '@x-code-cli/cli' && pkg.version) {
          return pkg.version
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // fall through
  }
  return '0.0.0-dev'
}

export const VERSION = resolveVersion()
