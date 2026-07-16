import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { buildServerPreview, isProjectTrusted, promptForTrust, trustProject } from '../src/mcp/trust.js'

/** Each test gets its own scratch ~/.x-code under tmpdir so we never touch
 *  the developer's real trusted-projects.json. */
function isolate(): string {
  const dir = path.join(os.tmpdir(), 'mcp-trust-test-' + Math.random().toString(36).slice(2))
  process.env.X_CODE_HOME = dir
  return dir
}

describe('trust persistence', () => {
  let home: string
  beforeEach(() => {
    home = isolate()
  })
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('reports untrusted by default', async () => {
    expect(await isProjectTrusted('/some/path')).toBe(false)
  })

  it('normalizes equivalent paths and persists only one trust entry', async () => {
    const project = path.resolve('project')
    await trustProject(project + path.sep)
    await trustProject(project)

    expect(await isProjectTrusted(project)).toBe(true)
    const raw = await fs.readFile(path.join(home, 'trusted-projects.json'), 'utf-8')
    const stored = JSON.parse(raw) as { trusted: Array<{ path: string }> }
    expect(stored.trusted).toEqual([{ path: project, trustedAt: expect.any(String) }])
  })

  it('treats subdirectory as separate from parent', async () => {
    await trustProject('/foo')
    expect(await isProjectTrusted('/foo/sub')).toBe(false)
  })
})

describe('promptForTrust', () => {
  beforeEach(() => isolate())
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('maps "Trust this project" answer to "trust"', async () => {
    const choice = await promptForTrust('/p', [{ name: 's', preview: 'cmd' }], async () => 'Trust this project')
    expect(choice).toBe('trust')
  })

  it('maps "Exit X-Code" answer to "exit"', async () => {
    const choice = await promptForTrust('/p', [{ name: 's', preview: 'cmd' }], async () => 'Exit X-Code')
    expect(choice).toBe('exit')
  })

  it('falls back to skip on any other / unrecognised answer', async () => {
    const choice = await promptForTrust('/p', [{ name: 's', preview: 'cmd' }], async () => '???')
    expect(choice).toBe('skip')
  })
})

describe('buildServerPreview', () => {
  it('renders stdio config as command + args', () => {
    expect(buildServerPreview({ command: 'npx', args: ['-y', 'foo'] })).toBe('npx -y foo')
  })

  it('renders http config as URL', () => {
    expect(buildServerPreview({ url: 'https://x.com' })).toBe('https://x.com')
  })

  it('falls back when neither command nor url is present', () => {
    expect(buildServerPreview({})).toBe('(invalid config)')
  })
})
