import { describe, expect, it, vi } from 'vitest'

import type { InboundPeerMessage } from '../src/peers/inbox-types.js'
import { createPeerInbox } from '../src/peers/inbox.js'
import type { PublicPeer } from '../src/types/index.js'

function publicPeer(instanceId: string, name = instanceId): PublicPeer {
  return {
    name,
    address: `peer:${instanceId}`,
    cwd: '/repo',
    status: 'idle',
    startedAt: '2026-08-13T00:00:00.000Z',
  }
}

function inbound(instanceId: string, messageId: string): InboundPeerMessage {
  return {
    id: messageId,
    from: publicPeer(instanceId),
    text: `message ${messageId}`,
    sentAt: '2026-08-13T00:00:00.000Z',
    receivedAt: '2026-08-13T00:00:01.000Z',
    senderPermissionClass: 'prompted',
  }
}

async function flushNotifications(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('in-memory peer inbox', () => {
  it('stores terminal-safe canonical peer fields and status reasons', () => {
    const inbox = createPeerInbox()
    const message: InboundPeerMessage = {
      ...inbound('sender-safe', 'terminal-safe'),
      from: {
        ...publicPeer('sender-safe'),
        name: 'peer\x1b]52;c;Y2xpcGJvYXJk\x07name\u202e',
        cwd: '/repo\x1b[2J/safe',
      },
      text: '你好\x1b]8;;https://evil.test\x1b\\世界\n🧑🏽‍💻',
      summary: 'sum\u009b2Jmary',
    }
    const admitted = inbox.admitInbound(message, 'safe-hash', { kind: 'accept' })
    if (admitted.status !== 'accepted') throw new Error('expected accepted admission')

    const claim = inbox.claimAccepted(1)!
    expect(claim.messages[0]).toMatchObject({
      from: { name: 'peername', cwd: '/repo/safe' },
      text: '你好世界\n🧑🏽‍💻',
      summary: 'summary',
    })
    inbox.commitAcceptedClaim(claim.claimId)
    inbox.markAgentInputsDropped([admitted.key], 'drop\x1b]52;c;c2VjcmV0\x07reason')
    expect(inbox.getInboundRecord(admitted.key)?.reason).toBe('dropreason')

    inbox.admitOutbound({
      messageId: 'safe-outbound',
      requestedTarget: 'peer',
      receiverInstanceId: 'peer-id',
      receiverAddress: 'peer:peer-id',
      payloadHash: 'payload',
    })
    expect(
      inbox.transitionOutbound('safe-outbound', {
        state: 'refused',
        reason: 'no\x1b[2J\u202eway',
      }),
    ).toMatchObject({ record: { reason: 'noway' } })
  })

  it('replays state to late subscribers and isolates listener failures', async () => {
    const listenerError = vi.fn()
    const inbox = createPeerInbox({ onListenerError: listenerError })
    inbox.admitInbound(inbound('sender-a', 'm1'), 'hash-1', { kind: 'accept' })

    const throwing = vi.fn(() => {
      throw new Error('listener failed')
    })
    const healthy = vi.fn()
    inbox.onChanged(throwing)
    inbox.onChanged(healthy)
    await flushNotifications()

    expect(healthy).toHaveBeenCalledWith(expect.objectContaining({ accepted: 1 }))
    expect(listenerError).toHaveBeenCalledTimes(1)
    expect(inbox.getSnapshot().accepted).toBe(1)

    throwing.mockClear()
    healthy.mockClear()
    inbox.admitInbound(inbound('sender-a', 'm2'), 'hash-2', { kind: 'accept' })
    await flushNotifications()

    expect(throwing).toHaveBeenCalledTimes(1)
    expect(healthy).toHaveBeenCalledWith(expect.objectContaining({ accepted: 2 }))
    expect(inbox.getSnapshot().accepted).toBe(2)

    const initiallyEmpty = createPeerInbox()
    const edgeListener = vi.fn()
    initiallyEmpty.onChanged(edgeListener)
    initiallyEmpty.admitInbound(inbound('sender-b', 'm1'), 'hash-b1', { kind: 'accept' })
    await flushNotifications()
    expect(edgeListener).toHaveBeenCalledTimes(1)
    expect(edgeListener).toHaveBeenCalledWith(expect.objectContaining({ accepted: 1 }))
  })

  it('claims accepted messages atomically and releases expired claims in FIFO order', () => {
    let now = Date.parse('2026-08-13T00:00:00.000Z')
    const inbox = createPeerInbox({ now: () => now, limits: { accepted: 3, claimLeaseMs: 10 } })
    const first = inbox.admitInbound(inbound('sender', 'first'), 'hash-first', { kind: 'accept' })
    const second = inbox.admitInbound(inbound('sender', 'second'), 'hash-second', { kind: 'accept' })
    const third = inbox.admitInbound(inbound('sender', 'third'), 'hash-third', { kind: 'accept' })
    if (first.status !== 'accepted' || second.status !== 'accepted' || third.status !== 'accepted') {
      throw new Error('expected accepted admissions')
    }

    const firstClaim = inbox.claimAccepted(1)
    expect(firstClaim?.messages.map((message) => message.id)).toEqual(['first'])
    expect(inbox.getSnapshot().accepted).toBe(3)
    expect(inbox.commitAcceptedClaim(firstClaim!.claimId)).toEqual({ status: 'committed', count: 1 })
    expect(inbox.getInboundRecord(first.key)?.state).toBe('agent-queued')
    expect(inbox.markAgentInputsInjected([first.key])).toEqual({ transitioned: 1, alreadyTerminal: 0, notFound: 0 })

    const expiringClaim = inbox.claimAccepted(1)
    expect(expiringClaim?.messages[0]?.id).toBe('second')
    now += 11
    inbox.sweep()
    expect(inbox.getInboundRecord(second.key)?.state).toBe('accepted')

    const afterExpiry = inbox.claimAccepted(2)
    expect(afterExpiry?.messages.map((message) => message.id)).toEqual(['second', 'third'])
    expect(inbox.releaseAcceptedClaim(afterExpiry!.claimId)).toEqual({ status: 'released', count: 2 })
    expect(inbox.claimAccepted(2)?.messages.map((message) => message.id)).toEqual(['second', 'third'])
  })

  it('keeps admitted records in one bounded ledger and preserves dropped-after-ack dedupe', () => {
    let now = Date.parse('2026-08-13T00:00:00.000Z')
    const inbox = createPeerInbox({
      now: () => now,
      limits: { accepted: 1, inboundLedger: 2, terminalRetentionMs: 100 },
    })
    const accepted = inbox.admitInbound(inbound('sender', 'accepted'), 'hash-accepted', { kind: 'accept' })
    if (accepted.status !== 'accepted') throw new Error('expected accepted admission')

    expect(inbox.admitInbound(inbound('sender', 'queue-full'), 'hash-full', { kind: 'accept' })).toMatchObject({
      status: 'refused',
      reason: 'accepted-queue-full',
    })
    expect(inbox.admitInbound(inbound('sender', 'ledger-full'), 'hash-ledger', { kind: 'accept' })).toEqual({
      status: 'ledger-full',
    })

    const claim = inbox.claimAccepted(1)!
    expect(inbox.commitAcceptedClaim(claim.claimId)).toEqual({ status: 'committed', count: 1 })
    expect(inbox.markAgentInputsDropped([accepted.key], 'typed-queue-fault')).toEqual({
      transitioned: 1,
      alreadyTerminal: 0,
      notFound: 0,
    })
    expect(inbox.getInboundRecord(accepted.key)).toMatchObject({
      state: 'dropped-after-ack',
      wireStatus: 'delivered',
      reason: 'typed-queue-fault',
    })
    expect(inbox.admitInbound(inbound('sender', 'accepted'), 'hash-accepted', { kind: 'accept' })).toEqual({
      status: 'duplicate',
      key: accepted.key,
      duplicateOfStatus: 'delivered',
    })
    expect(inbox.claimAccepted(1)).toBeNull()

    now += 101
    expect(inbox.admitInbound(inbound('sender', 'after-retention'), 'hash-after', { kind: 'accept' })).toMatchObject({
      status: 'accepted',
    })
    expect(inbox.getSnapshot().inboundLedger).toBe(2)
  })

  it('rejects an inbound retry that reuses an id with a different payload', () => {
    const inbox = createPeerInbox()
    const admitted = inbox.admitInbound(inbound('sender', 'same-id'), 'original-hash', { kind: 'accept' })
    if (admitted.status !== 'accepted') throw new Error('expected accepted admission')

    expect(inbox.admitInbound(inbound('sender', 'same-id'), 'changed-hash', { kind: 'accept' })).toEqual({
      status: 'retry-mismatch',
      key: admitted.key,
    })
    expect(inbox.getSnapshot().accepted).toBe(1)
  })

  it('keeps held messages in place on accepted backpressure and never blocks terminal decisions on outbox capacity', () => {
    let now = Date.parse('2026-08-13T00:00:00.000Z')
    const inbox = createPeerInbox({
      now: () => now,
      limits: { accepted: 1, held: 2, finalUpdateOutbox: 1 },
    })
    inbox.admitInbound(inbound('sender', 'occupies-accepted'), 'hash-accepted', { kind: 'accept' })
    const heldOne = inbox.admitInbound(inbound('sender', 'held-one'), 'hash-held-one', {
      kind: 'hold',
      expiresAt: new Date(now + 100).toISOString(),
      policySource: 'auto',
    })
    if (heldOne.status !== 'held') throw new Error('expected held admission')

    expect(inbox.decideHeld(heldOne.key, 'accept')).toEqual({ status: 'queue-full', key: heldOne.key })
    expect(inbox.listHeld().map((entry) => entry.key)).toEqual([heldOne.key])
    expect(inbox.decideHeld(heldOne.key, 'reject')).toEqual({ status: 'rejected', key: heldOne.key })
    expect(inbox.getInboundRecord(heldOne.key)?.state).toBe('denied')

    const heldTwo = inbox.admitInbound(inbound('sender', 'held-two'), 'hash-held-two', {
      kind: 'hold',
      expiresAt: new Date(now + 10).toISOString(),
      policySource: 'explicit',
    })
    if (heldTwo.status !== 'held') throw new Error('expected held admission')
    now += 11
    inbox.sweep()

    expect(inbox.getInboundRecord(heldTwo.key)?.state).toBe('expired')
    expect(inbox.getSnapshot()).toMatchObject({ held: 0, pendingFinalUpdates: 1, droppedFinalUpdates: 1 })
    const updateClaim = inbox.claimFinalUpdates(1)!
    expect(updateClaim.updates).toMatchObject([{ messageId: 'held-one', status: 'denied' }])
    expect(inbox.commitFinalUpdateClaim(updateClaim.claimId)).toEqual({ status: 'committed', count: 1 })
    expect(inbox.admitInbound(inbound('sender', 'held-one'), 'hash-held-one', { kind: 'accept' })).toEqual({
      status: 'duplicate',
      key: heldOne.key,
      duplicateOfStatus: 'denied',
    })
  })

  it('fixes outbound identity at admission and bounds delivery-unknown retry', () => {
    let now = Date.parse('2026-08-13T00:00:00.000Z')
    const inbox = createPeerInbox({
      now: () => now,
      limits: { activeOutbound: 1, outboundLedger: 2, deliveryUnknownRetryMs: 20, terminalRetentionMs: 100 },
    })
    const firstInput = {
      messageId: 'outbound-1',
      requestedTarget: 'backend',
      receiverInstanceId: 'old-backend',
      receiverAddress: 'peer:old-backend' as const,
      payloadHash: 'payload-1',
    }
    expect(inbox.admitOutbound(firstInput)).toMatchObject({ status: 'admitted' })
    expect(
      inbox.admitOutbound({ ...firstInput, receiverInstanceId: 'new-backend', receiverAddress: 'peer:new-backend' }),
    ).toMatchObject({ status: 'retry-mismatch' })
    expect(
      inbox.admitOutbound({
        messageId: 'outbound-2',
        requestedTarget: 'other',
        receiverInstanceId: 'other',
        receiverAddress: 'peer:other',
        payloadHash: 'payload-2',
      }),
    ).toEqual({ status: 'active-full' })

    expect(inbox.transitionOutbound('outbound-1', { state: 'delivery-unknown' })).toMatchObject({
      status: 'transitioned',
      record: { state: 'delivery-unknown' },
    })
    expect(inbox.beginOutboundRetry('outbound-1', 'replacement-name', 'payload-1')).toMatchObject({
      status: 'retry-mismatch',
    })
    expect(inbox.inspectOutboundRetry('outbound-1', 'backend', 'payload-1')).toMatchObject({
      status: 'ready',
      record: { state: 'delivery-unknown' },
    })
    expect(inbox.getOutboundRecord('outbound-1')?.state).toBe('delivery-unknown')
    const retry = inbox.beginOutboundRetry('outbound-1', 'backend', 'payload-1')
    expect(retry).toMatchObject({
      status: 'ready',
      record: { receiverInstanceId: 'old-backend', receiverAddress: 'peer:old-backend', state: 'sending' },
    })
    expect(inbox.transitionOutbound('outbound-1', { state: 'delivery-unknown' })).toMatchObject({
      status: 'transitioned',
    })
    now += 21
    inbox.sweep()
    expect(inbox.getOutboundRecord('outbound-1')?.state).toBe('delivery-unknown-expired')

    const second = inbox.admitOutbound({
      messageId: 'outbound-2',
      requestedTarget: 'other',
      receiverInstanceId: 'other',
      receiverAddress: 'peer:other',
      payloadHash: 'payload-2',
    })
    expect(second).toMatchObject({ status: 'admitted' })
    expect(inbox.transitionOutbound('outbound-2', { state: 'delivered' })).toMatchObject({
      status: 'transitioned',
      record: { state: 'delivered' },
    })
    expect(inbox.getSnapshot()).toMatchObject({ outboundLedger: 2, activeOutbound: 0 })

    expect(
      inbox.admitOutbound({
        messageId: 'outbound-3',
        requestedTarget: 'third',
        receiverInstanceId: 'third',
        receiverAddress: 'peer:third',
        payloadHash: 'payload-3',
      }),
    ).toEqual({ status: 'ledger-full' })
    now += 101
    expect(
      inbox.admitOutbound({
        messageId: 'outbound-3',
        requestedTarget: 'third',
        receiverInstanceId: 'third',
        receiverAddress: 'peer:third',
        payloadHash: 'payload-3',
      }),
    ).toMatchObject({ status: 'admitted' })
  })

  it('coalesces bounded delivery notifications without losing outbound ledger state', () => {
    const inbox = createPeerInbox({
      now: () => Date.parse('2026-08-13T00:00:00.000Z'),
      limits: { deliveryNotifications: 1 },
    })
    for (const id of ['one', 'two']) {
      inbox.admitOutbound({
        messageId: id,
        requestedTarget: id,
        receiverInstanceId: `receiver-${id}`,
        receiverAddress: `peer:receiver-${id}`,
        payloadHash: `hash-${id}`,
      })
      inbox.transitionOutbound(id, { state: 'held', heldUntil: '2026-08-13T01:00:00.000Z' })
    }

    expect(
      inbox.recordDeliveryUpdate({
        messageId: 'one',
        receiverInstanceId: 'receiver-one',
        peer: publicPeer('receiver-one'),
        status: 'delivered',
      }),
    ).toMatchObject({ status: 'recorded' })
    expect(
      inbox.recordDeliveryUpdate({
        messageId: 'two',
        receiverInstanceId: 'receiver-two',
        peer: publicPeer('receiver-two'),
        status: 'denied',
      }),
    ).toMatchObject({ status: 'recorded' })

    expect(inbox.getOutboundRecord('one')?.state).toBe('delivered')
    expect(inbox.getOutboundRecord('two')?.state).toBe('denied')
    expect(inbox.getSnapshot()).toMatchObject({ deliveryUpdates: 1, droppedDeliveryNotifications: 1 })
    const claim = inbox.claimDeliveryUpdates(1)!
    expect(claim.updates).toMatchObject([{ messageId: 'two', status: 'denied' }])
    expect(inbox.releaseDeliveryUpdateClaim(claim.claimId)).toEqual({ status: 'released', count: 1 })
    const reclaimed = inbox.claimDeliveryUpdates(1)!
    expect(reclaimed.updates[0]?.messageId).toBe('two')
    expect(inbox.commitDeliveryUpdateClaim(reclaimed.claimId)).toEqual({ status: 'committed', count: 1 })
    expect(inbox.getSnapshot().deliveryUpdates).toBe(0)

    expect(
      inbox.recordDeliveryUpdate({
        messageId: 'two',
        receiverInstanceId: 'receiver-two',
        peer: publicPeer('receiver-two'),
        status: 'denied',
      }),
    ).toMatchObject({ status: 'duplicate' })
    expect(
      inbox.recordDeliveryUpdate({
        messageId: 'one',
        receiverInstanceId: 'replacement',
        peer: publicPeer('replacement'),
        status: 'delivered',
      }),
    ).toMatchObject({ status: 'ignored', reason: 'target-mismatch' })
  })

  it('reports held final status as unknown instead of inventing an expiry result', () => {
    let now = Date.parse('2026-08-13T00:00:00.000Z')
    const inbox = createPeerInbox({
      now: () => now,
      limits: { finalUpdateRetryMs: 20, finalUpdateGraceMs: 10 },
    })
    inbox.admitOutbound({
      messageId: 'held-outbound',
      requestedTarget: 'backend',
      receiverInstanceId: 'backend-id',
      receiverAddress: 'peer:backend-id',
      payloadHash: 'held-payload',
    })
    inbox.transitionOutbound('held-outbound', { state: 'held', heldUntil: new Date(now + 5).toISOString() })

    now += 36
    inbox.sweep()
    expect(inbox.getOutboundRecord('held-outbound')?.state).toBe('held-final-status-unknown')
    expect(inbox.getOutboundRecord('held-outbound')?.state).not.toBe('expired')
    expect(inbox.claimDeliveryUpdates(1)?.updates).toEqual([
      expect.objectContaining({
        messageId: 'held-outbound',
        status: 'final-status-unknown',
        peer: expect.objectContaining({ address: 'peer:backend-id' }),
      }),
    ])

    expect(
      inbox.recordDeliveryUpdate({
        messageId: 'held-outbound',
        receiverInstanceId: 'backend-id',
        peer: publicPeer('backend-id'),
        status: 'expired',
      }),
    ).toMatchObject({ status: 'recorded', record: { state: 'expired' } })
  })
})
