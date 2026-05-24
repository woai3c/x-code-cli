// Tests for plugin manifest discovery + parsing
import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ManifestParseError, discoverManifest, parseManifest } from '../src/plugins/manifest.js'

async function makeTempPluginDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-test-'))
}

async function writeManifest(rootDir: string, rel: string, body: unknown): Promise<string> {
  const full = path.join(rootDir, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, JSON.stringify(body, null, 2), 'utf-8')
  return full
}

describe('discoverManifest', () => {
  it('returns null when no manifest exists', async () => {
    const root = await makeTempPluginDir()
    expect(await discoverManifest(root)).toBeNull()
  })

  it('finds .x-code-plugin/plugin.json (native, highest priority)', async () => {
    const root = await makeTempPluginDir()
    const expected = await writeManifest(root, '.x-code-plugin/plugin.json', { name: 'foo', version: '1.0.0' })
    // Also write a competing claude manifest — native must still win.
    await writeManifest(root, '.claude-plugin/plugin.json', { name: 'foo', version: '1.0.0' })

    const result = await discoverManifest(root)
    expect(result).toEqual({ manifestPath: expected, format: 'native' })
  })

  it('finds .claude-plugin/plugin.json (Claude Code compat)', async () => {
    const root = await makeTempPluginDir()
    const expected = await writeManifest(root, '.claude-plugin/plugin.json', { name: 'foo', version: '1.0.0' })

    const result = await discoverManifest(root)
    expect(result).toEqual({ manifestPath: expected, format: 'claude' })
  })

  it('flags gemini-extension.json as unsupported (not silently ignored)', async () => {
    const root = await makeTempPluginDir()
    const expected = await writeManifest(root, 'gemini-extension.json', { name: 'foo', version: '1.0.0' })

    const result = await discoverManifest(root)
    expect(result).toEqual({ manifestPath: expected, format: 'gemini' })
  })
})

describe('parseManifest', () => {
  it('parses a minimal valid manifest', async () => {
    const root = await makeTempPluginDir()
    const file = await writeManifest(root, 'plugin.json', { name: 'foo', version: '1.0.0' })

    const manifest = await parseManifest(file)
    expect(manifest).toMatchObject({
      schemaVersion: '1',
      name: 'foo',
      version: '1.0.0',
    })
  })

  it('accepts inline mcpServers and hooks objects', async () => {
    const root = await makeTempPluginDir()
    const file = await writeManifest(root, 'plugin.json', {
      name: 'foo',
      version: '1.0.0',
      mcpServers: { my_server: { command: 'node', args: ['server.js'] } },
      hooks: { PreToolUse: [{ command: 'lint.sh' }] },
    })

    const manifest = await parseManifest(file)
    expect(typeof manifest.mcpServers).toBe('object')
    expect(typeof manifest.hooks).toBe('object')
  })

  it('normalises string author to object form', async () => {
    const root = await makeTempPluginDir()
    const file = await writeManifest(root, 'plugin.json', {
      name: 'foo',
      version: '1.0.0',
      author: 'Some Author',
    })

    const manifest = await parseManifest(file)
    expect(manifest.author).toEqual({ name: 'Some Author' })
  })

  it('silently strips unknown top-level fields (forward compat)', async () => {
    const root = await makeTempPluginDir()
    const file = await writeManifest(root, 'plugin.json', {
      name: 'foo',
      version: '1.0.0',
      // Claude Code-only fields we don't implement — must not reject.
      'output-styles': './styles',
      lspServers: { foo: { command: 'lsp' } },
      unknownFutureField: 42,
    })

    const manifest = await parseManifest(file)
    expect(manifest.name).toBe('foo')
    // Unknown fields are dropped.
    expect((manifest as Record<string, unknown>)['output-styles']).toBeUndefined()
    expect((manifest as Record<string, unknown>).lspServers).toBeUndefined()
  })

  it('rejects invalid name (uppercase)', async () => {
    const root = await makeTempPluginDir()
    const file = await writeManifest(root, 'plugin.json', { name: 'Foo', version: '1.0.0' })

    await expect(parseManifest(file)).rejects.toBeInstanceOf(ManifestParseError)
  })

  it('rejects malformed JSON with a path-tagged error', async () => {
    const root = await makeTempPluginDir()
    const file = path.join(root, 'plugin.json')
    await fs.writeFile(file, '{ not json', 'utf-8')

    await expect(parseManifest(file)).rejects.toBeInstanceOf(ManifestParseError)
  })
})
