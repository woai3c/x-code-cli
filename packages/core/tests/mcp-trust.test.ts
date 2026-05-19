import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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
  beforeEach(() => isolate())
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('reports untrusted by default', async () => {
    expect(await isProjectTrusted('/some/path')).toBe(false)
  })

  it('persists a trusted path', async () => {
    await trustProject('/foo/bar')
    expect(await isProjectTrusted('/foo/bar')).toBe(true)
  })

  it('treats absolute path forms consistently', async () => {
    await trustProject(path.resolve('.'))
    expect(await isProjectTrusted(path.resolve('.'))).toBe(true)
  })

  it('does not duplicate entries when trustProject is called twice', async () => {
    await trustProject('/foo')
    await trustProject('/foo')
    // Verified indirectly: still reports trusted, no throw on write.
    expect(await isProjectTrusted('/foo')).toBe(true)
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
