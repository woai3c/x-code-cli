import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  detectScope,
  getConfigPath,
  readServerConfig,
  removeServerFromConfig,
  serverExists,
  writeServerToConfig,
} from '../src/mcp/config-writer.js'

/** Each test gets its own scratch ~/.x-code under tmpdir, plus a scratch
 *  project dir. We never touch the developer's real config.json. */
function isolate(): { home: string; project: string } {
  const home = path.join(os.tmpdir(), 'mcp-writer-home-' + Math.random().toString(36).slice(2))
  const project = path.join(os.tmpdir(), 'mcp-writer-proj-' + Math.random().toString(36).slice(2))
  process.env.X_CODE_HOME = home
  return { home, project }
}

async function readJson(file: string): Promise<unknown> {
  const raw = await fs.readFile(file, 'utf-8')
  return JSON.parse(raw)
}

describe('config-writer: user scope', () => {
  let ctx: { home: string; project: string }
  beforeEach(() => {
    ctx = isolate()
  })
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('writes a new server when config.json does not exist', async () => {
    const res = await writeServerToConfig('sentry', { url: 'https://mcp.sentry.dev/mcp' }, 'user', ctx.project)
    expect(res.path).toBe(getConfigPath('user', ctx.project))
    const written = (await readJson(res.path)) as { mcpServers: Record<string, unknown> }
    expect(written.mcpServers).toEqual({ sentry: { url: 'https://mcp.sentry.dev/mcp' } })
  })

  it('preserves unrelated top-level fields', async () => {
    const p = getConfigPath('user', ctx.project)
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, JSON.stringify({ theme: 'dark', model: 'anthropic:foo' }), 'utf-8')
    await writeServerToConfig('fs', { command: 'node', args: ['s.js'] }, 'user', ctx.project)
    const data = (await readJson(p)) as Record<string, unknown>
    expect(data.theme).toBe('dark')
    expect(data.model).toBe('anthropic:foo')
    expect(data.mcpServers).toEqual({ fs: { command: 'node', args: ['s.js'] } })
  })

  it('preserves sibling mcpServers entries when adding', async () => {
    await writeServerToConfig('a', { command: 'node', args: ['a.js'] }, 'user', ctx.project)
    await writeServerToConfig('b', { url: 'https://b.com/mcp' }, 'user', ctx.project)
    const data = (await readJson(getConfigPath('user', ctx.project))) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(data.mcpServers).sort()).toEqual(['a', 'b'])
  })

  it('overwrites the named server in-place (caller checks duplicates)', async () => {
    await writeServerToConfig('s', { command: 'one' }, 'user', ctx.project)
    await writeServerToConfig('s', { command: 'two' }, 'user', ctx.project)
    const data = (await readJson(getConfigPath('user', ctx.project))) as {
      mcpServers: Record<string, { command: string }>
    }
    expect(data.mcpServers.s.command).toBe('two')
  })

  it('rejects an invalid config (schema validation runs before write)', async () => {
    await expect(
      writeServerToConfig('s', { command: 'node', url: 'https://x.com' } as never, 'user', ctx.project),
    ).rejects.toThrow(/both.*command.*url/)
    // And no file should have been created.
    await expect(fs.stat(getConfigPath('user', ctx.project))).rejects.toBeTruthy()
  })

  it('throws on a corrupt config.json instead of overwriting', async () => {
    const p = getConfigPath('user', ctx.project)
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, '{this is not json', 'utf-8')
    await expect(writeServerToConfig('s', { command: 'node' }, 'user', ctx.project)).rejects.toThrow(/not valid JSON/)
  })
})

describe('config-writer: project scope', () => {
  let ctx: { home: string; project: string }
  beforeEach(() => {
    ctx = isolate()
  })
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('writes to <project>/.x-code/config.json', async () => {
    const res = await writeServerToConfig('foo', { command: 'node', args: ['f.js'] }, 'project', ctx.project)
    expect(res.path).toContain(path.join('.x-code', 'config.json'))
    expect(res.path.startsWith(ctx.project)).toBe(true)
  })

  it('does not affect user-scope config', async () => {
    await writeServerToConfig('user-srv', { command: 'a' }, 'user', ctx.project)
    await writeServerToConfig('proj-srv', { command: 'b' }, 'project', ctx.project)
    expect(await serverExists('user-srv', 'user', ctx.project)).toBe(true)
    expect(await serverExists('user-srv', 'project', ctx.project)).toBe(false)
    expect(await serverExists('proj-srv', 'project', ctx.project)).toBe(true)
    expect(await serverExists('proj-srv', 'user', ctx.project)).toBe(false)
  })
})

describe('config-writer: remove', () => {
  let ctx: { home: string; project: string }
  beforeEach(() => {
    ctx = isolate()
  })
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('removes a present server', async () => {
    await writeServerToConfig('s', { command: 'node' }, 'user', ctx.project)
    const r = await removeServerFromConfig('s', 'user', ctx.project)
    expect(r.removed).toBe(true)
    expect(await serverExists('s', 'user', ctx.project)).toBe(false)
  })

  it('is idempotent when the server is missing', async () => {
    const r = await removeServerFromConfig('nope', 'user', ctx.project)
    expect(r.removed).toBe(false)
  })

  it('is idempotent when the file does not exist', async () => {
    const r = await removeServerFromConfig('nope', 'project', ctx.project)
    expect(r.removed).toBe(false)
  })

  it('preserves siblings and unrelated fields', async () => {
    const p = getConfigPath('user', ctx.project)
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(
      p,
      JSON.stringify({
        theme: 'dark',
        mcpServers: { a: { command: 'a' }, b: { command: 'b' }, c: { command: 'c' } },
      }),
      'utf-8',
    )
    const r = await removeServerFromConfig('b', 'user', ctx.project)
    expect(r.removed).toBe(true)
    const data = (await readJson(p)) as { theme: string; mcpServers: Record<string, unknown> }
    expect(data.theme).toBe('dark')
    expect(Object.keys(data.mcpServers).sort()).toEqual(['a', 'c'])
  })

  it('leaves mcpServers as an empty object when the last entry is removed', async () => {
    await writeServerToConfig('only', { command: 'node' }, 'user', ctx.project)
    await removeServerFromConfig('only', 'user', ctx.project)
    const data = (await readJson(getConfigPath('user', ctx.project))) as {
      mcpServers: Record<string, unknown>
    }
    expect(data.mcpServers).toEqual({})
  })
})

describe('config-writer: detectScope', () => {
  let ctx: { home: string; project: string }
  beforeEach(() => {
    ctx = isolate()
  })
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('returns not-found when missing everywhere', async () => {
    expect((await detectScope('nope', ctx.project)).kind).toBe('not-found')
  })

  it('returns user when only present in user scope', async () => {
    await writeServerToConfig('s', { command: 'x' }, 'user', ctx.project)
    expect((await detectScope('s', ctx.project)).kind).toBe('user')
  })

  it('returns project when only present in project scope', async () => {
    await writeServerToConfig('s', { command: 'x' }, 'project', ctx.project)
    expect((await detectScope('s', ctx.project)).kind).toBe('project')
  })

  it('returns both when present in both scopes', async () => {
    await writeServerToConfig('s', { command: 'x' }, 'user', ctx.project)
    await writeServerToConfig('s', { command: 'y' }, 'project', ctx.project)
    expect((await detectScope('s', ctx.project)).kind).toBe('both')
  })
})

describe('config-writer: readServerConfig', () => {
  let ctx: { home: string; project: string }
  beforeEach(() => {
    ctx = isolate()
  })
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('returns the stored config object', async () => {
    await writeServerToConfig('s', { command: 'node', args: ['a'] }, 'user', ctx.project)
    expect(await readServerConfig('s', 'user', ctx.project)).toEqual({ command: 'node', args: ['a'] })
  })

  it('returns null for missing servers', async () => {
    expect(await readServerConfig('nope', 'user', ctx.project)).toBeNull()
  })
})
