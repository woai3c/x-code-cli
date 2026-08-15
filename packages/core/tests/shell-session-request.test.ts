import fs from 'node:fs/promises'
import path from 'node:path'

import {
  normalizeHardTimeout,
  normalizeInitialWait,
  normalizeInteractWait,
  normalizeMaxOutputTokens,
  normalizeTerminalResize,
  resolveShellCwd,
} from '../src/tools/shell-session/request.js'

describe('shell session request normalization', () => {
  it('preserves immediate sentinels before applying platform floors', () => {
    expect(normalizeInitialWait({ yieldTimeMs: 0 }, 'win32')).toEqual({ kind: 'immediate' })
    expect(normalizeInitialWait({ runInBackground: true }, 'win32')).toEqual({ kind: 'immediate' })
  })

  it('clamps positive initial waits by platform', () => {
    expect(normalizeInitialWait({ yieldTimeMs: 1 }, 'linux')).toEqual({ kind: 'timed', ms: 250 })
    expect(normalizeInitialWait({ yieldTimeMs: 1 }, 'win32')).toEqual({ kind: 'timed', ms: 10_000 })
    expect(normalizeInitialWait({ yieldTimeMs: 100_000 }, 'darwin')).toEqual({ kind: 'timed', ms: 30_000 })
    expect(normalizeInitialWait({}, 'linux')).toEqual({ kind: 'timed', ms: 10_000 })
  })

  it('gives explicit yieldTimeMs precedence over runInBackground', () => {
    expect(normalizeInitialWait({ yieldTimeMs: 5_000, runInBackground: true }, 'linux')).toEqual({
      kind: 'timed',
      ms: 5_000,
    })
  })

  it('maps legacy and current interaction waits without conflating omission and false', () => {
    expect(normalizeInteractWait({}, false)).toEqual({ kind: 'timed', ms: 5_000 })
    expect(normalizeInteractWait({ block: false }, false)).toEqual({ kind: 'immediate' })
    expect(normalizeInteractWait({ block: true }, false)).toEqual({ kind: 'timed', ms: 30_000 })
    expect(normalizeInteractWait({ block: true, timeout: 0 }, false)).toEqual({ kind: 'immediate' })
    expect(normalizeInteractWait({ block: false, yieldTimeMs: 8_000 }, false)).toEqual({ kind: 'timed', ms: 8_000 })
    expect(normalizeInteractWait({}, true)).toEqual({ kind: 'timed', ms: 250 })
    expect(normalizeInteractWait({ yieldTimeMs: 100_000 }, true)).toEqual({ kind: 'timed', ms: 30_000 })
  })

  it('rejects non-integer public numeric values and invalid hard timeouts', () => {
    expect(() => normalizeInitialWait({ yieldTimeMs: -1 }, 'linux')).toThrow(/safe integer/)
    expect(() => normalizeInitialWait({ yieldTimeMs: 1.5 }, 'linux')).toThrow(/safe integer/)
    expect(() => normalizeInteractWait({ timeout: Number.POSITIVE_INFINITY }, false)).toThrow(/safe integer/)
    expect(() => normalizeHardTimeout(0)).toThrow(/between 1/)
    expect(() => normalizeHardTimeout(2_147_483_648)).toThrow(/2147483647/)
    expect(() => normalizeMaxOutputTokens(0)).toThrow(/between 1/)
  })

  it('normalizes paired PTY dimensions and rejects partial or unsafe resize requests', () => {
    expect(normalizeTerminalResize(undefined, undefined)).toBeUndefined()
    expect(normalizeTerminalResize(120, 40)).toEqual({ cols: 120, rows: 40 })
    expect(() => normalizeTerminalResize(120, undefined)).toThrow(/provided together/)
    expect(() => normalizeTerminalResize(0, 40)).toThrow(/between 1/)
    expect(() => normalizeTerminalResize(1_001, 40)).toThrow(/1000/)
  })
})

describe('resolveShellCwd', () => {
  it('resolves relative paths from the captured project cwd and canonicalizes them', async () => {
    const expected = await fs.realpath(path.join(process.cwd(), 'packages/core'))
    await expect(resolveShellCwd(process.cwd(), 'packages/core')).resolves.toBe(expected)
  })

  it('rejects files, missing directories, and NUL bytes', async () => {
    await expect(resolveShellCwd(process.cwd(), 'package.json')).rejects.toThrow(/not a directory/)
    await expect(resolveShellCwd(process.cwd(), 'definitely-missing-directory')).rejects.toThrow(/Invalid shell cwd/)
    await expect(resolveShellCwd(process.cwd(), 'bad\0cwd')).rejects.toThrow(/NUL/)
  })
})
