import { afterEach, describe, expect, it } from 'vitest'

import http from 'node:http'
import net from 'node:net'
import type { AddressInfo, Socket } from 'node:net'

import { createTestWorkspace, runPrintCli } from '../fixtures/cli-test-helpers.js'
import type { TestWorkspace } from '../fixtures/cli-test-helpers.js'
import { startFakeProvider } from '../fixtures/fake-provider-server.js'
import type { FakeProvider } from '../fixtures/fake-provider-server.js'

/** Records the CONNECT target and replays the tunnel against the fake provider.
 *  A recorded line proves the CLI handed the hostname to the proxy instead of
 *  dialling it itself. */
interface RecordingProxy {
  url: string
  tunnels(): string[]
  close(): Promise<void>
}

const cleanups: Array<() => Promise<void>> = []
const workspaces: TestWorkspace[] = []

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()))
  await Promise.allSettled(workspaces.splice(0).map((workspace) => workspace.cleanup()))
})

async function startRecordingProxy(targetBaseUrl: string): Promise<RecordingProxy> {
  const target = new URL(targetBaseUrl)
  const targetPort = Number(target.port)
  const tunnels: string[] = []
  const sockets = new Set<Socket>()

  const server = http.createServer()
  // undici's ProxyAgent tunnels every target through CONNECT, including plain
  // http:// ones, so the tunnel is the only path a provider request can take.
  server.on('connect', (request, clientSocket, head) => {
    tunnels.push(`CONNECT ${request.url ?? ''}`)
    const upstream = net.connect(targetPort, target.hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    tunnels: () => tunnels,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

async function setup(): Promise<{ provider: FakeProvider; workspace: TestWorkspace }> {
  const provider = await startFakeProvider([{ type: 'completion', text: 'proxied-ok' }])
  cleanups.push(provider.close)
  const workspace = await createTestWorkspace('xc-proxy-routing-')
  workspaces.push(workspace)
  return { provider, workspace }
}

describe('provider requests through a terminal proxy', () => {
  it('routes a remote model endpoint through HTTP_PROXY', async () => {
    const { provider, workspace } = await setup()
    const proxy = await startRecordingProxy(provider.baseUrl)
    cleanups.push(proxy.close)

    const result = await runPrintCli({
      workspace,
      provider: { baseUrl: 'http://proxied.invalid/v1' },
      env: { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url },
      prompt: 'hi',
    })

    expect(result.stderr).not.toContain('Network connection failed')
    expect(result.stdout).toContain('proxied-ok')
    expect(proxy.tunnels()).toContain('CONNECT proxied.invalid:80')
    expect(provider.mainRequests().length).toBeGreaterThan(0)
  })

  it('keeps loopback endpoints off the proxy', async () => {
    const { provider, workspace } = await setup()
    const proxy = await startRecordingProxy(provider.baseUrl)
    cleanups.push(proxy.close)

    const result = await runPrintCli({
      workspace,
      provider,
      env: { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url },
      prompt: 'hi',
    })

    expect(result.stdout).toContain('proxied-ok')
    expect(provider.mainRequests().length).toBeGreaterThan(0)
    expect(proxy.tunnels()).toEqual([])
  })
})
