import { describe, expect, it, vi } from 'vitest'

import { randomUUID } from 'node:crypto'

import { createPeerIdentity } from '../src/peers/identity.js'
import type { PeerFrameV1 } from '../src/peers/protocol.js'
import type { PeerRegistry } from '../src/peers/registry.js'
import { createPeerService } from '../src/peers/service.js'
import type { PeerTransport } from '../src/peers/transport.js'
import type { PeerRegistrationV1, RegistrationCandidate } from '../src/peers/types.js'

function candidate(registration: PeerRegistrationV1): RegistrationCandidate {
  return { registration, registrationPath: `/registrations/${registration.instanceId}.json`, mtimeMs: 1 }
}

describe('peer service terminal sanitization', () => {
  it('sanitizes custom registry and protocol values before canonical queue admission', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const receiver = createPeerIdentity({ name: 'receiver', cwd: '/receiver' })
    const sender = createPeerIdentity({ name: 'sender', cwd: '/sender' })
    const timestamp = '2026-08-13T00:00:00.000Z'
    const senderCandidate = candidate({
      version: 1,
      instanceId: sender.instanceId,
      pid: process.pid,
      name: 'send\x1b]52;c;Y2xpcGJvYXJk\x07er\u202e',
      cwd: '/repo\x1b[2J/safe',
      transport: { kind: 'unix', address: '/runtime/sender.sock' },
      inboxToken: sender.inboxToken,
      permissionClass: 'prompted',
      status: 'idle',
      startedAt: timestamp,
      updatedAt: timestamp,
      protocolVersion: 1,
    })
    let onRequest: ((frame: PeerFrameV1, senderInstanceId: string) => Promise<PeerFrameV1>) | undefined
    const registry: PeerRegistry = {
      initialize: vi.fn(async () => {}),
      write: vi.fn(async () => {}),
      read: vi.fn(async (instanceId) => (instanceId === sender.instanceId ? senderCandidate : null)),
      listCandidates: vi.fn(async () => ({ candidates: [senderCandidate], scanned: 1, rejected: 0, truncated: false })),
      listLive: vi.fn(async () => ({
        peers: [
          {
            name: senderCandidate.registration.name,
            address: sender.address,
            cwd: senderCandidate.registration.cwd,
            status: 'idle' as const,
            startedAt: timestamp,
          },
        ],
        registrations: [senderCandidate],
        partial: false,
      })),
      removeOwn: vi.fn(async () => true),
      cleanupConfirmedDead: vi.fn(async () => false),
      paths: () => ({ registryDir: '/runtime/peers', socketDir: '/runtime/sockets' }),
    }
    const transport: PeerTransport = {
      kind: 'unix',
      createAddressHint: () => '/runtime/receiver.sock',
      validateAddress: () => true,
      listen: vi.fn(async (options) => {
        onRequest = options.onRequest
        return {
          address: options.address,
          closed: new Promise<{ expected: boolean }>(() => {}),
          close: vi.fn(async () => {}),
        }
      }),
      request: vi.fn(async () => {
        throw new Error('not used')
      }),
    }
    const service = createPeerService({
      enabled: true,
      config: { inbound: 'accept' },
      identity: receiver,
      registry,
      transport,
      cwd: '/receiver',
      now: () => new Date(timestamp),
    })

    try {
      await service.start()
      expect(await service.listAgents()).toMatchObject([{ name: 'sender', cwd: '/repo/safe' }])

      const response = await onRequest!(
        {
          v: 1,
          type: 'message',
          requestId: randomUUID(),
          messageId: randomUUID(),
          senderInstanceId: sender.instanceId,
          text: `你好\x1b]52;c;${'z'.repeat(100_000)}\x07世界\n🧑🏽‍💻`,
          summary: `sum\x1b]8;;${'z'.repeat(300)}\x1b\\mary`,
          sentAt: timestamp,
          senderPermissionClass: 'prompted',
        },
        sender.instanceId,
      )
      expect(response).toMatchObject({ type: 'ack', status: 'delivered' })
      expect(service.claimAccepted(1)?.messages[0]).toMatchObject({
        from: { name: 'sender', cwd: '/repo/safe' },
        text: '你好世界\n🧑🏽‍💻',
        summary: 'summary',
      })
    } finally {
      await service.shutdown()
      platformSpy.mockRestore()
    }
  })
})
