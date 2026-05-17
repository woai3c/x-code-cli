#!/usr/bin/env node
// Minimal stdio MCP server used by integration tests. Implements just
// enough of the protocol that McpClient can complete a handshake,
// enumerate one tool, and round-trip a callTool / readResource.
//
// Wire format: newline-delimited JSON-RPC 2.0 on stdin/stdout. No batching.

let buf = ''

process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    try {
      handle(JSON.parse(line))
    } catch (err) {
      process.stderr.write(`mock-server parse error: ${err}\n`)
    }
  }
})

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function handle(msg) {
  const { method, id, params } = msg

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'mock-mcp-server', version: '1.0.0' },
      })
      return

    case 'notifications/initialized':
    case 'notifications/cancelled':
      // Notifications have no id → no response.
      return

    case 'tools/list':
      reply(id, {
        tools: [
          {
            name: 'echo',
            description: 'Echo input text back to the caller',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
          {
            name: 'add',
            description: 'Add two numbers',
            inputSchema: {
              type: 'object',
              properties: { a: { type: 'number' }, b: { type: 'number' } },
              required: ['a', 'b'],
            },
          },
        ],
      })
      return

    case 'tools/call': {
      const { name, arguments: args } = params ?? {}
      if (name === 'echo') {
        reply(id, { content: [{ type: 'text', text: String(args?.text ?? '') }] })
      } else if (name === 'add') {
        const sum = Number(args?.a ?? 0) + Number(args?.b ?? 0)
        reply(id, { content: [{ type: 'text', text: String(sum) }] })
      } else if (name === 'boom') {
        reply(id, { content: [{ type: 'text', text: 'simulated error' }], isError: true })
      } else {
        error(id, -32601, `Unknown tool: ${name}`)
      }
      return
    }

    case 'resources/list':
      reply(id, {
        resources: [{ uri: 'mock://hello', name: 'hello.txt', description: 'a greeting', mimeType: 'text/plain' }],
      })
      return

    case 'resources/read': {
      const uri = params?.uri
      if (uri === 'mock://hello') {
        reply(id, { contents: [{ uri, mimeType: 'text/plain', text: 'hello world' }] })
      } else {
        error(id, -32602, `Unknown resource: ${uri}`)
      }
      return
    }

    case 'ping':
      reply(id, {})
      return

    default:
      // SDK probes for some optional methods (logging/setLevel,
      // resources/subscribe, …). Respond with method-not-found so the
      // SDK falls back gracefully rather than hanging on a missing reply.
      if (typeof id !== 'undefined') {
        error(id, -32601, `Method not found: ${method}`)
      }
  }
}
