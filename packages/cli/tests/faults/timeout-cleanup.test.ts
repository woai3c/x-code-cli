import { afterEach, describe, expect, it } from 'vitest'

import net from 'node:net'

import {
  createTestWorkspace,
  isolatedCliEnv,
  readSessionJsonl,
  runPrintCli,
  spawnCli,
  waitFor,
} from '../fixtures/cli-test-helpers.js'
import { startFakeProvider } from '../fixtures/fake-provider-server.js'
import type { FakeProvider } from '../fixtures/fake-provider-server.js'

const providers: FakeProvider[] = []
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(providers.splice(0).map((provider) => provider.close()))
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function setup(responses: Parameters<typeof startFakeProvider>[0]) {
  const provider = await startFakeProvider(responses)
  providers.push(provider)
  const workspace = await createTestWorkspace('xc-timeout-cleanup-')
  cleanups.push(workspace.cleanup)
  return { provider, workspace }
}

async function unusedBaseUrl(): Promise<string> {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${address.port}/v1`
}

describe('server failures and cleanup', () => {
  it('retries a transient 500 and completes successfully', async () => {
    const { provider, workspace } = await setup([
      { type: 'http-error', status: 500 },
      { type: 'completion', text: 'recovered-after-500' },
    ])
    const result = await runPrintCli({ workspace, provider })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('recovered-after-500')
    expect(provider.requests()).toHaveLength(2)
    await waitFor(() => provider.openConnections() === 0, '500 retry sockets to close')
  })

  it('bounds 503 retries and leaves a readable session', async () => {
    const { provider, workspace } = await setup([
      { type: 'http-error', status: 503 },
      { type: 'http-error', status: 503 },
      { type: 'http-error', status: 503 },
      { type: 'http-error', status: 503 },
    ])
    const result = await runPrintCli({ workspace, provider, timeoutMs: 25_000 })

    expect(result.exitCode).toBe(1)
    expect(provider.requests()).toHaveLength(4)
    expect(result.stderr).toContain('Model service unavailable (503)')
    expect(result.stderr).not.toMatch(/RetryError|APICallError|\n\s+at\s/)
    await expect(readSessionJsonl(workspace.cwd)).resolves.toBeInstanceOf(Array)
    await waitFor(() => provider.openConnections() === 0, '503 retry sockets to close')
  })

  it('reports connection refusal without leaking SDK internals', async () => {
    const workspace = await createTestWorkspace('xc-connection-refused-')
    cleanups.push(workspace.cleanup)
    const baseUrl = await unusedBaseUrl()
    const result = await runPrintCli({ workspace, provider: { baseUrl }, timeoutMs: 25_000 })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Network connection failed or was interrupted')
    expect(result.stderr).not.toMatch(/ECONNREFUSED|RetryError|APICallError|\n\s+at\s/)
    await expect(readSessionJsonl(workspace.cwd)).resolves.toBeInstanceOf(Array)
  })

  it('cancels a stalled response and releases the HTTP connection', async () => {
    const { provider, workspace } = await setup([{ type: 'stall', afterHeaders: true }])
    const processUnderTest = spawnCli({
      cwd: workspace.cwd,
      env: isolatedCliEnv(workspace, provider),
      args: ['--print', '--no-plugins', '--no-hooks', '--max-turns', '4', 'hi'],
      timeoutMs: 10_000,
    })
    await provider.waitForRequests(1)

    processUnderTest.kill('SIGINT')
    const result = await processUnderTest.wait()

    expect(result.durationMs).toBeLessThan(5000)
    expect(result.stderr).not.toMatch(/unhandled|RetryError|APICallError/i)
    await waitFor(() => provider.requests()[0]?.cancelled === true, 'stalled request cancellation')
    await waitFor(() => provider.openConnections() === 0, 'stalled connection to close')
    await expect(readSessionJsonl(workspace.cwd)).resolves.toBeInstanceOf(Array)
  })
})
