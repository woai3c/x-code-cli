// @x-code-cli/cli — Resolve the CLI version from its own package.json at runtime.
//
// We cannot rely on a hard-coded constant (it goes stale on every release)
// and we cannot statically import package.json in an ESM bundle. Walk up
// from this module's location until we find a package.json whose name
// matches this package — this works both for `tsx src/index.ts` (where
// __dirname is packages/cli/src) and for the esbuild-bundled dist/cli.js
// (where __dirname is packages/cli/dist).
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function resolveVersion(): string {
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
  return 'unknown'
}

export const VERSION = resolveVersion()
