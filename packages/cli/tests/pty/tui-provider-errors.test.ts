import { describe, expect, it } from 'vitest'

import { waitFor } from '../fixtures/cli-test-helpers.js'
import { submitInput, typeInput, withTui } from './test-context.js'

describe('TUI provider error recovery', () => {
  it('shows a safe 401 error and accepts the next prompt', async () => {
    await withTui(
      'provider-401',
      [
        { type: 'http-error', status: 401, message: 'invalid test credential' },
        { type: 'completion', text: 'recovered-after-401' },
      ],
      async ({ harness, provider }) => {
        await submitInput(harness, 'hi')
        await harness.waitForScreen(
          (screen) => screen.includes('Error: API authentication failed (401)'),
          'actionable 401 error',
        )
        expect(provider.mainRequests()).toHaveLength(1)
        expect(harness.raw()).not.toContain('test-key')
        expect(harness.raw()).not.toMatch(/AI_APICallError|RetryError/)

        await submitInput(harness, 'hi')
        await harness.waitForText('recovered-after-401')
      },
    )
  })

  it('shows a safe 403 error and remains interactive', async () => {
    await withTui(
      'provider-403',
      [
        { type: 'http-error', status: 403, message: 'forbidden test account' },
        { type: 'completion', text: 'recovered-after-403' },
      ],
      async ({ harness, provider }) => {
        await submitInput(harness, 'hi')
        await harness.waitForScreen(
          (screen) => screen.includes('Error: API access forbidden (403)'),
          'actionable 403 error',
        )
        expect(provider.mainRequests()).toHaveLength(1)
        expect(harness.raw()).not.toContain('test-key')
        expect(harness.raw()).not.toMatch(/AI_APICallError|responseBody/)

        await submitInput(harness, 'hi')
        await harness.waitForText('recovered-after-403')
        await typeInput(harness, 'still-interactive')
      },
    )
  })

  it('retries a transient 429 with Retry-After and recovers in place', async () => {
    await withTui(
      'provider-429',
      [
        { type: 'http-error', status: 429, retryAfterMs: 50 },
        { type: 'completion', text: 'recovered-after-429' },
      ],
      async ({ harness, provider }) => {
        await submitInput(harness, 'hi')
        await harness.waitForText('recovered-after-429')
        const requests = provider.mainRequests()
        expect(requests).toHaveLength(2)
        expect(requests[1]!.receivedAt - requests[0]!.receivedAt).toBeGreaterThanOrEqual(40)
        expect(harness.raw()).not.toMatch(/RetryError|AI_APICallError/)
        await typeInput(harness, 'after-rate-limit')
      },
    )
  })

  it('escapes a stalled provider request, closes its socket, and recovers', async () => {
    await withTui(
      'provider-stall',
      [
        { type: 'stall', afterHeaders: true },
        { type: 'completion', text: 'recovered-after-stall' },
      ],
      async ({ harness, provider }) => {
        await submitInput(harness, 'hi')
        await provider.waitForMainRequests(1)
        await harness.waitForText('Thinking')
        harness.key('escape')
        await waitFor(() => provider.mainRequests()[0]?.cancelled === true, 'stalled TUI request cancellation')
        await waitFor(() => provider.openConnections() === 0, 'stalled TUI socket cleanup')
        await harness.waitForScreen(
          (screen) => screen.includes('[Request interrupted by user]') && !screen.includes('Thinking'),
          'idle input after stalled request',
        )

        await submitInput(harness, 'hi')
        await harness.waitForText('recovered-after-stall')
      },
    )
  })
})
