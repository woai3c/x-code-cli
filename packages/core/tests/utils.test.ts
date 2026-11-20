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
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { getRipgrepPath } from '../src/tools/utils.js'
import { splitUtf8ByBytes, stableStringify, utf8BytePrefix } from '../src/utils/index.js'
import { resolveCoreWorkerUrl } from '../src/utils/worker-url.js'

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

describe('resolveCoreWorkerUrl', () => {
  it('maps dev .ts sources, tsc dist subdirectories (even under a chunks parent), and esbuild chunks accurately', () => {
    const root = path.join(os.tmpdir(), 'chunks', 'x-code-cli')
    const tsCaller = pathToFileURL(path.join(root, 'packages', 'core', 'src', 'agent', 'ingest', 'pdf-ingest.ts')).href
    expect(fileURLToPath(resolveCoreWorkerUrl(tsCaller, 'pdf-render-worker.js'))).toBe(
      path.join(root, 'packages', 'core', 'dist', 'agent', 'ingest', 'pdf-render-worker.js'),
    )

    const tscDistCaller = pathToFileURL(
      path.join(root, 'packages', 'core', 'dist', 'agent', 'ingest', 'pdf-ingest.js'),
    ).href
    expect(fileURLToPath(resolveCoreWorkerUrl(tscDistCaller, 'pdf-render-worker.js'))).toBe(
      path.join(root, 'packages', 'core', 'dist', 'agent', 'ingest', 'pdf-render-worker.js'),
    )

    const esbuildChunkCaller = pathToFileURL(
      path.join(root, 'packages', 'cli', 'dist', 'chunks', 'chunk-ABC123.js'),
    ).href
    expect(fileURLToPath(resolveCoreWorkerUrl(esbuildChunkCaller, 'pdf-render-worker.js'))).toBe(
      path.join(root, 'packages', 'cli', 'dist', 'pdf-render-worker.js'),
    )

    const esbuildMainCaller = pathToFileURL(path.join(root, 'packages', 'cli', 'dist', 'cli.js')).href
    expect(fileURLToPath(resolveCoreWorkerUrl(esbuildMainCaller, 'pdf-render-worker.js'))).toBe(
      path.join(root, 'packages', 'cli', 'dist', 'pdf-render-worker.js'),
    )
  })
})

describe('stableStringify and UTF-8 byte helpers', () => {
  it('normalizes undefined and omitted properties consistently in stableStringify', () => {
    expect(stableStringify(undefined)).toBe('undefined')
    expect(stableStringify({ b: 2, a: 1, optional: undefined })).toBe('{"a":1,"b":2}')
    expect(stableStringify({ a: 1, b: 2 })).toBe('{"a":1,"b":2}')
    expect(stableStringify([1, undefined, 'x'])).toBe('[1,null,"x"]')
  })

  it('splits and prefixes UTF-8 cleanly on multi-byte boundaries', () => {
    expect(splitUtf8ByBytes('中a', 0)).toEqual({ value: '', bytes: 0, rest: '中a' })
    expect(splitUtf8ByBytes('中a', 2)).toEqual({ value: '', bytes: 0, rest: '中a' })
    expect(splitUtf8ByBytes('中a', 3)).toEqual({ value: '中', bytes: 3, rest: 'a' })
    expect(utf8BytePrefix(Buffer.from('中', 'utf8').subarray(0, 2), 2).length).toBe(0)
  })
})
