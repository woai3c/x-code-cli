// Tests for `runPluginCli(['update', ...])` — both single-id and --all paths.
//
// The CLI subcommand is wired around the same core `installPlugin` used by
// the slash form, so we don't reverify the install behavior here; we focus
// on the argv-parsing and the --all aggregation: classification (updated /
// unchanged / failed), bare-invocation rejection, and skip-on-error.
//
// Each test runs in an isolated XC_PLUGINS_DIR so installs land in a temp
// cache and don't bleed into the user's real ~/.x-code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { installPlugin, listInstalledPlugins } from '@x-code-cli/core'

import { runPluginCli } from '../src/plugin-cli.js'

let originalPluginsDir: string | undefined
let logSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>

async function makeTempPlugin(body: Record<string, unknown>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-update-src-'))
  await fs.writeFile(path.join(root, 'plugin.json'), JSON.stringify(body), 'utf-8')
  return root
}

function combinedOutput(): string {
  const log = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
  const err = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
  return `${log}\n${err}`
}

beforeEach(async () => {
  originalPluginsDir = process.env.XC_PLUGINS_DIR
  process.env.XC_PLUGINS_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-update-cache-'))
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
  errSpy.mockRestore()
  if (originalPluginsDir === undefined) delete process.env.XC_PLUGINS_DIR
  else process.env.XC_PLUGINS_DIR = originalPluginsDir
})

describe('xc plugin update — argv parsing', () => {
  it('rejects bare `update` invocation with a usage hint that lists both forms', async () => {
    const code = await runPluginCli(['update'])
    expect(code).toBe(1)
    const out = combinedOutput()
    expect(out).toMatch(/Usage:.*update.*<id>.*--all/)
  })

  it('rejects mixing a positional id and --all in the same call', async () => {
    const code = await runPluginCli(['update', 'demo@local', '--all'])
    expect(code).toBe(1)
    expect(combinedOutput()).toMatch(/either `?--all`? or a plugin id, not both/)
  })

  it('errors when the requested single-id plugin is not installed', async () => {
    const code = await runPluginCli(['update', 'nope@local'])
    expect(code).toBe(1)
    expect(combinedOutput()).toMatch(/Plugin 'nope@local' not installed/)
  })
})

describe('xc plugin update --all', () => {
  it("returns 0 and reports 'No plugins installed' when the registry is empty", async () => {
    const code = await runPluginCli(['update', '--all'])
    expect(code).toBe(0)
    expect(combinedOutput()).toMatch(/No plugins installed/)
  })

  it("classifies a same-version re-install as 'unchanged' and returns 0", async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const code = await runPluginCli(['update', '--all'])
    expect(code).toBe(0)
    const out = combinedOutput()
    expect(out).toMatch(/demo@local: reinstalled at 1\.0\.0/)
    expect(out).toMatch(/Summary: 0 updated, 1 unchanged, 0 failed/)
  })

  it("reports a real version bump as 'updated' and returns 0", async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })
    // Bump the source manifest in place — when update reinstalls from the
    // recorded source path it should pick the new version up.
    await fs.writeFile(path.join(src, 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.1.0' }))

    const code = await runPluginCli(['update', '--all'])
    expect(code).toBe(0)
    const out = combinedOutput()
    expect(out).toMatch(/demo@local: 1\.0\.0 → 1\.1\.0/)
    expect(out).toMatch(/Summary: 1 updated, 0 unchanged, 0 failed/)
  })

  it('skips on error: one failing plugin does not abort the others, summary counts failure, exit code is 1', async () => {
    const goodSrc = await makeTempPlugin({ name: 'good', version: '1.0.0' })
    const badSrc = await makeTempPlugin({ name: 'bad', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: goodSrc }, marketplace: 'local' })
    await installPlugin({ source: { kind: 'local', path: badSrc }, marketplace: 'local' })
    // Delete the bad source after install — update path's `installPlugin`
    // will fail to read from a missing dir.
    await fs.rm(badSrc, { recursive: true, force: true })

    const code = await runPluginCli(['update', '--all'])
    expect(code).toBe(1)
    const out = combinedOutput()
    expect(out).toMatch(/Updating 2 plugins/)
    expect(out).toMatch(/good@local: reinstalled at 1\.0\.0/)
    expect(out).toMatch(/bad@local: failed/)
    expect(out).toMatch(/Summary: 0 updated, 1 unchanged, 1 failed/)

    // Both plugins still in the registry — bulk update isn't supposed to
    // remove failed entries, just report them.
    const records = await listInstalledPlugins()
    expect(records.map((r) => r.id).sort()).toEqual(['bad@local', 'good@local'])
  })

  it('accepts -a as an alias for --all', async () => {
    const code = await runPluginCli(['update', '-a'])
    expect(code).toBe(0)
    expect(combinedOutput()).toMatch(/No plugins installed/)
  })
})

describe('xc plugin update <id>', () => {
  it('single-id re-install at the same version returns 0', async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const code = await runPluginCli(['update', 'demo@local'])
    expect(code).toBe(0)
    expect(combinedOutput()).toMatch(/demo@local: reinstalled at 1\.0\.0/)
  })

  it('single-id with broken source returns 1', async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })
    await fs.rm(src, { recursive: true, force: true })

    const code = await runPluginCli(['update', 'demo@local'])
    expect(code).toBe(1)
    expect(combinedOutput()).toMatch(/demo@local: failed/)
  })
})
