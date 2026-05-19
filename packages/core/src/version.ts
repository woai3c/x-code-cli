// @x-code-cli/core — Runtime-resolved package version.
//
// Core is built via `tsc -b` (no bundler) so we can't use a build-time
// define like the CLI does. Instead we walk up from `import.meta.url`
// looking for the nearest `@x-code-cli/*` package.json and read its
// `version` field.
//
// Two cases this needs to handle:
//
// 1. Dev / unbundled — core's compiled files live at
//    `<core>/dist/**/*.js`; walking up finds `<core>/package.json`
//    (name = `@x-code-cli/core`).
// 2. Bundled CLI — the CLI esbuilds core's source into one
//    `<cli>/dist/cli.js`. `import.meta.url` points into that bundle,
//    so the nearest package.json is `<cli>/package.json`
//    (name = `@x-code-cli/cli`).
//
// `core` and `cli` are released in lockstep by `scripts/release.mjs`,
// so either match yields the right version.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FALLBACK_VERSION = '0.0.0-dev'

function resolveVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 8; i++) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string }
        if ((pkg.name === '@x-code-cli/core' || pkg.name === '@x-code-cli/cli') && pkg.version) {
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
  return FALLBACK_VERSION
}

export const VERSION = resolveVersion()
