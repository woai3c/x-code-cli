// Regression tests for tools/utils.ts
//
// Background: previous implementations used a bare `require('@vscode/ripgrep')`
// inside an ESM module. At runtime that throws `ReferenceError: require is
// not defined` — the call hit the catch arm and silently fell back to
// `'rg'`, which then failed with `spawn rg ENOENT` on machines without a
// system-wide ripgrep install. Now `tools/utils.ts` uses
// `createRequire(import.meta.url)` so the require call actually works.
import { describe, expect, it } from 'vitest'

import fs from 'node:fs'
import path from 'node:path'

import { getRipgrepPath } from '../src/tools/utils.js'

describe('getRipgrepPath', () => {
  it('resolves to an existing absolute @vscode/ripgrep binary', () => {
    const p = getRipgrepPath()
    // If the resolved path doesn't exist, glob/grep will surface
    // `spawn ... ENOENT` to the model on first call. This test is the
    // canary: it catches both ESM/CJS regressions (where require fails
    // and we silently fall back) and broken @vscode/ripgrep installs
    // (where require succeeds but the postinstall didn't drop the
    // binary).
    expect(path.isAbsolute(p)).toBe(true)
    expect(fs.existsSync(p)).toBe(true)
  })
})
