import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createPeerRateLimiter } from '../src/peers/rate-limit.js'
import { type PeerRegistry, createPeerRegistry } from '../src/peers/registry.js'
import { type PeerService, createPeerService } from '../src/peers/service.js'
import type { PeerTransport } from '../src/peers/transport.js'
import type { PeerIdentity } from '../src/peers/types.js'
import { createUnixSocketTransport } from '../src/peers/unix-socket-transport.js'

const describeUnix = describe.runIf(process.platform !== 'win32')

describeUnix('PeerService over real Unix domain sockets', () => {
  let previousHome: string | undefined
  let testHome: string
  let services: PeerService[]
  const socketDirectories = new Set<string>()

  beforeEach(async () => {
    previousHome = process.env.X_CODE_HOME
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'x-code-peer-service-'))
    process.env.X_CODE_HOME = testHome
    services = []
  })

  afterEach(async () => {
    await Promise.allSettled(services.map((service) => service.shutdown()))
    await Promise.allSettled(
      [...socketDirectories].map((directory) => fs.rm(directory, { recursive: true, force: true })),
    )
    socketDirectories.clear()
    await fs.rm(testHome, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.X_CODE_HOME
    else process.env.X_CODE_HOME = previousHome
  })

  async function startPeer(
    name: string,
    inbound: 'accept' | 'hold' | 'refuse' | 'auto' = 'accept',
    options: {
      transport?: PeerTransport
      rateLimiter?: ReturnType<typeof createPeerRateLimiter>
      permissionClass?: 'prompted' | 'bypass'
      identity?: PeerIdentity
      registry?: PeerRegistry
      expectAvailable?: boolean
    } = {},
  ): Promise<PeerService> {
    const service = createPeerService({
      enabled: true,
      config: { inbound, dialogExpiryMs: 60_000 },
      name,
      cwd: process.cwd(),
      permissionClass: options.permissionClass ?? 'prompted',
      identity: options.identity,
      registry: options.registry,
      transport: options.transport,
      rateLimiter: options.rateLimiter,
    })
    services.push(service)
    await service.start()
    expect(service.isAvailable(), service.getUnavailableReason()).toBe(options.expectAvailable ?? true)
    return service
  }

  async function candidateFor(service: PeerService) {
    const identity = service.identity
    if (!identity) throw new Error('enabled peer omitted its identity')
    const registry = await import('../src/peers/registry.js').then(({ createPeerRegistry }) => createPeerRegistry())
    await registry.initialize()
    socketDirectories.add(registry.paths().socketDir)
    const candidate = await registry.read(identity.instanceId)
    if (!candidate) throw new Error(`missing registration for ${identity.address}`)
    return candidate
  }

  it('lists and sends in both directions, returns acknowledgements, bypasses rate limits for duplicates', async () => {
    const frontend = await startPeer('frontend')
    const backend = await startPeer('backend', 'accept', {
      rateLimiter: createPeerRateLimiter({ perSender: 1, global: 10 }),
    })
    const frontendIdentity = frontend.identity!
    const backendIdentity = backend.identity!

    await expect(frontend.listAgents()).resolves.toEqual([
      expect.objectContaining({ name: 'backend', address: backendIdentity.address, status: 'idle' }),
    ])
    await expect(backend.listAgents()).resolves.toEqual([
      expect.objectContaining({ name: 'frontend', address: frontendIdentity.address, status: 'idle' }),
    ])

    const sent = await frontend.sendMessage('backend', 'build finished', 'status')
    expect(sent).toEqual({ success: true, status: 'delivered', messageId: expect.any(String) })
    if (!sent.success) throw new Error(sent.reason)

    const backendCandidate = await candidateFor(backend)
    const rawTransport = createUnixSocketTransport()
    const duplicate = await rawTransport.request({
      address: backendCandidate.registration.transport.address,
      targetToken: backendCandidate.registration.inboxToken,
      senderInstanceId: frontendIdentity.instanceId,
      frame: {
        v: 1,
        type: 'message',
        requestId: randomUUID(),
        messageId: sent.messageId,
        senderInstanceId: frontendIdentity.instanceId,
        text: 'build finished',
        summary: 'status',
        sentAt: new Date().toISOString(),
        senderPermissionClass: 'prompted',
      },
    })
    expect(duplicate).toEqual(
      expect.objectContaining({
        type: 'ack',
        messageId: sent.messageId,
        status: 'duplicate',
        duplicateOfStatus: 'delivered',
      }),
    )

    const limitedMessageId = randomUUID()
    const limitedFrame = {
      v: 1 as const,
      type: 'message' as const,
      requestId: randomUUID(),
      messageId: limitedMessageId,
      senderInstanceId: frontendIdentity.instanceId,
      text: 'a different message',
      sentAt: new Date().toISOString(),
      senderPermissionClass: 'prompted' as const,
    }
    const limited = await rawTransport.request({
      address: backendCandidate.registration.transport.address,
      targetToken: backendCandidate.registration.inboxToken,
      senderInstanceId: frontendIdentity.instanceId,
      frame: limitedFrame,
    })
    expect(limited).toEqual(expect.objectContaining({ type: 'ack', status: 'refused', reason: 'rate-limit' }))
    const limitedDuplicate = await rawTransport.request({
      address: backendCandidate.registration.transport.address,
      targetToken: backendCandidate.registration.inboxToken,
      senderInstanceId: frontendIdentity.instanceId,
      frame: { ...limitedFrame, requestId: randomUUID() },
    })
    expect(limitedDuplicate).toEqual(
      expect.objectContaining({
        type: 'ack',
        messageId: limitedMessageId,
        status: 'duplicate',
        duplicateOfStatus: 'refused',
      }),
    )

    const backendClaim = backend.claimAccepted(10)
    expect(backendClaim?.messages).toHaveLength(1)
    expect(backendClaim?.messages[0]).toEqual(
      expect.objectContaining({ id: sent.messageId, text: 'build finished', summary: 'status' }),
    )
    expect(backend.commitAcceptedClaim(backendClaim!.claimId)).toEqual({ status: 'committed', count: 1 })

    const reply = await backend.sendMessage(frontendIdentity.address, 'acknowledged')
    expect(reply).toEqual({ success: true, status: 'delivered', messageId: expect.any(String) })
    const frontendClaim = frontend.claimAccepted(10)
    expect(frontendClaim?.messages).toEqual([expect.objectContaining({ text: 'acknowledged' })])
  })

  it('rejects a message whose final escaped wire frame is oversized before outbound admission', async () => {
    const sender = await startPeer('frame-sender')
    const receiver = await startPeer('frame-receiver')
    await expect(sender.sendMessage(receiver.identity!.address, '\\'.repeat(96_000))).resolves.toEqual({
      success: false,
      code: 'PEER_MESSAGE_TOO_LARGE',
      reason: 'Message cannot fit in a complete peer protocol frame',
    })

    expect(sender.inbox.getSnapshot()).toMatchObject({ outboundLedger: 0, activeOutbound: 0 })
    expect(receiver.inbox.getSnapshot()).toMatchObject({ accepted: 0, inboundLedger: 0 })
  })

  it('propagates held accept and reject decisions as acknowledged final delivery updates', async () => {
    const sender = await startPeer('sender')
    const receiver = await startPeer('receiver', 'hold')
    const receiverAddress = receiver.identity!.address

    const acceptedLater = await sender.sendMessage(receiverAddress, 'please review')
    expect(acceptedLater).toEqual({
      success: true,
      status: 'held',
      messageId: expect.any(String),
      heldUntil: expect.any(String),
    })
    if (!acceptedLater.success) throw new Error(acceptedLater.reason)
    const acceptedHeld = receiver.listHeld()
    expect(acceptedHeld).toHaveLength(1)
    await expect(receiver.decideHeld(acceptedHeld[0]!.key, 'accept')).resolves.toEqual({
      status: 'accepted',
      key: acceptedHeld[0]!.key,
    })
    expect(sender.inbox.getOutboundRecord(acceptedLater.messageId)?.state).toBe('delivered')
    const deliveredUpdate = sender.claimDeliveryUpdates(10)
    expect(deliveredUpdate?.updates).toEqual([
      expect.objectContaining({ messageId: acceptedLater.messageId, status: 'delivered' }),
    ])
    expect(sender.commitDeliveryUpdateClaim(deliveredUpdate!.claimId)).toEqual({ status: 'committed', count: 1 })

    const rejectedLater = await sender.sendMessage(receiverAddress, 'please reject')
    expect(rejectedLater).toEqual({
      success: true,
      status: 'held',
      messageId: expect.any(String),
      heldUntil: expect.any(String),
    })
    if (!rejectedLater.success) throw new Error(rejectedLater.reason)
    const rejectedHeld = receiver.listHeld()
    expect(rejectedHeld).toHaveLength(1)
    await expect(receiver.decideHeld(rejectedHeld[0]!.key, 'reject')).resolves.toEqual({
      status: 'rejected',
      key: rejectedHeld[0]!.key,
    })
    expect(sender.inbox.getOutboundRecord(rejectedLater.messageId)?.state).toBe('denied')
    const deniedUpdate = sender.claimDeliveryUpdates(10)
    expect(deniedUpdate?.updates).toEqual([
      expect.objectContaining({ messageId: rejectedLater.messageId, status: 'denied' }),
    ])
  })

  it('expires held messages and flushes their final updates before shutdown removes its registration', async () => {
    const sender = await startPeer('sender')
    const receiver = await startPeer('receiver', 'hold')

    const held = await sender.sendMessage(receiver.identity!.address, 'wait for shutdown')
    expect(held).toMatchObject({ success: true, status: 'held' })
    if (!held.success) throw new Error(held.reason)

    await receiver.shutdown()

    expect(sender.inbox.getOutboundRecord(held.messageId)?.state).toBe('expired')
    expect(sender.claimDeliveryUpdates(1)?.updates).toEqual([
      expect.objectContaining({ messageId: held.messageId, status: 'expired' }),
    ])
    expect(receiver.inbox.getSnapshot()).toMatchObject({ held: 0, pendingFinalUpdates: 0 })
  })

  it('drains more than one final-update batch during shutdown', async () => {
    const sender = await startPeer('sender')
    const receiver = await startPeer('receiver', 'hold')
    const messageIds: string[] = []
    for (let index = 0; index < 17; index++) {
      const result = await sender.sendMessage(receiver.identity!.address, `held ${index}`)
      expect(result).toMatchObject({ success: true, status: 'held' })
      if (!result.success) throw new Error(result.reason)
      messageIds.push(result.messageId)
    }

    await receiver.shutdown()

    expect(messageIds.map((messageId) => sender.inbox.getOutboundRecord(messageId)?.state)).toEqual(
      Array(17).fill('expired'),
    )
    expect(receiver.inbox.getSnapshot()).toMatchObject({ held: 0, pendingFinalUpdates: 0 })
  })

  it('uses one shutdown budget and still notifies healthy senders when the first sender times out', async () => {
    const stalled = await startPeer('stalled')
    const healthy = await startPeer('healthy')
    const stalledCandidate = await candidateFor(stalled)
    const realTransport = createUnixSocketTransport()
    let stalledAttempts = 0
    const receiverTransport: PeerTransport = {
      ...realTransport,
      request: async (options) => {
        if (
          options.frame.type !== 'delivery-update' ||
          options.address !== stalledCandidate.registration.transport.address
        ) {
          return realTransport.request(options)
        }
        stalledAttempts++
        return new Promise<never>(() => {})
      },
    }
    const receiver = await startPeer('receiver', 'hold', { transport: receiverTransport })
    const stalledHeld = await stalled.sendMessage(receiver.identity!.address, 'stalled sender first')
    const healthyHeld = await healthy.sendMessage(receiver.identity!.address, 'healthy sender second')
    expect(stalledHeld).toMatchObject({ success: true, status: 'held' })
    expect(healthyHeld).toMatchObject({ success: true, status: 'held' })
    if (!stalledHeld.success || !healthyHeld.success) throw new Error('expected held messages')

    const startedAt = Date.now()
    await receiver.shutdown()

    expect(Date.now() - startedAt).toBeLessThan(1_200)
    expect(stalledAttempts).toBeGreaterThan(0)
    expect(stalled.inbox.getOutboundRecord(stalledHeld.messageId)?.state).toBe('held')
    expect(healthy.inbox.getOutboundRecord(healthyHeld.messageId)?.state).toBe('expired')
    expect(receiver.inbox.getSnapshot()).toMatchObject({ held: 0, pendingFinalUpdates: 1 })
  })

  it('waits for an in-flight registration write before removing its registration', async () => {
    const registry = createPeerRegistry()
    let writeCount = 0
    let signalDelayedWrite!: () => void
    const delayedWriteStarted = new Promise<void>((resolve) => (signalDelayedWrite = resolve))
    let releaseDelayedWrite!: () => void
    const delayedWrite = new Promise<void>((resolve) => (releaseDelayedWrite = resolve))
    const events: string[] = []
    const wrappedRegistry: PeerRegistry = {
      ...registry,
      async write(value) {
        writeCount++
        if (writeCount === 2) {
          events.push('write-start')
          signalDelayedWrite()
          await delayedWrite
        }
        await registry.write(value)
        if (writeCount === 2) events.push('write-end')
      },
      async removeOwn(instanceId) {
        events.push('remove')
        return registry.removeOwn(instanceId)
      },
    }
    const receiver = await startPeer('receiver', 'accept', { registry: wrappedRegistry })
    const update = receiver.updateLocalState({ status: 'busy', busyKind: 'maintenance' })
    await delayedWriteStarted
    const shutdown = receiver.shutdown()
    await new Promise((resolve) => setTimeout(resolve, 25))
    releaseDelayedWrite()
    await Promise.all([update, shutdown])

    expect(events.indexOf('write-end')).toBeLessThan(events.indexOf('remove'))
    expect(await registry.read(receiver.identity!.instanceId)).toBeNull()
    const writesAfterShutdown = writeCount
    await receiver.updateLocalState({ status: 'idle' })
    expect(writeCount).toBe(writesAfterShutdown)
    expect(await registry.read(receiver.identity!.instanceId)).toBeNull()
  })

  it('does not continue startup after shutdown begins during registry initialization', async () => {
    let signalInitialize!: () => void
    const initializeStarted = new Promise<void>((resolve) => (signalInitialize = resolve))
    let releaseInitialize!: () => void
    const initializeGate = new Promise<void>((resolve) => (releaseInitialize = resolve))
    const registry: PeerRegistry = {
      initialize: vi.fn(async () => {
        signalInitialize()
        await initializeGate
      }),
      write: vi.fn(),
      read: vi.fn(async () => null),
      listCandidates: vi.fn(async () => ({ candidates: [], scanned: 0, rejected: 0, truncated: false })),
      listLive: vi.fn(async () => ({ peers: [], registrations: [], partial: false })),
      removeOwn: vi.fn(async () => false),
      cleanupConfirmedDead: vi.fn(async () => false),
      paths: () => ({ registryDir: testHome, socketDir: testHome }),
    }
    const close = vi.fn(async () => {})
    const transport: PeerTransport = {
      kind: 'unix',
      createAddressHint: () => testHome,
      validateAddress: () => true,
      listen: vi.fn(async (options) => ({
        address: options.address,
        closed: new Promise<{ expected: boolean }>(() => {}),
        close,
      })),
      request: vi.fn(),
    }
    const service = createPeerService({ enabled: true, name: 'late-start', registry, transport })
    services.push(service)

    const start = service.start()
    await initializeStarted
    const shutdown = service.shutdown()
    releaseInitialize()
    await Promise.all([start, shutdown])
    await service.shutdown()

    expect(service.isAvailable()).toBe(false)
    expect(transport.listen).not.toHaveBeenCalled()
    expect(registry.write).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('fails closed and removes registration after an unexpected transport exit', async () => {
    const removeOwn = vi.fn(async () => true)
    const registry: PeerRegistry = {
      initialize: vi.fn(async () => {}),
      write: vi.fn(),
      read: vi.fn(async () => null),
      listCandidates: vi.fn(async () => ({ candidates: [], scanned: 0, rejected: 0, truncated: false })),
      listLive: vi.fn(async () => ({ peers: [], registrations: [], partial: false })),
      removeOwn,
      cleanupConfirmedDead: vi.fn(async () => false),
      paths: () => ({ registryDir: testHome, socketDir: testHome }),
    }
    let closeUnexpectedly!: (result: { expected: boolean; reason?: string }) => void
    const closed = new Promise<{ expected: boolean; reason?: string }>((resolve) => {
      closeUnexpectedly = resolve
    })
    const transport: PeerTransport = {
      kind: 'unix',
      createAddressHint: () => testHome,
      validateAddress: () => true,
      listen: vi.fn(async (options) => ({ address: options.address, closed, close: vi.fn(async () => {}) })),
      request: vi.fn(),
    }
    const service = createPeerService({ enabled: true, name: 'crashed-transport', registry, transport })
    services.push(service)
    await service.start()
    expect(service.isAvailable()).toBe(true)

    closeUnexpectedly({ expected: false, reason: 'listener crashed' })
    await vi.waitFor(() => expect(service.isAvailable()).toBe(false))
    await vi.waitFor(() => expect(removeOwn).toHaveBeenCalledWith(service.identity!.instanceId))
    expect(service.getUnavailableReason()).toBe('listener crashed')
  })

  it('closes a listener that resolves after shutdown invalidates startup', async () => {
    const registry: PeerRegistry = {
      initialize: vi.fn(async () => {}),
      write: vi.fn(),
      read: vi.fn(async () => null),
      listCandidates: vi.fn(async () => ({ candidates: [], scanned: 0, rejected: 0, truncated: false })),
      listLive: vi.fn(async () => ({ peers: [], registrations: [], partial: false })),
      removeOwn: vi.fn(async () => false),
      cleanupConfirmedDead: vi.fn(async () => false),
      paths: () => ({ registryDir: testHome, socketDir: testHome }),
    }
    let signalListen!: () => void
    const listenStarted = new Promise<void>((resolve) => (signalListen = resolve))
    let releaseListen!: () => void
    const listenGate = new Promise<void>((resolve) => (releaseListen = resolve))
    const close = vi.fn(async () => {})
    const transport: PeerTransport = {
      kind: 'unix',
      createAddressHint: () => testHome,
      validateAddress: () => true,
      listen: vi.fn(async (options) => {
        signalListen()
        await listenGate
        return { address: options.address, closed: new Promise<{ expected: boolean }>(() => {}), close }
      }),
      request: vi.fn(),
    }
    const service = createPeerService({ enabled: true, name: 'late-listener', registry, transport })
    services.push(service)

    const start = service.start()
    await listenStarted
    const shutdown = service.shutdown()
    releaseListen()
    await Promise.all([start, shutdown])

    expect(service.isAvailable()).toBe(false)
    expect(close).toHaveBeenCalledOnce()
    expect(registry.write).not.toHaveBeenCalled()
  })

  it('passes startup abort to transport and closes a listener that resolves after abort', async () => {
    const registry: PeerRegistry = {
      initialize: vi.fn(async () => {}),
      write: vi.fn(),
      read: vi.fn(async () => null),
      listCandidates: vi.fn(async () => ({ candidates: [], scanned: 0, rejected: 0, truncated: false })),
      listLive: vi.fn(async () => ({ peers: [], registrations: [], partial: false })),
      removeOwn: vi.fn(async () => false),
      cleanupConfirmedDead: vi.fn(async () => false),
      paths: () => ({ registryDir: testHome, socketDir: testHome }),
    }
    let signalListen!: () => void
    const listenStarted = new Promise<void>((resolve) => (signalListen = resolve))
    let releaseListen!: () => void
    const listenGate = new Promise<void>((resolve) => (releaseListen = resolve))
    const close = vi.fn(async () => {})
    let receivedSignal: AbortSignal | undefined
    const transport: PeerTransport = {
      kind: 'unix',
      createAddressHint: () => testHome,
      validateAddress: () => true,
      listen: vi.fn(async (options) => {
        receivedSignal = options.signal
        signalListen()
        await listenGate
        return { address: options.address, closed: new Promise<{ expected: boolean }>(() => {}), close }
      }),
      request: vi.fn(),
    }
    const service = createPeerService({ enabled: true, name: 'aborted-listener', registry, transport })
    services.push(service)
    const controller = new AbortController()

    const start = service.start(controller.signal)
    await listenStarted
    controller.abort()
    releaseListen()
    await start

    expect(receivedSignal).toBe(controller.signal)
    expect(service.isAvailable()).toBe(false)
    expect(close).toHaveBeenCalledOnce()
    expect(registry.write).not.toHaveBeenCalled()
  })

  it('removes a registration write that finishes after startup is aborted', async () => {
    let registered = false
    let signalWrite!: () => void
    const writeStarted = new Promise<void>((resolve) => (signalWrite = resolve))
    let releaseWrite!: () => void
    const writeGate = new Promise<void>((resolve) => (releaseWrite = resolve))
    const registry: PeerRegistry = {
      initialize: vi.fn(async () => {}),
      write: vi.fn(async () => {
        signalWrite()
        await writeGate
        registered = true
      }),
      read: vi.fn(async () => null),
      listCandidates: vi.fn(async () => ({ candidates: [], scanned: 0, rejected: 0, truncated: false })),
      listLive: vi.fn(async () => ({ peers: [], registrations: [], partial: false })),
      removeOwn: vi.fn(async () => {
        const removed = registered
        registered = false
        return removed
      }),
      cleanupConfirmedDead: vi.fn(async () => false),
      paths: () => ({ registryDir: testHome, socketDir: testHome }),
    }
    const close = vi.fn(async () => {})
    const transport: PeerTransport = {
      kind: 'unix',
      createAddressHint: () => testHome,
      validateAddress: () => true,
      listen: vi.fn(async (options) => ({
        address: options.address,
        closed: new Promise<{ expected: boolean }>(() => {}),
        close,
      })),
      request: vi.fn(),
    }
    const service = createPeerService({ enabled: true, name: 'aborted-registration', registry, transport })
    services.push(service)
    const controller = new AbortController()

    const start = service.start(controller.signal)
    await writeStarted
    controller.abort()
    releaseWrite()
    await start

    expect(service.isAvailable()).toBe(false)
    expect(registered).toBe(false)
    expect(close).toHaveBeenCalledOnce()
    expect(registry.removeOwn).toHaveBeenCalled()
  })

  it('rejects ambiguous names with the stable error code and forbids self-send', async () => {
    const sender = await startPeer('sender')
    await startPeer('backend')
    await startPeer('backend')

    await expect(sender.sendMessage('backend', 'ambiguous')).resolves.toEqual(
      expect.objectContaining({ success: false, code: 'PEER_AMBIGUOUS_NAME' }),
    )
    await expect(sender.sendMessage(sender.identity!.address, 'self')).resolves.toEqual(
      expect.objectContaining({ success: false, code: 'PEER_SELF' }),
    )
  })

  it('retries PEER_DELIVERY_UNKNOWN only against the originally fixed receiver identity', async () => {
    const realTransport = createUnixSocketTransport()
    let dropFirstMessageAck = true
    const ackDroppingTransport: PeerTransport = {
      ...realTransport,
      request: async (options) => {
        const response = await realTransport.request(options)
        if (dropFirstMessageAck && options.frame.type === 'message') {
          dropFirstMessageAck = false
          throw new Error('simulated acknowledgement loss')
        }
        return response
      },
    }
    const sender = await startPeer('sender', 'accept', { transport: ackDroppingTransport })
    const original = await startPeer('backend')
    const originalIdentity = original.identity!

    const first = await sender.sendMessage('backend', 'exactly once payload')
    expect(first).toEqual({
      success: false,
      code: 'PEER_DELIVERY_UNKNOWN',
      reason: expect.any(String),
      messageId: expect.any(String),
    })
    if (first.success || !first.messageId) throw new Error('expected a retryable unknown result')
    expect(original.claimAccepted(10)?.messages).toEqual([
      expect.objectContaining({ id: first.messageId, text: 'exactly once payload' }),
    ])
    expect(sender.inbox.getOutboundRecord(first.messageId)).toEqual(
      expect.objectContaining({
        state: 'delivery-unknown',
        receiverInstanceId: originalIdentity.instanceId,
        receiverAddress: originalIdentity.address,
      }),
    )

    const preparedRetry = await sender.prepareSend('backend', 'exactly once payload', undefined, first.messageId)
    expect(sender.inbox.getOutboundRecord(first.messageId)?.state).toBe('delivery-unknown')
    await expect(sender.prepareSend('backend', 'exactly once payload', undefined, first.messageId)).resolves.toEqual(
      expect.objectContaining({ receiverInstanceId: originalIdentity.instanceId }),
    )
    expect(sender.inbox.getOutboundRecord(first.messageId)?.state).toBe('delivery-unknown')
    const aborted = new AbortController()
    aborted.abort()
    await expect(sender.sendPrepared(preparedRetry, aborted.signal)).resolves.toEqual(
      expect.objectContaining({ success: false, code: 'PEER_ABORTED', messageId: first.messageId }),
    )
    expect(sender.inbox.getOutboundRecord(first.messageId)?.state).toBe('delivery-unknown')

    await original.shutdown()
    const replacement = await startPeer('backend')
    expect(replacement.identity!.instanceId).not.toBe(originalIdentity.instanceId)
    await expect(sender.listAgents()).resolves.toContainEqual(
      expect.objectContaining({ name: 'backend', address: replacement.identity!.address }),
    )

    await expect(sender.sendMessage('backend', 'exactly once payload', undefined, first.messageId)).resolves.toEqual(
      expect.objectContaining({ success: false, code: 'PEER_STALE', messageId: first.messageId }),
    )
    expect(sender.inbox.getOutboundRecord(first.messageId)).toEqual(
      expect.objectContaining({
        state: 'delivery-unknown',
        receiverInstanceId: originalIdentity.instanceId,
        receiverAddress: originalIdentity.address,
      }),
    )
    expect(replacement.claimAccepted(10)).toBeNull()
  })

  it('uses independent socket paths for identities that share the same short UUID prefix', async () => {
    const firstId = 'aaaaaaaa-1111-4111-8111-111111111111'
    const secondId = 'aaaaaaaa-2222-4222-8222-222222222222'
    const makeIdentity = (instanceId: string, name: string): PeerIdentity => ({
      instanceId,
      address: `peer:${instanceId}`,
      shortId: instanceId.slice(0, 8),
      inboxToken: Buffer.alloc(32, instanceId === firstId ? 1 : 2).toString('base64url'),
      name,
      startedAt: new Date().toISOString(),
    })
    const owner = await startPeer('owner', 'accept', { identity: makeIdentity(firstId, 'owner') })
    const ownerCandidate = await candidateFor(owner)
    const before = await fs.lstat(ownerCandidate.registration.transport.address)

    const colliding = await startPeer('colliding', 'accept', { identity: makeIdentity(secondId, 'colliding') })
    const collidingCandidate = await candidateFor(colliding)

    expect(colliding.isAvailable()).toBe(true)
    expect(collidingCandidate.registration.transport.address).not.toBe(ownerCandidate.registration.transport.address)
    expect(owner.isAvailable()).toBe(true)
    const after = await fs.lstat(ownerCandidate.registration.transport.address)
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino })
    const observer = await startPeer('observer')
    await expect(
      createUnixSocketTransport().request({
        address: ownerCandidate.registration.transport.address,
        targetToken: ownerCandidate.registration.inboxToken,
        senderInstanceId: observer.identity!.instanceId,
        frame: { v: 1, type: 'ping', requestId: randomUUID() },
      }),
    ).resolves.toEqual(expect.objectContaining({ type: 'pong', instanceId: firstId }))
    await expect(observer.sendMessage(owner.identity!.address, 'owner still reachable')).resolves.toEqual({
      success: true,
      status: 'delivered',
      messageId: expect.any(String),
    })
    await expect(observer.sendMessage(colliding.identity!.address, 'colliding peer reachable')).resolves.toEqual({
      success: true,
      status: 'delivered',
      messageId: expect.any(String),
    })
    expect(owner.claimAccepted(1)?.messages).toEqual([
      expect.objectContaining({ from: expect.objectContaining({ name: 'observer' }), text: 'owner still reachable' }),
    ])
    expect(colliding.claimAccepted(1)?.messages).toEqual([
      expect.objectContaining({
        from: expect.objectContaining({ name: 'observer' }),
        text: 'colliding peer reachable',
      }),
    ])
  })
})
