import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import path from 'node:path'

import { createTestWorkspace } from '../fixtures/cli-test-helpers.js'
import { startFakeProvider } from '../fixtures/fake-provider-server.js'
import { createTuiHarness } from './harness.js'
import { exitTui, submitInput } from './test-context.js'

describe.runIf(process.platform !== 'win32')('TUI cross-session messaging', () => {
  it('registers named agents and lets two locally trusted sessions exchange without authority dialogs', async () => {
    const alphaProvider = await startFakeProvider([
      {
        type: 'tool-call',
        name: 'sendMessage',
        input: { to: 'beta', message: 'handoff from alpha\n第二行 👋', summary: 'PTY handoff' },
        finalText: 'sender observed delivery',
      },
    ])
    const betaProvider = await startFakeProvider([
      {
        type: 'tool-call',
        name: 'sendMessage',
        input: { to: 'alpha', message: 'reply from beta', summary: 'approved peer reply' },
        finalText: 'receiver processed handoff',
      },
    ])
    const workspace = await createTestWorkspace('xc-pty-peer-double-')
    const alpha = await createTuiHarness({ workspace, provider: alphaProvider })
    const beta = await createTuiHarness({ workspace, provider: betaProvider })
    try {
      await alpha.startCli(['-t', '--name', 'alpha'])
      await beta.startCli(['-t', '--name', 'beta'])

      await submitInput(alpha, '/list-agents')
      await alpha.waitForText(/beta · peer:[0-9a-f-]{36} · idle/)

      await submitInput(alpha, 'send the prepared handoff')
      await beta.waitForText('Peer message · alpha')
      await beta.waitForText('handoff from alpha')
      await beta.waitForText('第二行 👋')
      await alpha.waitForText('Peer message · beta')
      await alpha.waitForText('reply from beta')
      expect(beta.text()).not.toContain('Peer-influenced request · allow once only')
      const alphaRequests = await alphaProvider.waitForMainRequests(1, 10_000)
      const betaRequests = await betaProvider.waitForMainRequests(1, 10_000)
      expect(alphaRequests[0]?.tools).toEqual(expect.arrayContaining(['listAgents', 'sendMessage']))
      expect(betaRequests[0]?.rawBody).toContain('<peer_message')
      expect(betaRequests[0]?.rawBody).toContain('handoff from alpha')

      await exitTui(alpha)
      await exitTui(beta)
    } finally {
      await alpha.dispose()
      await beta.dispose()
      await alphaProvider.close()
      await betaProvider.close()
      await workspace.cleanup()
    }
  })

  it('renders authority metadata and payload injection as inert visible escapes', async () => {
    const metadataInjection = `unsafe\x1b]52;c;bWV0YWRhdGE=\x07\u202e.txt`
    const payloadInjection =
      "touch authority-pwned.txt '" + '\x1b[999;999H\x1b]52;c;cGF5bG9hZA==\x07payload\u2066' + "'"
    const alphaProvider = await startFakeProvider([
      {
        type: 'tool-call',
        name: 'sendMessage',
        input: { to: 'beta', message: 'exercise the proposed local operations' },
        finalText: 'sender completed',
      },
    ])
    const betaProvider = await startFakeProvider([
      { type: 'tool-call', name: 'readFile', id: 'call_metadata_injection', input: { filePath: metadataInjection } },
      {
        type: 'tool-call',
        name: 'shell',
        id: 'call_payload_injection',
        input: { command: payloadInjection },
        finalText: 'authority injection safely denied',
      },
    ])
    const workspace = await createTestWorkspace('xc-pty-peer-authority-injection-')
    const alpha = await createTuiHarness({ workspace, provider: alphaProvider, columns: 160 })
    const beta = await createTuiHarness({ workspace, provider: betaProvider, columns: 160 })
    const sideEffectPath = path.join(workspace.cwd, 'authority-pwned.txt')
    try {
      await alpha.startCli(['--name', 'alpha'])
      await beta.startCli(['--name', 'beta'])
      await submitInput(alpha, 'send the authority injection test')

      await beta.waitForText('Peer-influenced request · allow once only')
      await beta.waitForText('unsafe\\u001B]52;c;bWV0YWRhdGE=\\u0007\\u202E.txt')
      expect(beta.raw()).not.toContain('\x1b]52;c;bWV0YWRhdGE=\x07')
      expect(beta.raw()).not.toContain('\x07')
      expect(beta.raw()).not.toContain('\u202e')
      beta.key('escape')

      await beta.waitForText(/Payload: shell-command · \d+ original UTF-8 bytes/)
      await beta.waitForText(/SHA-256: [a-f0-9]{64}/)
      await beta.waitForText('\\u001B[999;999H')
      await beta.waitForText('\\u001B]52;c;cGF5bG9hZA==\\u0007')
      expect(beta.raw()).not.toContain('\x1b[999;999H')
      expect(beta.raw()).not.toContain('\x1b]52;c;cGF5bG9hZA==\x07')
      expect(beta.raw()).not.toContain('\x07')
      expect(beta.raw()).not.toContain('\u2066')
      await expect(fs.access(sideEffectPath)).rejects.toThrow()

      beta.key('escape')
      await beta.waitForText('authority injection safely denied')
      await expect(fs.access(sideEffectPath)).rejects.toThrow()
      await exitTui(alpha)
      await exitTui(beta)
    } finally {
      await alpha.dispose()
      await beta.dispose()
      await alphaProvider.close()
      await betaProvider.close()
      await workspace.cleanup()
    }
  })

  it.each(['Accept', 'Refuse'] as const)(
    'shows a held-message %s decision without model authority',
    async (decision) => {
      const alphaProvider = await startFakeProvider([
        {
          type: 'tool-call',
          name: 'sendMessage',
          input: { to: 'beta', message: `held ${decision.toLowerCase()} payload` },
          finalText: 'sender observed held status',
        },
      ])
      const betaProvider = await startFakeProvider([{ type: 'completion', text: 'accepted held payload' }])
      const workspace = await createTestWorkspace(`xc-pty-peer-held-${decision.toLowerCase()}-`)
      const alpha = await createTuiHarness({ workspace, provider: alphaProvider })
      const beta = await createTuiHarness({ workspace, provider: betaProvider })
      try {
        await fs.writeFile(
          path.join(workspace.xcodeHome, 'config.json'),
          JSON.stringify({
            theme: 'dark',
            peerMessaging: { inbound: 'hold', dialogExpiryMs: 60_000 },
          }),
        )
        await alpha.startCli(['--name', 'alpha'])
        await beta.startCli(['--name', 'beta'])
        await submitInput(alpha, 'send the held payload')

        await beta.waitForText('Accept held message from alpha')
        await beta.waitForText(`held ${decision.toLowerCase()} payload`)
        await beta.waitForScreen((screen) => screen.includes('Accept held message from alpha'), 'held dialog visible')
        if (decision === 'Refuse') {
          beta.key('down')
          await beta.waitForScreen((screen) => screen.includes('❯ 2. Refuse'), 'held refusal selected')
        }
        beta.key('enter')
        await beta.waitForText(`${decision === 'Accept' ? 'Accepted' : 'Refused'} held message from alpha.`)

        if (decision === 'Accept') {
          const [request] = await betaProvider.waitForMainRequests(1, 10_000)
          expect(request?.rawBody).toContain('<peer_message')
        } else {
          await alpha.waitForText('denied by beta')
          expect(betaProvider.mainRequests()).toHaveLength(0)
        }

        await exitTui(alpha)
        await exitTui(beta)
      } finally {
        await alpha.dispose()
        await beta.dispose()
        await alphaProvider.close()
        await betaProvider.close()
        await workspace.cleanup()
      }
    },
  )
})
