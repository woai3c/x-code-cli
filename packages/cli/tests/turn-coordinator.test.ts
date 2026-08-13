import { describe, expect, it, vi } from 'vitest'

import { createTurnCoordinator } from '../src/ui/agent/turn-coordinator.js'
import type { TurnAuthority, TurnOwner } from '../src/ui/agent/turn-coordinator.js'

const cleanAuthority = (): TurnAuthority => ({ source: 'user', peerTainted: false })

const peerAuthority = (): TurnAuthority => ({
  source: 'peer',
  peerTainted: true,
  peerOrigins: {
    items: [{ instanceId: 'instance-1', nameAtReceipt: 'backend', messageId: 'message-1' }],
    totalCount: 1,
    digest: 'a'.repeat(64),
    truncated: false,
  },
})

describe('TurnCoordinator', () => {
  it('starts idle and grants only one synchronous lease', () => {
    const coordinator = createTurnCoordinator()
    expect(coordinator.isOwned()).toBe(false)
    expect(coordinator.current()).toBeNull()

    const lease = coordinator.tryAcquire('user', cleanAuthority())
    expect(lease).not.toBeNull()
    expect(coordinator.isOwned()).toBe(true)
    expect(coordinator.current()).toBe(lease)

    const competingOwners: TurnOwner[] = ['user', 'peer', 'goal', 'compact', 'resume', 'rewind', 'clear']
    for (const owner of competingOwners) {
      expect(coordinator.tryAcquire(owner, cleanAuthority())).toBeNull()
    }
  })

  it('captures a deeply immutable authority snapshot', () => {
    const coordinator = createTurnCoordinator()
    const authority = peerAuthority()
    const lease = coordinator.tryAcquire('peer', authority)!

    authority.source = 'user'
    authority.peerTainted = false
    authority.peerOrigins!.items[0]!.nameAtReceipt = 'mutated'
    authority.peerOrigins!.items.push({ instanceId: 'instance-2', nameAtReceipt: 'new', messageId: 'message-2' })

    expect(lease.authority).toEqual(peerAuthority())
    expect(Object.isFrozen(lease)).toBe(true)
    expect(Object.isFrozen(lease.authority)).toBe(true)
    expect(Object.isFrozen(lease.authority.peerOrigins)).toBe(true)
    expect(Object.isFrozen(lease.authority.peerOrigins?.items)).toBe(true)
    expect(Object.isFrozen(lease.authority.peerOrigins?.items[0])).toBe(true)
  })

  it('releases synchronously and idempotently', () => {
    const coordinator = createTurnCoordinator()
    const lease = coordinator.tryAcquire('compact', cleanAuthority())!

    expect(lease.release()).toBe(true)
    expect(coordinator.isOwned()).toBe(false)
    expect(coordinator.current()).toBeNull()
    expect(lease.release()).toBe(false)
  })

  it('does not let a stale lease release a newer owner', () => {
    const coordinator = createTurnCoordinator()
    const oldLease = coordinator.tryAcquire('user', cleanAuthority())!
    expect(oldLease.release()).toBe(true)

    const currentLease = coordinator.tryAcquire('goal', cleanAuthority())!
    expect(currentLease.id).not.toBe(oldLease.id)
    expect(oldLease.release()).toBe(false)
    expect(coordinator.current()).toBe(currentLease)
  })

  it('atomically releases and selects the next owner', () => {
    const coordinator = createTurnCoordinator()
    const observed: Array<TurnOwner | null> = []
    coordinator.onChange((lease) => observed.push(lease?.owner ?? null))

    const userLease = coordinator.tryAcquire('user', cleanAuthority())!
    const peerLease = coordinator.releaseAndTryAcquire(userLease, 'peer', peerAuthority())

    expect(peerLease?.owner).toBe('peer')
    expect(peerLease?.authority.peerTainted).toBe(true)
    expect(coordinator.current()).toBe(peerLease)
    expect(observed).toEqual(['user', 'peer'])
    expect(userLease.release()).toBe(false)
  })

  it('rejects stale and foreign atomic transitions without changing ownership', () => {
    const coordinator = createTurnCoordinator()
    const otherCoordinator = createTurnCoordinator()
    const stale = coordinator.tryAcquire('resume', cleanAuthority())!
    stale.release()
    const current = coordinator.tryAcquire('rewind', cleanAuthority())!
    const foreign = otherCoordinator.tryAcquire('clear', cleanAuthority())!

    expect(coordinator.releaseAndTryAcquire(stale, 'peer', peerAuthority())).toBeNull()
    expect(coordinator.releaseAndTryAcquire(foreign, 'peer', peerAuthority())).toBeNull()
    expect(coordinator.current()).toBe(current)
  })

  it('isolates listener failures and supports idempotent unsubscribe', () => {
    const coordinator = createTurnCoordinator()
    const failing = vi.fn(() => {
      throw new Error('listener failed')
    })
    const healthy = vi.fn()
    coordinator.onChange(failing)
    const unsubscribe = coordinator.onChange(healthy)

    const lease = coordinator.tryAcquire('clear', cleanAuthority())!
    expect(failing).toHaveBeenCalledTimes(1)
    expect(healthy).toHaveBeenCalledWith(lease)

    unsubscribe()
    unsubscribe()
    lease.release()
    expect(failing).toHaveBeenCalledTimes(2)
    expect(healthy).toHaveBeenCalledTimes(1)
    expect(coordinator.current()).toBeNull()
  })
})
