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
import { buildCallableName } from '../src/mcp/name-mangling.js'
import { McpRegistry } from '../src/mcp/registry.js'

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
