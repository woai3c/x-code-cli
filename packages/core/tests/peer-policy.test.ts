import { describe, expect, it } from 'vitest'

import { decideInboundDisposition } from '../src/peers/inbound-policy.js'
import { createPeerRateLimiter } from '../src/peers/rate-limit.js'

describe('peer inbound policy', () => {
  it('honors every explicit inbound policy without consulting permission classes', () => {
    const common = {
      receiverPermissionClass: 'bypass' as const,
      senderPermissionClass: 'bypass' as const,
      dialogExpiryMs: 5_000,
      now: 1_000,
    }

    expect(decideInboundDisposition({ ...common, policy: 'accept' })).toEqual({ kind: 'accept' })
    expect(decideInboundDisposition({ ...common, policy: 'refuse' })).toEqual({ kind: 'refuse', reason: 'policy' })
    expect(decideInboundDisposition({ ...common, policy: 'hold' })).toEqual({
      kind: 'hold',
      expiresAt: new Date(6_000).toISOString(),
      policySource: 'explicit',
    })
  })

  it('auto-accepts matching permission classes and holds mixed classes', () => {
    const decide = (receiverPermissionClass: 'prompted' | 'bypass', senderPermissionClass: 'prompted' | 'bypass') =>
      decideInboundDisposition({
        policy: 'auto',
        receiverPermissionClass,
        senderPermissionClass,
        dialogExpiryMs: 5_000,
        now: 1_000,
      })

    expect(decide('prompted', 'prompted')).toEqual({ kind: 'accept' })
    expect(decide('bypass', 'bypass')).toEqual({ kind: 'accept' })
    for (const classes of [
      ['prompted', 'bypass'],
      ['bypass', 'prompted'],
    ] as const) {
      expect(decide(classes[0], classes[1])).toEqual({
        kind: 'hold',
        expiresAt: new Date(6_000).toISOString(),
        policySource: 'auto',
      })
    }
  })
})

describe('peer inbound rate limiter', () => {
  it('enforces per-sender, global, and sender-cardinality limits without charging denied attempts', () => {
    let now = 0
    const limiter = createPeerRateLimiter({
      perSender: 2,
      global: 3,
      maxSenders: 2,
      windowMs: 100,
      now: () => now,
    })

    expect(limiter.admit('sender-a')).toBe(true)
    expect(limiter.admit('sender-a')).toBe(true)
    expect(limiter.admit('sender-a')).toBe(false)
    expect(limiter.admit('sender-b')).toBe(true)
    expect(limiter.admit('sender-c')).toBe(false)
    expect(limiter.senderCount()).toBe(2)

    now = 101
    expect(limiter.admit('sender-c')).toBe(true)
    expect(limiter.senderCount()).toBe(1)
    expect(limiter.admit('sender-c')).toBe(true)
    expect(limiter.admit('sender-c')).toBe(false)
  })

  it('applies the global limit across otherwise eligible senders', () => {
    const limiter = createPeerRateLimiter({ perSender: 10, global: 2, maxSenders: 10 })

    expect(limiter.admit('sender-a')).toBe(true)
    expect(limiter.admit('sender-b')).toBe(true)
    expect(limiter.admit('sender-c')).toBe(false)
  })
})
