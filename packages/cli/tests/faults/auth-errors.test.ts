import { afterEach, describe, expect, it } from 'vitest'

import { createTestWorkspace, readSessionJsonl, runPrintCli } from '../fixtures/cli-test-helpers.js'
import { startFakeProvider } from '../fixtures/fake-provider-server.js'
import type { FakeProvider } from '../fixtures/fake-provider-server.js'

const providers: FakeProvider[] = []
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(providers.splice(0).map((provider) => provider.close()))
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function runAuthFailure(status: 401 | 403, message: string) {
  const provider = await startFakeProvider([{ type: 'http-error', status, message }])
  providers.push(provider)
  const workspace = await createTestWorkspace(`xc-auth-${status}-`)
  cleanups.push(workspace.cleanup)
  const result = await runPrintCli({ workspace, provider })
  return { provider, result, workspace }
}

describe('authentication failures', () => {
  it('reports 401 once without retrying or leaking credentials', async () => {
    const { provider, result, workspace } = await runAuthFailure(401, 'invalid api key')

    expect(result.exitCode).toBe(1)
    expect(provider.requests()).toHaveLength(1)
    expect(provider.requests()[0]?.authorizationPresent).toBe(true)
    expect(result.stderr).toMatch(/authentication failed|api key|unauthorized/i)
    expect(result.stderr).not.toContain('test-key')
    expect(result.stderr).not.toContain('Authorization')
    expect(result.stderr).not.toMatch(/\n\s+at\s/)
    await expect(readSessionJsonl(workspace.cwd)).resolves.toBeInstanceOf(Array)
  })

  it('reports 403 once without retrying or printing the provider response object', async () => {
    const { provider, result, workspace } = await runAuthFailure(403, 'access forbidden for this account')

    expect(result.exitCode).toBe(1)
    expect(provider.requests()).toHaveLength(1)
    expect(result.stderr).toMatch(/access denied|forbidden|permission/i)
    expect(result.stderr).not.toContain('test-key')
    expect(result.stderr).not.toContain('responseBody')
    expect(result.stderr).not.toMatch(/APICallError|RetryError/)
    await expect(readSessionJsonl(workspace.cwd)).resolves.toBeInstanceOf(Array)
  })
})
