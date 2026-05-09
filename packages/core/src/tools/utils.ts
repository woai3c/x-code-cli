// @x-code-cli/core — small helpers shared across tool implementations.
//
// Each file in this directory whose name corresponds to a tool (glob.ts,
// grep.ts, shell.ts, ...) defines exactly one tool. Larger pieces of
// shared infrastructure get their own named module (progress.ts for the
// progress reporter registry, shell-provider.ts for cross-platform shell
// dispatch, truncate.ts for tool-result size limits). This file is for
// the small leftovers — single-function helpers that more than one tool
// uses but that don't justify a dedicated module.
//
// Keep it focused: prefer adding a small helper here over creating a new
// per-helper file under tools/.
import { createRequire } from 'node:module'

// `@x-code-cli/core` is an ESM package (`"type": "module"`), so the
// global `require` is not defined at runtime. We need `createRequire` to
// load CJS-only modules like `@vscode/ripgrep`, which exposes the binary
// path through `module.exports.rgPath` (no ESM build available).
const _require = createRequire(import.meta.url)

/** Cached path to the ripgrep binary. Resolved lazily on first use,
 *  reused for the rest of the process. */
let _rgPath: string | null = null

/** Resolve the path to the ripgrep binary used by the `glob` and `grep`
 *  tools. Prefers @vscode/ripgrep (which ships a prebuilt binary per
 *  platform) and falls back to `rg` from PATH so dev machines with a
 *  system-wide ripgrep install still work even if the package's
 *  postinstall failed. */
export function getRipgrepPath(): string {
  if (_rgPath) return _rgPath
  try {
    const rg = _require('@vscode/ripgrep') as { rgPath: string }
    _rgPath = rg.rgPath
  } catch {
    _rgPath = 'rg'
  }
  return _rgPath
}
