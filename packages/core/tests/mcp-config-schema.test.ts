import { describe, expect, it } from 'vitest'

import { mcpServersSchema, parseServerConfig, parseServersBlock } from '../src/mcp/config-schema.js'

describe('parseServerConfig', () => {
  it('accepts a valid stdio config', () => {
    const cfg = parseServerConfig('filesystem', {
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { FOO: 'bar' },
    })
    expect(cfg).toMatchObject({ command: 'npx', args: ['-y', 'pkg'], env: { FOO: 'bar' } })
  })

  it('accepts a valid http config', () => {
    const cfg = parseServerConfig('sentry', { url: 'https://mcp.example.com' })
    expect(cfg).toMatchObject({ url: 'https://mcp.example.com' })
  })

  it('rejects config with neither command nor url', () => {
    expect(() => parseServerConfig('bad', { timeout: 100 })).toThrow(/either `command`.*or `url`/)
  })

  it('rejects config with both command and url', () => {
    expect(() => parseServerConfig('bad', { command: 'foo', url: 'https://x.com' })).toThrow(/both `command` and `url`/)
  })

  it('rejects malformed url', () => {
    expect(() => parseServerConfig('bad', { url: 'not-a-url' })).toThrow()
  })

  it('rejects unsupported URL protocols and unknown fields', () => {
    expect(() => parseServerConfig('bad', { url: 'file:///tmp/socket' })).toThrow(/http or https/)
    expect(() => parseServerConfig('bad', { command: 'node', typo: true })).toThrow(/Unrecognized key/)
  })

  it('includes the server name in the error message', () => {
    expect(() => parseServerConfig('myserver', {})).toThrow(/mcpServers\.myserver/)
  })

  it('caps the number of configured servers', () => {
    const entries = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`server-${index}`, { command: process.execPath }]),
    )
    expect(() => mcpServersSchema.parse(entries)).toThrow(/at most 128 MCP servers/i)
  })
})

describe('parseServersBlock', () => {
  it('returns empty result for undefined input', () => {
    const r = parseServersBlock(undefined)
    expect(r.servers).toEqual({})
    expect(r.errors).toEqual([])
  })

  it('parses multiple servers and isolates errors', () => {
    const r = parseServersBlock({
      good: { command: 'npx' },
      bad: { timeout: 100 },
      alsoGood: { url: 'https://example.com' },
    })
    expect(Object.keys(r.servers).sort()).toEqual(['alsoGood', 'good'])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].name).toBe('bad')
  })
})
