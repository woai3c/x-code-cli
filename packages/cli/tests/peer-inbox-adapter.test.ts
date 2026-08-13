import { randomUUID } from 'node:crypto'

import { createPeerInbox } from '@x-code-cli/core'
import type { PeerService, PublicPeer } from '@x-code-cli/core'

import {
  blocksPeerClaim,
  formatDeliveryUpdateStatus,
  transferAcceptedToAgentQueue,
} from '../src/ui/agent/use-peer-inbox-adapter.js'

const peer: PublicPeer = {
  name: 'sender',
  address: `peer:${randomUUID()}`,
  cwd: '/project',
  status: 'idle',
  startedAt: new Date(0).toISOString(),
}

function serviceWithAccepted(count: number): PeerService {
  const inbox = createPeerInbox()
  for (let index = 0; index < count; index++) {
    inbox.admitInbound(
      {
        id: randomUUID(),
        from: peer,
        text: `message-${index}`,
        sentAt: new Date(index).toISOString(),
        receivedAt: new Date(index).toISOString(),
        senderPermissionClass: 'prompted',
      },
      `hash-${index}`,
      { kind: 'accept' },
    )
  }
  return {
    inbox,
    claimAccepted: (limit: number) => inbox.claimAccepted(limit),
    commitAcceptedClaim: (claimId: string) => inbox.commitAcceptedClaim(claimId),
    releaseAcceptedClaim: (claimId: string) => inbox.releaseAcceptedClaim(claimId),
  } as unknown as PeerService
}

describe('peer inbox adapter ownership transfer', () => {
  it('commits only after synchronous queue acceptance', () => {
    const service = serviceWithAccepted(2)
    const queued: string[] = []
    expect(
      transferAcceptedToAgentQueue(service, (input) => {
        queued.push(input.inboxKey)
        return true
      }),
    ).toBe(2)
    expect(queued).toHaveLength(2)
    expect(service.inbox.getSnapshot().accepted).toBe(0)
  })

  it('releases ownership under agent queue backpressure without dropping the message', () => {
    const service = serviceWithAccepted(1)
    expect(transferAcceptedToAgentQueue(service, () => false)).toBe(0)
    expect(service.inbox.getSnapshot().accepted).toBe(1)
    expect(service.inbox.claimAccepted(1)?.messages[0]?.text).toBe('message-0')
  })

  it('blocks claims for goal and maintenance owners but not interactive turns', () => {
    expect(blocksPeerClaim('goal')).toBe(true)
    expect(blocksPeerClaim('compact')).toBe(true)
    expect(blocksPeerClaim('resume')).toBe(true)
    expect(blocksPeerClaim('rewind')).toBe(true)
    expect(blocksPeerClaim('clear')).toBe(true)
    expect(blocksPeerClaim('user')).toBe(false)
    expect(blocksPeerClaim('peer')).toBe(false)
    expect(blocksPeerClaim(null)).toBe(false)
  })

  it('surfaces held final-status timeout without inventing denied or expired', () => {
    const status = formatDeliveryUpdateStatus({
      messageId: '12345678-abcd',
      status: 'final-status-unknown',
      peer,
    })

    expect(status).toContain('PEER_FINAL_STATUS_UNKNOWN')
    expect(status).toContain('final accept/refuse result is unknown')
    expect(status).not.toMatch(/: denied|: expired/)
  })
})
