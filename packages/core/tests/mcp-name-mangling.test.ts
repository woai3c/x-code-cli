import { describe, expect, it } from 'vitest'

import { MCP_MAX_NAME_LEN, MCP_PREFIX, buildCallableName, isMcpCallableName } from '../src/mcp/name-mangling.js'

describe('buildCallableName', () => {
  it('produces mcp__<server>__<tool> for clean inputs', () => {
    const name = buildCallableName('filesystem', 'read_file', new Set())
    expect(name).toBe('mcp__filesystem__read_file')
  })

  it('sanitises disallowed chars to underscore', () => {
    const name = buildCallableName('my-server.v2', 'foo:bar', new Set())
    // Hyphens, dots, colons → "_"; runs collapse to a single underscore
    expect(name).toBe('mcp__my_server_v2__foo_bar')
  })

  it('falls back to hash when sanitisation empties a part', () => {
    // All-CJK server name has no [A-Za-z0-9_] chars — must still produce
    // a valid, unique identifier rather than `mcp____tool`.
    const name = buildCallableName('文件系统', 'read', new Set())
    expect(name).toMatch(/^mcp__[a-f0-9]{6}__read$/)
  })

  it('keeps the prefix and stays under the 64-char cap', () => {
    const longServer = 'x'.repeat(40)
    const longTool = 'y'.repeat(40)
    const name = buildCallableName(longServer, longTool, new Set())
    expect(name.length).toBeLessThanOrEqual(MCP_MAX_NAME_LEN)
    expect(name.startsWith(MCP_PREFIX)).toBe(true)
  })

  it('disambiguates collisions across servers', () => {
    const taken = new Set<string>()
    const a = buildCallableName('serverA', 'read', taken)
    taken.add(a)
    // Same tool name on a "different" server that sanitises to the same id
    const b = buildCallableName('serverA', 'read', taken)
    expect(a).not.toBe(b)
    expect(b.startsWith(a)).toBe(true) // collision suffix appended
  })

  it('always produces a unique name even on repeated collisions', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const name = buildCallableName('s', 't', taken)
      expect(taken.has(name)).toBe(false)
      taken.add(name)
    }
    expect(taken.size).toBe(5)
  })
})

describe('isMcpCallableName', () => {
  it('detects the prefix', () => {
    expect(isMcpCallableName('mcp__a__b')).toBe(true)
    expect(isMcpCallableName('readFile')).toBe(false)
    expect(isMcpCallableName('mcpFoo')).toBe(false) // single underscore — not ours
  })
})
