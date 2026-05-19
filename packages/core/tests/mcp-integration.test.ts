// Integration test for the MCP stack — wires McpClient up to a real
// child process implementing a minimal stdio MCP server, then exercises
// connect → listTools → callTool → readResource → close end-to-end.
//
// Why a custom mock and not `@modelcontextprotocol/server-filesystem`:
//   - the official server pulls in a few hundred KB of deps via npx
//     install on first run; flaky in CI without a warm cache
//   - we want deterministic tool/resource shapes for assertions
//   - fits in 100 lines, lives next to the test that uses it
import { describe, expect, it } from 'vitest'

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { McpClient } from '../src/mcp/client.js'
import { loadMcpServers } from '../src/mcp/loader.js'
import { buildCallableName } from '../src/mcp/name-mangling.js'
import { McpRegistry } from '../src/mcp/registry.js'
import type { McpServerConfig } from '../src/mcp/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MOCK_SERVER = path.join(__dirname, 'fixtures', 'mock-mcp-server.mjs')

describe('MCP integration (stdio)', () => {
  it('connect → list tools → call tool → close', async () => {
    const client = new McpClient('mock', {
      command: process.execPath,
      args: [MOCK_SERVER],
    })
    try {
      const info = await client.connect()
      expect(info.toolCount).toBe(2)
      const tools = client.tools()
      expect(tools.map((t) => t.name).sort()).toEqual(['add', 'echo'])

      const echoed = await client.callTool('echo', { text: 'hello' })
      expect(echoed.isError).toBe(false)
      expect(echoed.text).toBe('hello')

      const summed = await client.callTool('add', { a: 2, b: 3 })
      expect(summed.text).toBe('5')
    } finally {
      await client.close()
    }
  }, 15_000)

  it('reads resources end-to-end', async () => {
    const client = new McpClient('mock', { command: process.execPath, args: [MOCK_SERVER] })
    try {
      await client.connect()
      const resources = client.resources()
      expect(resources).toHaveLength(1)
      expect(resources[0].uri).toBe('mock://hello')

      const content = await client.readResource('mock://hello')
      expect(content.text).toBe('hello world')
      expect(content.mimeType).toBe('text/plain')
    } finally {
      await client.close()
    }
  }, 15_000)

  it('surfaces server-reported errors via isError', async () => {
    const client = new McpClient('mock', { command: process.execPath, args: [MOCK_SERVER] })
    try {
      await client.connect()
      const r = await client.callTool('boom', {})
      expect(r.isError).toBe(true)
    } finally {
      await client.close()
    }
  }, 15_000)

  it('restartServer reconnects a stdio server in place', async () => {
    // Bootstrap a real registry via the loader so configs + oauthFactory
    // wiring is exercised end-to-end. The loader spawns the mock server,
    // enumerates `echo` + `add`, and returns a registry whose configs
    // map remembers the launch config — restartServer() reads from there.
    const { registry } = await loadMcpServers({
      userServers: {
        mock: { command: process.execPath, args: [MOCK_SERVER] },
      },
      projectServers: undefined,
      projectPath: process.cwd(),
      askUser: async () => 'skip',
    })
    try {
      const before = registry
        .list()
        .map((t) => t.callableName)
        .sort()
      expect(before).toContain('mock__echo')

      const restarted = await registry.restartServer('mock')
      expect(restarted.status.kind).toBe('connected')

      // Tool list should be the same after a reconnect against the same
      // server — we're verifying the registry rebuilt cleanly, not that
      // the server changed its surface.
      const after = registry
        .list()
        .map((t) => t.callableName)
        .sort()
      expect(after).toEqual(before)

      // Verify the new client (not the old, now-closed one) handles calls.
      const r = await registry.callTool('mock__echo', { text: 'after-restart' })
      expect(r.text).toBe('after-restart')
    } finally {
      await registry.shutdown()
    }
  }, 20_000)

  it('restartAll diffs added / removed / changed servers', async () => {
    // Boot with one server, then restartAll with a different config set:
    //   - 'mock' stays (with the same config)        → unchanged
    //   - 'mock-b' is new                            → added
    //   - 'mock-old' would've been there but isn't   → (n/a — wasn't booted)
    // Then a second restartAll removes 'mock-b' to exercise the removed path.
    const { registry } = await loadMcpServers({
      userServers: {
        mock: { command: process.execPath, args: [MOCK_SERVER] },
      },
      projectServers: undefined,
      projectPath: process.cwd(),
      askUser: async () => 'skip',
    })
    try {
      // restartAll with `mock` unchanged + new `mock-b`
      const configs1 = new Map<string, McpServerConfig>([
        ['mock', { command: process.execPath, args: [MOCK_SERVER] }],
        ['mock-b', { command: process.execPath, args: [MOCK_SERVER] }],
      ])
      const summary1 = await registry.restartAll(configs1)
      expect(summary1.added).toEqual(['mock-b'])
      expect(summary1.removed).toEqual([])
      expect(summary1.unchanged).toEqual(['mock'])

      // Now both connected — tool list spans both servers.
      const names = registry
        .list()
        .map((t) => t.callableName)
        .sort()
      expect(names).toContain('mock__echo')
      expect(names).toContain('mock_b__echo')

      // Second restartAll: remove mock-b, change mock's args slightly.
      const configs2 = new Map<string, McpServerConfig>([
        ['mock', { command: process.execPath, args: [MOCK_SERVER], timeout: 15_000 }],
      ])
      const summary2 = await registry.restartAll(configs2)
      expect(summary2.added).toEqual([])
      expect(summary2.removed).toEqual(['mock-b'])
      expect(summary2.changed).toEqual(['mock'])

      // mock-b should no longer appear in the tool surface.
      const afterRemoval = registry
        .list()
        .map((t) => t.callableName)
        .sort()
      expect(afterRemoval).not.toContain('mock_b__echo')
      expect(afterRemoval).toContain('mock__echo')
    } finally {
      await registry.shutdown()
    }
  }, 30_000)

  it('authenticateServer rejects stdio servers', async () => {
    const { registry } = await loadMcpServers({
      userServers: {
        mock: { command: process.execPath, args: [MOCK_SERVER] },
      },
      projectServers: undefined,
      projectPath: process.cwd(),
      askUser: async () => 'skip',
    })
    try {
      await expect(registry.authenticateServer('mock')).rejects.toThrow(/stdio/i)
    } finally {
      await registry.shutdown()
    }
  }, 15_000)

  it('registry dispatches by callable name', async () => {
    const client = new McpClient('mock', { command: process.execPath, args: [MOCK_SERVER] })
    try {
      await client.connect()
      const taken = new Set<string>()
      const tools = client.tools().map((t) => ({
        callableName: buildCallableName('mock', t.name, taken),
        rawName: t.name,
        serverName: 'mock',
        description: t.description ?? '',
        inputSchema: t.inputSchema,
      }))
      for (const t of tools) taken.add(t.callableName)

      const registry = new McpRegistry({
        servers: [{ name: 'mock', client, status: { kind: 'connected', toolCount: 2, resourceCount: 1 } }],
        tools,
        resources: [],
      })

      // Verify dispatch goes through the registry's callTool wrapper.
      const callable = tools.find((t) => t.rawName === 'echo')!.callableName
      const result = await registry.callTool(callable, { text: 'via registry' })
      expect(result.text).toBe('via registry')
    } finally {
      await client.close()
    }
  }, 15_000)
})
