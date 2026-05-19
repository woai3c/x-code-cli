import path from 'node:path'

import type { Scenario } from '../framework/types.js'

// Minimal stdio MCP server, inlined as source so the scenario is
// self-contained (no cross-package file references). Implements the
// handful of methods McpClient.connect → listTools → callTool needs;
// the rest are answered with method-not-found so the SDK falls back.
// The `greet` tool stamps an opaque marker into its response so we can
// assert from the assistant text that the call actually round-tripped
// — a plain "Hello, World!" could be hallucinated.
const MOCK_SERVER_SRC = String.raw`#!/usr/bin/env node
let buf = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (line.trim()) try { handle(JSON.parse(line)) } catch (e) { process.stderr.write(String(e) + '\n') }
  }
})
function send(m) { process.stdout.write(JSON.stringify(m) + '\n') }
function handle(msg) {
  const { method, id, params } = msg
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-e2e', version: '1.0.0' } } })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [
      { name: 'greet', description: 'Greet a person by name and return a friendly hello.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }
    ] } })
  } else if (method === 'tools/call') {
    const name = params && params.name
    const args = (params && params.arguments) || {}
    if (name === 'greet') {
      const who = typeof args.name === 'string' ? args.name : 'stranger'
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Hello, ' + who + '! [MCP_MARKER_AB12CD34]' }] } })
    } else if (typeof id !== 'undefined') {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool: ' + name } })
    }
  } else if (method === 'resources/list') {
    send({ jsonrpc: '2.0', id, result: { resources: [] } })
  } else if (typeof id !== 'undefined') {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } })
  }
}
`

const scenario: Scenario = {
  id: '24-mcp-stdio',
  name: 'MCP stdio: model calls mock__greet and quotes the server-stamped marker',
  async run(ctx) {
    // 1. Write the inline mock MCP server into the tmpDir and the user
    //    config that points to it. The harness already isolates
    //    X_CODE_HOME under <tmpDir>/.x-code-home, so the same scenario
    //    can run in parallel without trampling on the real ~/.x-code.
    await ctx.writeFile('mock-server.mjs', MOCK_SERVER_SRC)
    const serverPath = path.join(ctx.tmpDir, 'mock-server.mjs')

    await ctx.mkdir('.x-code-home')
    await ctx.writeFile(
      '.x-code-home/config.json',
      JSON.stringify(
        {
          // X_CODE_MODEL is set by the harness, so we don't need `model`.
          mcpServers: {
            mock: {
              command: process.execPath,
              args: [serverPath],
            },
          },
        },
        null,
        2,
      ),
    )

    // 2. Run the CLI. --trust short-circuits the per-tool ask prompt so
    //    the model can call mock__greet without onAskPermission
    //    blocking print-mode (no UI to answer the dialog).
    const r = await ctx.runCli(
      [
        'There is an MCP server named "mock" connected. It exposes a tool',
        'mock__greet that takes { name: string } and returns a greeting',
        'string. Call it with name="World" and then quote the EXACT text the',
        'tool returned in your reply.',
      ].join(' '),
      { args: ['--trust', '--max-turns', '5'] },
    )

    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'mock__greet', { name: 'World' })
    // The marker is a random-looking token the server stamps in. Models
    // that didn't actually wait for the tool result can't reproduce it.
    ctx.expect.assistantMentions(r, /MCP_MARKER_AB12CD34/)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
