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

import { getRipgrepPath } from '../src/tools/utils.js'

describe('getRipgrepPath', () => {
  it('resolves to the @vscode/ripgrep prebuilt binary, not the literal "rg"', () => {
    const p = getRipgrepPath()
    // The whole point of @vscode/ripgrep is that it ships a per-platform
    // prebuilt binary, so the resolved path must be an absolute path —
    // not the unqualified `'rg'` fallback that fires only when the
    // require itself fails (which used to happen due to the ESM/CJS
    // mismatch).
    expect(p).not.toBe('rg')
    expect(p.length).toBeGreaterThan(2)
  })

  it('points at a binary that actually exists on disk', () => {
    const p = getRipgrepPath()
    // If the resolved path doesn't exist, glob/grep will surface
    // `spawn ... ENOENT` to the model on first call. This test is the
    // canary: it catches both ESM/CJS regressions (where require fails
    // and we silently fall back) and broken @vscode/ripgrep installs
    // (where require succeeds but the postinstall didn't drop the
    // binary).
    expect(fs.existsSync(p)).toBe(true)
  })

  it('caches the resolved path across calls', () => {
    const a = getRipgrepPath()
    const b = getRipgrepPath()
    expect(a).toBe(b)
  })
})
