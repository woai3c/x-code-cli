import { afterEach, describe, expect, it } from 'vitest'

import { createTestWorkspace, isolatedCliEnv, runPrintCli, spawnCli, waitFor } from '../fixtures/cli-test-helpers.js'
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
  const workspace = await createTestWorkspace('xc-rate-limit-')
  cleanups.push(workspace.cleanup)
  return { provider, workspace }
}

describe('rate limits', () => {
  it('retries a 429 with Retry-After and succeeds within the bounded attempt count', async () => {
    const { provider, workspace } = await setup([
      { type: 'http-error', status: 429, retryAfterMs: 50 },
      { type: 'completion', text: 'recovered' },
    ])
    const result = await runPrintCli({ workspace, provider })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('recovered')
    expect(provider.requests()).toHaveLength(2)
    expect(provider.requests()[1]!.receivedAt - provider.requests()[0]!.receivedAt).toBeGreaterThanOrEqual(40)
  })

  it('uses bounded backoff for a 429 without Retry-After', async () => {
    const { provider, workspace } = await setup([
      { type: 'http-error', status: 429 },
      { type: 'completion', text: 'recovered-without-header' },
    ])
    const result = await runPrintCli({ workspace, provider })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('recovered-without-header')
    expect(provider.requests()).toHaveLength(2)
    expect(result.stderr).not.toMatch(/RetryError|APICallError/)
  })

  it('aborts a pending 429 retry without sending another request', async () => {
    const { provider, workspace } = await setup([
      { type: 'http-error', status: 429 },
      { type: 'http-error', status: 429 },
      { type: 'http-error', status: 429 },
      { type: 'http-error', status: 429 },
    ])
    const process = spawnCli({
      cwd: workspace.cwd,
      env: isolatedCliEnv(workspace, provider),
      args: ['--print', '--no-plugins', '--no-hooks', '--max-turns', '4', 'hi'],
    })

    await provider.waitForRequests(1)
    process.kill('SIGINT')
    const result = await process.wait()
    const countAtExit = provider.requests().length
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(result.exitCode === 0 || result.exitCode === 130 || result.signal === 'SIGINT').toBe(true)
    expect(provider.requests()).toHaveLength(countAtExit)
    expect(countAtExit).toBe(1)
    await waitFor(() => provider.openConnections() === 0, 'provider connections to close')
  })
})
