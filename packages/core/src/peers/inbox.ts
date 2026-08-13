import { randomUUID } from 'node:crypto'

import type { PublicPeer } from '../types/index.js'
import {
  type AcceptedClaim,
  DEFAULT_PEER_INBOX_LIMITS,
  type DeliveryUpdateClaim,
  type DeliveryUpdateRecordResult,
  type FinalUpdateClaim,
  type HeldDecisionResult,
  type HeldPeerMessage,
  type InboundAdmissionResult,
  type InboundDisposition,
  type InboundLedgerRecord,
  type InboundLifecycleState,
  type InboundPeerMessage,
  type InboundWireStatus,
  type InboxClaimResult,
  type InboxLifecycleResult,
  type OutboundAdmissionInput,
  type OutboundAdmissionResult,
  type OutboundLedgerRecord,
  type OutboundLifecycleState,
  type OutboundRetryResult,
  type OutboundTransitionInput,
  type OutboundTransitionResult,
  type PeerDeliveryUpdate,
  type PeerInbox,
  type PeerInboxLimits,
  type PeerInboxOptions,
  type PeerInboxSnapshot,
  type PendingFinalUpdate,
} from './inbox-types.js'
import { stripTerminalControls } from './terminal-sanitize.js'

interface InternalInboundRecord extends InboundLedgerRecord {
  admittedAtMs: number
  terminalAtMs?: number
  sequence: number
  message: InboundPeerMessage
  held?: {
    heldAt: string
    expiresAt: string
    expiresAtMs: number
    policySource: 'auto' | 'explicit'
  }
}

interface InternalOutboundRecord extends OutboundLedgerRecord {
  admittedAtMs: number
  terminalAtMs?: number
  heldUntilMs?: number
  retryDeadlineAtMs?: number
  finalStatusDeadlineAtMs?: number
}

interface KeyClaim {
  claimId: string
  keys: string[]
  expiresAtMs: number
}

const INBOUND_TERMINAL = new Set<InboundLifecycleState>([
  'injected',
  'dropped-after-ack',
  'denied',
  'expired',
  'refused',
])

const OUTBOUND_TERMINAL = new Set<OutboundLifecycleState>([
  'delivered',
  'denied',
  'expired',
  'refused',
  'delivery-unknown-expired',
  'held-final-status-unknown',
])

const OUTBOUND_ACTIVE = new Set<OutboundLifecycleState>(['sending', 'held', 'delivery-unknown'])

function finitePositive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function resolveLimits(input: Partial<PeerInboxLimits> | undefined): PeerInboxLimits {
  return {
    accepted: finitePositive(input?.accepted, DEFAULT_PEER_INBOX_LIMITS.accepted),
    held: finitePositive(input?.held, DEFAULT_PEER_INBOX_LIMITS.held),
    inboundLedger: finitePositive(input?.inboundLedger, DEFAULT_PEER_INBOX_LIMITS.inboundLedger),
    outboundLedger: finitePositive(input?.outboundLedger, DEFAULT_PEER_INBOX_LIMITS.outboundLedger),
    activeOutbound: finitePositive(input?.activeOutbound, DEFAULT_PEER_INBOX_LIMITS.activeOutbound),
    deliveryNotifications: finitePositive(
      input?.deliveryNotifications,
      DEFAULT_PEER_INBOX_LIMITS.deliveryNotifications,
    ),
    finalUpdateOutbox: finitePositive(input?.finalUpdateOutbox, DEFAULT_PEER_INBOX_LIMITS.finalUpdateOutbox),
    claimLeaseMs: finitePositive(input?.claimLeaseMs, DEFAULT_PEER_INBOX_LIMITS.claimLeaseMs),
    terminalRetentionMs: finitePositive(input?.terminalRetentionMs, DEFAULT_PEER_INBOX_LIMITS.terminalRetentionMs),
    deliveryUnknownRetryMs: finitePositive(
      input?.deliveryUnknownRetryMs,
      DEFAULT_PEER_INBOX_LIMITS.deliveryUnknownRetryMs,
    ),
    finalUpdateRetryMs: finitePositive(input?.finalUpdateRetryMs, DEFAULT_PEER_INBOX_LIMITS.finalUpdateRetryMs),
    finalUpdateGraceMs: finitePositive(input?.finalUpdateGraceMs, DEFAULT_PEER_INBOX_LIMITS.finalUpdateGraceMs),
  }
}

function peerInstanceId(peer: PublicPeer): string {
  return peer.address.startsWith('peer:') ? peer.address.slice('peer:'.length) : peer.address
}

function inboundKey(message: InboundPeerMessage): string {
  return `${peerInstanceId(message.from)}:${message.id}`
}

function parseTime(value: string): number | undefined {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function clonePeer(peer: PublicPeer): PublicPeer {
  return {
    ...peer,
    name: stripTerminalControls(peer.name),
    cwd: stripTerminalControls(peer.cwd),
  }
}

function cloneMessage(message: InboundPeerMessage): InboundPeerMessage {
  return {
    ...message,
    from: clonePeer(message.from),
    text: stripTerminalControls(message.text),
    ...(message.summary === undefined ? {} : { summary: stripTerminalControls(message.summary) }),
  }
}

function cloneInboundRecord(record: InternalInboundRecord): InboundLedgerRecord {
  return {
    key: record.key,
    senderInstanceId: record.senderInstanceId,
    messageId: record.messageId,
    state: record.state,
    wireStatus: record.wireStatus,
    payloadHash: record.payloadHash,
    admittedAt: record.admittedAt,
    terminalAt: record.terminalAt,
    reason: record.reason === undefined ? undefined : stripTerminalControls(record.reason),
  }
}

function cloneOutboundRecord(record: InternalOutboundRecord): OutboundLedgerRecord {
  return {
    messageId: record.messageId,
    requestedTarget: record.requestedTarget,
    receiverInstanceId: record.receiverInstanceId,
    receiverAddress: record.receiverAddress,
    payloadHash: record.payloadHash,
    state: record.state,
    admittedAt: record.admittedAt,
    terminalAt: record.terminalAt,
    heldUntil: record.heldUntil,
    retryDeadlineAt: record.retryDeadlineAt,
    finalStatusDeadlineAt: record.finalStatusDeadlineAt,
    reason: record.reason === undefined ? undefined : stripTerminalControls(record.reason),
  }
}

function cloneDeliveryUpdate(update: PeerDeliveryUpdate): PeerDeliveryUpdate {
  return { ...update, peer: clonePeer(update.peer) }
}

function cloneFinalUpdate(update: PendingFinalUpdate): PendingFinalUpdate {
  return { ...update, target: clonePeer(update.target) }
}

function wireStatusFor(record: InternalInboundRecord): InboundWireStatus {
  if (record.wireStatus) return record.wireStatus
  if (
    record.state === 'accepted' ||
    record.state === 'claimed' ||
    record.state === 'agent-queued' ||
    record.state === 'injected' ||
    record.state === 'dropped-after-ack'
  ) {
    return 'delivered'
  }
  if (record.state === 'held') return 'held'
  if (record.state === 'denied') return 'denied'
  if (record.state === 'expired') return 'expired'
  return 'refused'
}

export function createPeerInbox(options: PeerInboxOptions = {}): PeerInbox {
  return new InMemoryPeerInbox(options)
}

class InMemoryPeerInbox implements PeerInbox {
  private readonly limits: PeerInboxLimits
  private readonly now: () => number
  private readonly onListenerError?: (error: unknown) => void
  private readonly inboundLedger = new Map<string, InternalInboundRecord>()
  private readonly outboundLedger = new Map<string, InternalOutboundRecord>()
  private readonly acceptedQueue: string[] = []
  private readonly heldQueue: string[] = []
  private readonly acceptedClaims = new Map<string, KeyClaim>()
  private readonly deliveryUpdates = new Map<string, PeerDeliveryUpdate>()
  private readonly deliveryUpdateQueue: string[] = []
  private readonly deliveryUpdateClaims = new Map<string, KeyClaim>()
  private readonly finalUpdates = new Map<string, PendingFinalUpdate>()
  private readonly finalUpdateQueue: string[] = []
  private readonly finalUpdateClaims = new Map<string, KeyClaim>()
  private readonly listeners = new Set<(snapshot: PeerInboxSnapshot) => void>()
  private revision = 0
  private sequence = 0
  private droppedDeliveryNotifications = 0
  private droppedFinalUpdates = 0
  private notificationScheduled = false
  private sweeping = false

  constructor(options: PeerInboxOptions) {
    this.limits = resolveLimits(options.limits)
    this.now = options.now ?? Date.now
    this.onListenerError = options.onListenerError
  }

  getSnapshot(): PeerInboxSnapshot {
    this.sweep()
    return this.snapshotWithoutSweep()
  }

  onChanged(listener: (snapshot: PeerInboxSnapshot) => void): () => void {
    this.listeners.add(listener)
    let subscribed = true
    const snapshotAtSubscription = this.snapshotWithoutSweep()
    if (this.hasInboxWork(snapshotAtSubscription)) {
      queueMicrotask(() => {
        if (subscribed && this.listeners.has(listener)) this.callListener(listener, this.snapshotWithoutSweep())
      })
    }
    return () => {
      subscribed = false
      this.listeners.delete(listener)
    }
  }

  admitInbound(
    message: InboundPeerMessage,
    payloadHash: string,
    disposition: InboundDisposition,
  ): InboundAdmissionResult {
    this.sweep()
    const key = inboundKey(message)
    const existing = this.inboundLedger.get(key)
    if (existing) {
      if (existing.payloadHash !== payloadHash) return { status: 'retry-mismatch', key }
      return { status: 'duplicate', key, duplicateOfStatus: wireStatusFor(existing) }
    }
    if (!this.ensureInboundSlot()) return { status: 'ledger-full' }

    const now = this.now()
    const record: InternalInboundRecord = {
      key,
      senderInstanceId: peerInstanceId(message.from),
      messageId: message.id,
      state: 'received',
      payloadHash,
      admittedAt: new Date(now).toISOString(),
      admittedAtMs: now,
      sequence: this.sequence++,
      message: cloneMessage(message),
    }
    this.inboundLedger.set(key, record)

    let result: InboundAdmissionResult
    if (disposition.kind === 'accept') {
      if (this.acceptedOccupancy() >= this.limits.accepted) {
        this.finishInbound(record, 'refused', 'refused', 'accepted-queue-full', now)
        result = { status: 'refused', key, wireStatus: 'refused', reason: 'accepted-queue-full' }
      } else {
        record.state = 'accepted'
        record.wireStatus = 'delivered'
        this.acceptedQueue.push(key)
        result = { status: 'accepted', key, wireStatus: 'delivered' }
      }
    } else if (disposition.kind === 'hold') {
      if (this.heldQueue.length >= this.limits.held) {
        this.finishInbound(record, 'refused', 'refused', 'held-queue-full', now)
        result = { status: 'refused', key, wireStatus: 'refused', reason: 'held-queue-full' }
      } else {
        const expiresAtMs = parseTime(disposition.expiresAt) ?? now
        record.state = 'held'
        record.wireStatus = 'held'
        record.held = {
          heldAt: new Date(now).toISOString(),
          expiresAt: new Date(expiresAtMs).toISOString(),
          expiresAtMs,
          policySource: disposition.policySource,
        }
        this.heldQueue.push(key)
        result = { status: 'held', key, wireStatus: 'held', heldUntil: record.held.expiresAt }
      }
    } else {
      const reason = disposition.reason ?? 'policy'
      this.finishInbound(record, 'refused', 'refused', reason, now)
      result = { status: 'refused', key, wireStatus: 'refused', reason }
    }
    this.changed()
    return result
  }

  getInboundRecord(key: string): InboundLedgerRecord | undefined {
    this.sweep()
    const record = this.inboundLedger.get(key)
    return record ? cloneInboundRecord(record) : undefined
  }

  claimAccepted(limit: number): AcceptedClaim | null {
    this.sweep()
    const count = Math.min(Math.max(0, Math.floor(limit)), this.acceptedQueue.length)
    if (count === 0) return null
    const keys = this.acceptedQueue.splice(0, count)
    for (const key of keys) {
      const record = this.inboundLedger.get(key)
      if (record?.state === 'accepted') record.state = 'claimed'
    }
    const claim = this.createClaim(keys)
    this.acceptedClaims.set(claim.claimId, claim)
    this.changed()
    return {
      claimId: claim.claimId,
      keys: keys.slice(),
      messages: keys.flatMap((key) => {
        const message = this.inboundLedger.get(key)?.message
        return message ? [cloneMessage(message)] : []
      }),
      expiresAt: new Date(claim.expiresAtMs).toISOString(),
    }
  }

  commitAcceptedClaim(claimId: string): InboxClaimResult {
    const claim = this.acceptedClaims.get(claimId)
    if (!claim) {
      this.sweep()
      return { status: 'not-found', count: 0 }
    }
    if (claim.expiresAtMs <= this.now()) {
      this.releaseAcceptedClaimInternal(claim)
      this.changed()
      return { status: 'expired', count: 0 }
    }
    this.acceptedClaims.delete(claimId)
    let count = 0
    for (const key of claim.keys) {
      const record = this.inboundLedger.get(key)
      if (record?.state !== 'claimed') continue
      record.state = 'agent-queued'
      count++
    }
    this.changed()
    return { status: 'committed', count }
  }

  releaseAcceptedClaim(claimId: string): InboxClaimResult {
    const claim = this.acceptedClaims.get(claimId)
    if (!claim) {
      this.sweep()
      return { status: 'not-found', count: 0 }
    }
    if (claim.expiresAtMs <= this.now()) {
      this.releaseAcceptedClaimInternal(claim)
      this.changed()
      return { status: 'expired', count: 0 }
    }
    const count = this.releaseAcceptedClaimInternal(claim)
    this.changed()
    return { status: 'released', count }
  }

  markAgentInputsInjected(keys: readonly string[]): InboxLifecycleResult {
    return this.finishAgentInputs(keys, 'injected')
  }

  markAgentInputsDropped(keys: readonly string[], reason: string): InboxLifecycleResult {
    return this.finishAgentInputs(keys, 'dropped-after-ack', reason)
  }

  listHeld(): readonly HeldPeerMessage[] {
    this.sweep()
    return this.heldQueue.flatMap((key) => {
      const record = this.inboundLedger.get(key)
      if (!record?.held || record.state !== 'held') return []
      return [
        {
          key,
          message: cloneMessage(record.message),
          heldAt: record.held.heldAt,
          expiresAt: record.held.expiresAt,
          policySource: record.held.policySource,
        },
      ]
    })
  }

  decideHeld(key: string, decision: 'accept' | 'reject'): HeldDecisionResult {
    this.sweep()
    const record = this.inboundLedger.get(key)
    if (!record) return { status: 'not-found', key }
    if (record.state !== 'held') return { status: 'already-decided', key }
    if (decision === 'accept' && this.acceptedOccupancy() >= this.limits.accepted) {
      return { status: 'queue-full', key }
    }

    this.removeKey(this.heldQueue, key)
    delete record.held
    if (decision === 'accept') {
      record.state = 'accepted'
      record.wireStatus = 'delivered'
      this.acceptedQueue.push(key)
      this.enqueueFinalUpdate(record, 'delivered')
      this.changed()
      return { status: 'accepted', key }
    }

    this.finishInbound(record, 'denied', 'denied', 'rejected-by-user', this.now())
    this.enqueueFinalUpdate(record, 'denied')
    this.changed()
    return { status: 'rejected', key }
  }

  expireAllHeld(reason = 'receiver-shutdown'): InboxLifecycleResult {
    this.sweep()
    const keys = this.heldQueue.slice()
    let transitioned = 0
    for (const key of keys) {
      const record = this.inboundLedger.get(key)
      if (record?.state !== 'held') continue
      const index = this.heldQueue.indexOf(key)
      if (index >= 0) this.heldQueue.splice(index, 1)
      this.finishInbound(record, 'expired', 'expired', reason, this.now())
      this.enqueueFinalUpdate(record, 'expired', reason)
      transitioned++
    }
    if (transitioned > 0) this.changed()
    return { transitioned, alreadyTerminal: 0, notFound: 0 }
  }

  claimDeliveryUpdates(limit: number): DeliveryUpdateClaim | null {
    this.sweep()
    const claim = this.claimQueue(this.deliveryUpdateQueue, this.deliveryUpdateClaims, limit)
    if (!claim) return null
    this.changed()
    return {
      claimId: claim.claimId,
      updates: claim.keys.flatMap((key) => {
        const update = this.deliveryUpdates.get(key)
        return update ? [cloneDeliveryUpdate(update)] : []
      }),
      expiresAt: new Date(claim.expiresAtMs).toISOString(),
    }
  }

  commitDeliveryUpdateClaim(claimId: string): InboxClaimResult {
    return this.commitQueueClaim(claimId, this.deliveryUpdateClaims, this.deliveryUpdateQueue, this.deliveryUpdates)
  }

  releaseDeliveryUpdateClaim(claimId: string): InboxClaimResult {
    return this.releaseQueueClaim(claimId, this.deliveryUpdateClaims, this.deliveryUpdateQueue)
  }

  claimFinalUpdates(limit: number): FinalUpdateClaim | null {
    this.sweep()
    const claim = this.claimQueue(this.finalUpdateQueue, this.finalUpdateClaims, limit)
    if (!claim) return null
    this.changed()
    return {
      claimId: claim.claimId,
      updates: claim.keys.flatMap((key) => {
        const update = this.finalUpdates.get(key)
        return update ? [cloneFinalUpdate(update)] : []
      }),
      expiresAt: new Date(claim.expiresAtMs).toISOString(),
    }
  }

  commitFinalUpdateClaim(claimId: string): InboxClaimResult {
    return this.commitQueueClaim(claimId, this.finalUpdateClaims, this.finalUpdateQueue, this.finalUpdates)
  }

  releaseFinalUpdateClaim(claimId: string): InboxClaimResult {
    return this.releaseQueueClaim(claimId, this.finalUpdateClaims, this.finalUpdateQueue)
  }

  admitOutbound(input: OutboundAdmissionInput): OutboundAdmissionResult {
    this.sweep()
    const existing = this.outboundLedger.get(input.messageId)
    if (existing) {
      const fixedIdentityMatches =
        existing.requestedTarget === input.requestedTarget &&
        existing.receiverInstanceId === input.receiverInstanceId &&
        existing.receiverAddress === input.receiverAddress &&
        existing.payloadHash === input.payloadHash
      return fixedIdentityMatches
        ? { status: 'duplicate', record: cloneOutboundRecord(existing) }
        : { status: 'retry-mismatch', record: cloneOutboundRecord(existing) }
    }
    if (this.activeOutboundCount() >= this.limits.activeOutbound) return { status: 'active-full' }
    if (!this.ensureOutboundSlot()) return { status: 'ledger-full' }

    const now = this.now()
    const record: InternalOutboundRecord = {
      ...input,
      state: 'sending',
      admittedAt: new Date(now).toISOString(),
      admittedAtMs: now,
    }
    this.outboundLedger.set(input.messageId, record)
    this.changed()
    return { status: 'admitted', record: cloneOutboundRecord(record) }
  }

  getOutboundRecord(messageId: string): OutboundLedgerRecord | undefined {
    this.sweep()
    const record = this.outboundLedger.get(messageId)
    return record ? cloneOutboundRecord(record) : undefined
  }

  transitionOutbound(messageId: string, transition: OutboundTransitionInput): OutboundTransitionResult {
    this.sweep()
    const record = this.outboundLedger.get(messageId)
    if (!record) return { status: 'not-found' }
    if (record.state === transition.state) return { status: 'duplicate', record: cloneOutboundRecord(record) }
    if (!this.canTransitionOutbound(record.state, transition.state)) {
      return { status: 'invalid-transition', record: cloneOutboundRecord(record) }
    }

    const now = this.now()
    record.state = transition.state
    record.reason = transition.reason === undefined ? undefined : stripTerminalControls(transition.reason)
    if (transition.state === 'held') {
      const heldUntilMs = parseTime(transition.heldUntil) ?? now
      record.heldUntilMs = heldUntilMs
      record.heldUntil = new Date(heldUntilMs).toISOString()
      record.finalStatusDeadlineAtMs = heldUntilMs + this.limits.finalUpdateRetryMs + this.limits.finalUpdateGraceMs
      record.finalStatusDeadlineAt = new Date(record.finalStatusDeadlineAtMs).toISOString()
    } else if (transition.state === 'delivery-unknown') {
      const deadline =
        (transition.retryDeadlineAt ? parseTime(transition.retryDeadlineAt) : undefined) ??
        record.retryDeadlineAtMs ??
        now + this.limits.deliveryUnknownRetryMs
      record.retryDeadlineAtMs = deadline
      record.retryDeadlineAt = new Date(deadline).toISOString()
    } else {
      this.finishOutbound(record, transition.state, now)
    }
    this.changed()
    return { status: 'transitioned', record: cloneOutboundRecord(record) }
  }

  inspectOutboundRetry(messageId: string, requestedTarget: string, payloadHash: string): OutboundRetryResult {
    this.sweep()
    const record = this.outboundLedger.get(messageId)
    if (!record) return { status: 'not-found' }
    if (record.requestedTarget !== requestedTarget || record.payloadHash !== payloadHash) {
      return { status: 'retry-mismatch', record: cloneOutboundRecord(record) }
    }
    if (record.state === 'delivery-unknown-expired') {
      return { status: 'expired', record: cloneOutboundRecord(record) }
    }
    if (record.state !== 'delivery-unknown') {
      return { status: 'not-retryable', record: cloneOutboundRecord(record) }
    }
    const now = this.now()
    if (record.retryDeadlineAtMs !== undefined && record.retryDeadlineAtMs <= now) {
      this.finishOutbound(record, 'delivery-unknown-expired', now)
      this.changed()
      return { status: 'expired', record: cloneOutboundRecord(record) }
    }
    return { status: 'ready', record: cloneOutboundRecord(record) }
  }

  beginOutboundRetry(messageId: string, requestedTarget: string, payloadHash: string): OutboundRetryResult {
    const inspected = this.inspectOutboundRetry(messageId, requestedTarget, payloadHash)
    if (inspected.status !== 'ready') return inspected
    const record = this.outboundLedger.get(messageId)
    if (!record || record.state !== 'delivery-unknown') {
      return record ? { status: 'not-retryable', record: cloneOutboundRecord(record) } : { status: 'not-found' }
    }
    record.state = 'sending'
    this.changed()
    return { status: 'ready', record: cloneOutboundRecord(record) }
  }

  recordDeliveryUpdate(input: {
    messageId: string
    receiverInstanceId: string
    peer: PublicPeer
    status: 'delivered' | 'denied' | 'expired'
    receivedAt?: string
  }): DeliveryUpdateRecordResult {
    this.sweep()
    const record = this.outboundLedger.get(input.messageId)
    if (!record) return { status: 'ignored', reason: 'not-found' }
    if (record.receiverInstanceId !== input.receiverInstanceId || record.receiverAddress !== input.peer.address) {
      return { status: 'ignored', reason: 'target-mismatch', record: cloneOutboundRecord(record) }
    }
    if (record.state === input.status) return { status: 'duplicate', record: cloneOutboundRecord(record) }
    if (record.state !== 'held' && record.state !== 'held-final-status-unknown') {
      return { status: 'ignored', reason: 'state-conflict', record: cloneOutboundRecord(record) }
    }

    this.finishOutbound(record, input.status, this.now())
    this.enqueueDeliveryNotification({
      messageId: input.messageId,
      peer: clonePeer(input.peer),
      status: input.status,
      receivedAt: input.receivedAt ?? new Date(this.now()).toISOString(),
    })
    this.changed()
    return { status: 'recorded', record: cloneOutboundRecord(record) }
  }

  sweep(): void {
    if (this.sweeping) return
    this.sweeping = true
    try {
      const now = this.now()
      let changed = false
      changed = this.expireAcceptedClaims(now) || changed
      changed = this.expireQueueClaims(this.deliveryUpdateClaims, this.deliveryUpdateQueue, now) || changed
      changed = this.expireQueueClaims(this.finalUpdateClaims, this.finalUpdateQueue, now) || changed
      changed = this.expireHeld(now) || changed
      changed = this.expireOutbound(now) || changed
      if (changed) this.changed()
    } finally {
      this.sweeping = false
    }
  }

  private snapshotWithoutSweep(): PeerInboxSnapshot {
    return {
      accepted: this.acceptedOccupancy(),
      held: this.heldQueue.length,
      deliveryUpdates: this.deliveryUpdates.size,
      pendingFinalUpdates: this.finalUpdates.size,
      droppedDeliveryNotifications: this.droppedDeliveryNotifications,
      droppedFinalUpdates: this.droppedFinalUpdates,
      inboundLedger: this.inboundLedger.size,
      outboundLedger: this.outboundLedger.size,
      activeOutbound: this.activeOutboundCount(),
      revision: this.revision,
    }
  }

  private hasInboxWork(snapshot: PeerInboxSnapshot): boolean {
    return (
      snapshot.accepted > 0 || snapshot.held > 0 || snapshot.deliveryUpdates > 0 || snapshot.pendingFinalUpdates > 0
    )
  }

  private changed(): void {
    this.revision++
    if (this.notificationScheduled) return
    this.notificationScheduled = true
    const recipients = [...this.listeners]
    queueMicrotask(() => {
      this.notificationScheduled = false
      const snapshot = this.snapshotWithoutSweep()
      for (const listener of recipients) {
        if (this.listeners.has(listener)) this.callListener(listener, snapshot)
      }
    })
  }

  private callListener(listener: (snapshot: PeerInboxSnapshot) => void, snapshot: PeerInboxSnapshot): void {
    try {
      listener({ ...snapshot })
    } catch (error) {
      try {
        this.onListenerError?.(error)
      } catch {
        // Diagnostics must never acquire queue ownership or break the producer.
      }
    }
  }

  private acceptedOccupancy(): number {
    let count = 0
    for (const record of this.inboundLedger.values()) {
      if (record.state === 'accepted' || record.state === 'claimed') count++
    }
    return count
  }

  private activeOutboundCount(): number {
    let count = 0
    for (const record of this.outboundLedger.values()) if (OUTBOUND_ACTIVE.has(record.state)) count++
    return count
  }

  private ensureInboundSlot(): boolean {
    if (this.inboundLedger.size < this.limits.inboundLedger) return true
    this.evictInboundTerminals()
    return this.inboundLedger.size < this.limits.inboundLedger
  }

  private ensureOutboundSlot(): boolean {
    if (this.outboundLedger.size < this.limits.outboundLedger) return true
    this.evictOutboundTerminals()
    return this.outboundLedger.size < this.limits.outboundLedger
  }

  private evictInboundTerminals(): void {
    const eligibleBefore = this.now() - this.limits.terminalRetentionMs
    const candidates = [...this.inboundLedger.values()]
      .filter(
        (record) =>
          INBOUND_TERMINAL.has(record.state) &&
          record.terminalAtMs !== undefined &&
          record.terminalAtMs <= eligibleBefore,
      )
      .sort((a, b) => (a.terminalAtMs ?? 0) - (b.terminalAtMs ?? 0) || a.sequence - b.sequence)
    for (const record of candidates) {
      if (this.inboundLedger.size < this.limits.inboundLedger) break
      this.inboundLedger.delete(record.key)
    }
  }

  private evictOutboundTerminals(): void {
    const eligibleBefore = this.now() - this.limits.terminalRetentionMs
    const candidates = [...this.outboundLedger.values()]
      .filter(
        (record) =>
          OUTBOUND_TERMINAL.has(record.state) &&
          record.terminalAtMs !== undefined &&
          record.terminalAtMs <= eligibleBefore,
      )
      .sort((a, b) => (a.terminalAtMs ?? 0) - (b.terminalAtMs ?? 0) || a.admittedAtMs - b.admittedAtMs)
    for (const record of candidates) {
      if (this.outboundLedger.size < this.limits.outboundLedger) break
      this.outboundLedger.delete(record.messageId)
    }
  }

  private finishInbound(
    record: InternalInboundRecord,
    state: Extract<InboundLifecycleState, 'injected' | 'dropped-after-ack' | 'denied' | 'expired' | 'refused'>,
    wireStatus: InboundWireStatus,
    reason: string | undefined,
    now: number,
  ): void {
    record.state = state
    record.wireStatus = wireStatus
    record.reason = reason === undefined ? undefined : stripTerminalControls(reason)
    record.terminalAtMs = now
    record.terminalAt = new Date(now).toISOString()
    delete record.held
  }

  private finishOutbound(
    record: InternalOutboundRecord,
    state: Extract<
      OutboundLifecycleState,
      'delivered' | 'denied' | 'expired' | 'refused' | 'delivery-unknown-expired' | 'held-final-status-unknown'
    >,
    now: number,
  ): void {
    record.state = state
    record.terminalAtMs = now
    record.terminalAt = new Date(now).toISOString()
  }

  private createClaim(keys: string[]): KeyClaim {
    return {
      claimId: randomUUID(),
      keys,
      expiresAtMs: this.now() + this.limits.claimLeaseMs,
    }
  }

  private releaseAcceptedClaimInternal(claim: KeyClaim): number {
    this.acceptedClaims.delete(claim.claimId)
    let count = 0
    for (const key of claim.keys) {
      const record = this.inboundLedger.get(key)
      if (record?.state !== 'claimed') continue
      record.state = 'accepted'
      this.acceptedQueue.push(key)
      count++
    }
    this.sortAcceptedQueue()
    return count
  }

  private sortAcceptedQueue(): void {
    this.acceptedQueue.sort((a, b) => {
      const aSequence = this.inboundLedger.get(a)?.sequence ?? Number.MAX_SAFE_INTEGER
      const bSequence = this.inboundLedger.get(b)?.sequence ?? Number.MAX_SAFE_INTEGER
      return aSequence - bSequence
    })
  }

  private finishAgentInputs(
    keys: readonly string[],
    state: 'injected' | 'dropped-after-ack',
    reason?: string,
  ): InboxLifecycleResult {
    this.sweep()
    const result: InboxLifecycleResult = { transitioned: 0, alreadyTerminal: 0, notFound: 0 }
    const now = this.now()
    for (const key of keys) {
      const record = this.inboundLedger.get(key)
      if (!record) {
        result.notFound++
      } else if (INBOUND_TERMINAL.has(record.state)) {
        result.alreadyTerminal++
      } else if (record.state === 'agent-queued') {
        this.finishInbound(record, state, 'delivered', reason, now)
        result.transitioned++
      } else {
        result.notFound++
      }
    }
    if (result.transitioned > 0) this.changed()
    return result
  }

  private claimQueue(queue: string[], claims: Map<string, KeyClaim>, limit: number): KeyClaim | null {
    const count = Math.min(Math.max(0, Math.floor(limit)), queue.length)
    if (count === 0) return null
    const claim = this.createClaim(queue.splice(0, count))
    claims.set(claim.claimId, claim)
    return claim
  }

  private commitQueueClaim<T>(
    claimId: string,
    claims: Map<string, KeyClaim>,
    queue: string[],
    values: Map<string, T>,
  ): InboxClaimResult {
    const claim = claims.get(claimId)
    if (!claim) {
      this.sweep()
      return { status: 'not-found', count: 0 }
    }
    if (claim.expiresAtMs <= this.now()) {
      claims.delete(claimId)
      queue.unshift(...claim.keys)
      this.changed()
      return { status: 'expired', count: 0 }
    }
    claims.delete(claimId)
    let count = 0
    for (const key of claim.keys) if (values.delete(key)) count++
    this.changed()
    return { status: 'committed', count }
  }

  private releaseQueueClaim(claimId: string, claims: Map<string, KeyClaim>, queue: string[]): InboxClaimResult {
    const claim = claims.get(claimId)
    if (!claim) {
      this.sweep()
      return { status: 'not-found', count: 0 }
    }
    claims.delete(claimId)
    queue.unshift(...claim.keys)
    this.changed()
    if (claim.expiresAtMs <= this.now()) return { status: 'expired', count: 0 }
    return { status: 'released', count: claim.keys.length }
  }

  private enqueueDeliveryNotification(update: PeerDeliveryUpdate): void {
    const key = update.messageId
    if (this.deliveryUpdates.has(key)) return
    if (this.deliveryUpdates.size >= this.limits.deliveryNotifications) {
      const evicted = this.deliveryUpdateQueue.shift()
      if (evicted) this.deliveryUpdates.delete(evicted)
      else {
        this.droppedDeliveryNotifications++
        return
      }
      this.droppedDeliveryNotifications++
    }
    this.deliveryUpdates.set(key, cloneDeliveryUpdate(update))
    this.deliveryUpdateQueue.push(key)
  }

  private enqueueFinalUpdate(
    record: InternalInboundRecord,
    status: PendingFinalUpdate['status'],
    reason?: string,
  ): void {
    const key = `${record.senderInstanceId}:${record.messageId}`
    if (this.finalUpdates.has(key)) return
    if (this.finalUpdates.size >= this.limits.finalUpdateOutbox) {
      this.droppedFinalUpdates++
      return
    }
    const update: PendingFinalUpdate = {
      key,
      messageId: record.messageId,
      target: clonePeer(record.message.from),
      status,
      reason: reason === undefined ? undefined : stripTerminalControls(reason),
      createdAt: new Date(this.now()).toISOString(),
    }
    this.finalUpdates.set(key, update)
    this.finalUpdateQueue.push(key)
  }

  private canTransitionOutbound(from: OutboundLifecycleState, to: OutboundTransitionInput['state']): boolean {
    if (from === 'sending') {
      return (
        to === 'held' ||
        to === 'delivery-unknown' ||
        to === 'delivered' ||
        to === 'denied' ||
        to === 'expired' ||
        to === 'refused'
      )
    }
    if (from === 'held') return to === 'delivered' || to === 'denied' || to === 'expired'
    return false
  }

  private expireAcceptedClaims(now: number): boolean {
    let changed = false
    for (const claim of [...this.acceptedClaims.values()]) {
      if (claim.expiresAtMs > now) continue
      this.releaseAcceptedClaimInternal(claim)
      changed = true
    }
    return changed
  }

  private expireQueueClaims(claims: Map<string, KeyClaim>, queue: string[], now: number): boolean {
    const released: string[] = []
    for (const claim of [...claims.values()]) {
      if (claim.expiresAtMs > now) continue
      claims.delete(claim.claimId)
      released.push(...claim.keys)
    }
    if (released.length === 0) return false
    queue.unshift(...released)
    return true
  }

  private expireHeld(now: number): boolean {
    let changed = false
    for (const key of [...this.heldQueue]) {
      const record = this.inboundLedger.get(key)
      if (!record?.held || record.state !== 'held' || record.held.expiresAtMs > now) continue
      this.removeKey(this.heldQueue, key)
      this.finishInbound(record, 'expired', 'expired', 'held-expired', now)
      this.enqueueFinalUpdate(record, 'expired')
      changed = true
    }
    return changed
  }

  private expireOutbound(now: number): boolean {
    let changed = false
    for (const record of this.outboundLedger.values()) {
      if (
        record.state === 'delivery-unknown' &&
        record.retryDeadlineAtMs !== undefined &&
        record.retryDeadlineAtMs <= now
      ) {
        this.finishOutbound(record, 'delivery-unknown-expired', now)
        changed = true
      } else if (
        record.state === 'held' &&
        record.finalStatusDeadlineAtMs !== undefined &&
        record.finalStatusDeadlineAtMs <= now
      ) {
        this.finishOutbound(record, 'held-final-status-unknown', now)
        this.enqueueDeliveryNotification({
          messageId: record.messageId,
          peer: {
            name: record.requestedTarget,
            address: record.receiverAddress,
            cwd: '',
            status: 'waiting',
            startedAt: record.admittedAt,
          },
          status: 'final-status-unknown',
          receivedAt: new Date(now).toISOString(),
        })
        changed = true
      }
    }
    return changed
  }

  private removeKey(queue: string[], key: string): void {
    const index = queue.indexOf(key)
    if (index >= 0) queue.splice(index, 1)
  }
}
