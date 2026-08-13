import type { PublicPeer } from '../types/index.js'

export const DEFAULT_PEER_INBOX_LIMITS = {
  accepted: 50,
  held: 100,
  inboundLedger: 2_048,
  outboundLedger: 2_048,
  activeOutbound: 256,
  deliveryNotifications: 256,
  finalUpdateOutbox: 256,
  claimLeaseMs: 30_000,
  terminalRetentionMs: 10 * 60_000,
  deliveryUnknownRetryMs: 10 * 60_000,
  finalUpdateRetryMs: 5 * 60_000,
  finalUpdateGraceMs: 60_000,
} as const

export interface PeerInboxLimits {
  accepted: number
  held: number
  inboundLedger: number
  outboundLedger: number
  activeOutbound: number
  deliveryNotifications: number
  finalUpdateOutbox: number
  claimLeaseMs: number
  terminalRetentionMs: number
  deliveryUnknownRetryMs: number
  finalUpdateRetryMs: number
  finalUpdateGraceMs: number
}

export interface PeerInboxOptions {
  limits?: Partial<PeerInboxLimits>
  now?: () => number
  onListenerError?: (error: unknown) => void
}

export interface InboundPeerMessage {
  id: string
  from: PublicPeer
  text: string
  summary?: string
  sentAt: string
  receivedAt: string
  senderPermissionClass: 'prompted' | 'bypass'
}

export type InboundLifecycleState =
  | 'received'
  | 'held'
  | 'accepted'
  | 'claimed'
  | 'agent-queued'
  | 'injected'
  | 'dropped-after-ack'
  | 'denied'
  | 'expired'
  | 'refused'

export type InboundWireStatus = 'delivered' | 'held' | 'denied' | 'expired' | 'refused'

export interface InboundLedgerRecord {
  key: string
  senderInstanceId: string
  messageId: string
  state: InboundLifecycleState
  wireStatus?: InboundWireStatus
  payloadHash: string
  admittedAt: string
  terminalAt?: string
  reason?: string
}

export type InboundRefusalReason = 'policy' | 'rate-limit' | 'accepted-queue-full' | 'held-queue-full'

export type InboundDisposition =
  | { kind: 'accept' }
  | { kind: 'hold'; expiresAt: string; policySource: 'auto' | 'explicit' }
  | { kind: 'refuse'; reason?: InboundRefusalReason }

export type InboundAdmissionResult =
  | { status: 'accepted'; key: string; wireStatus: 'delivered' }
  | { status: 'held'; key: string; wireStatus: 'held'; heldUntil: string }
  | {
      status: 'refused'
      key: string
      wireStatus: 'refused'
      reason: InboundRefusalReason
    }
  | { status: 'duplicate'; key: string; duplicateOfStatus: InboundWireStatus }
  | { status: 'retry-mismatch'; key: string }
  | { status: 'ledger-full' }

export interface HeldPeerMessage {
  key: string
  message: InboundPeerMessage
  heldAt: string
  expiresAt: string
  policySource: 'auto' | 'explicit'
}

export interface AcceptedClaim {
  claimId: string
  keys: readonly string[]
  messages: readonly InboundPeerMessage[]
  expiresAt: string
}

export interface PeerDeliveryUpdate {
  messageId: string
  peer: PublicPeer
  status: 'delivered' | 'denied' | 'expired' | 'final-status-unknown'
  receivedAt: string
}

export interface DeliveryUpdateClaim {
  claimId: string
  updates: readonly PeerDeliveryUpdate[]
  expiresAt: string
}

export interface PendingFinalUpdate {
  key: string
  messageId: string
  target: PublicPeer
  status: 'delivered' | 'denied' | 'expired'
  reason?: string
  createdAt: string
}

export interface FinalUpdateClaim {
  claimId: string
  updates: readonly PendingFinalUpdate[]
  expiresAt: string
}

export type InboxClaimResult =
  | { status: 'committed' | 'released'; count: number }
  | { status: 'not-found' | 'expired'; count: 0 }

export type HeldDecisionResult =
  | { status: 'accepted' | 'rejected'; key: string }
  | { status: 'queue-full'; key: string }
  | { status: 'not-found' | 'already-decided'; key: string }

export interface InboxLifecycleResult {
  transitioned: number
  alreadyTerminal: number
  notFound: number
}

export type OutboundLifecycleState =
  | 'sending'
  | 'held'
  | 'delivery-unknown'
  | 'delivered'
  | 'denied'
  | 'expired'
  | 'refused'
  | 'delivery-unknown-expired'
  | 'held-final-status-unknown'

export interface OutboundLedgerRecord {
  messageId: string
  requestedTarget: string
  receiverInstanceId: string
  receiverAddress: `peer:${string}`
  payloadHash: string
  state: OutboundLifecycleState
  admittedAt: string
  terminalAt?: string
  heldUntil?: string
  retryDeadlineAt?: string
  finalStatusDeadlineAt?: string
  reason?: string
}

export interface OutboundAdmissionInput {
  messageId: string
  requestedTarget: string
  receiverInstanceId: string
  receiverAddress: `peer:${string}`
  payloadHash: string
}

export type OutboundAdmissionResult =
  | { status: 'admitted'; record: OutboundLedgerRecord }
  | { status: 'duplicate'; record: OutboundLedgerRecord }
  | { status: 'retry-mismatch'; record: OutboundLedgerRecord }
  | { status: 'active-full' | 'ledger-full' }

export type OutboundTransitionInput =
  | { state: 'held'; heldUntil: string; reason?: string }
  | { state: 'delivery-unknown'; retryDeadlineAt?: string; reason?: string }
  | { state: 'delivered' | 'denied' | 'expired' | 'refused'; reason?: string }

export type OutboundTransitionResult =
  | { status: 'transitioned'; record: OutboundLedgerRecord }
  | { status: 'duplicate'; record: OutboundLedgerRecord }
  | { status: 'invalid-transition'; record: OutboundLedgerRecord }
  | { status: 'not-found' }

export type OutboundRetryResult =
  | { status: 'ready'; record: OutboundLedgerRecord }
  | { status: 'retry-mismatch' | 'not-retryable' | 'expired'; record: OutboundLedgerRecord }
  | { status: 'not-found' }

export type DeliveryUpdateRecordResult =
  | { status: 'recorded' | 'duplicate'; record: OutboundLedgerRecord }
  | { status: 'ignored'; reason: 'not-found' | 'target-mismatch' | 'state-conflict'; record?: OutboundLedgerRecord }

export interface PeerInboxSnapshot {
  accepted: number
  held: number
  deliveryUpdates: number
  pendingFinalUpdates: number
  droppedDeliveryNotifications: number
  droppedFinalUpdates: number
  inboundLedger: number
  outboundLedger: number
  activeOutbound: number
  revision: number
}

export interface PeerInbox {
  getSnapshot(): PeerInboxSnapshot
  onChanged(listener: (snapshot: PeerInboxSnapshot) => void): () => void
  admitInbound(
    message: InboundPeerMessage,
    payloadHash: string,
    disposition: InboundDisposition,
  ): InboundAdmissionResult
  getInboundRecord(key: string): InboundLedgerRecord | undefined
  claimAccepted(limit: number): AcceptedClaim | null
  commitAcceptedClaim(claimId: string): InboxClaimResult
  releaseAcceptedClaim(claimId: string): InboxClaimResult
  markAgentInputsInjected(keys: readonly string[]): InboxLifecycleResult
  markAgentInputsDropped(keys: readonly string[], reason: string): InboxLifecycleResult
  listHeld(): readonly HeldPeerMessage[]
  decideHeld(key: string, decision: 'accept' | 'reject'): HeldDecisionResult
  expireAllHeld(reason?: string): InboxLifecycleResult
  claimDeliveryUpdates(limit: number): DeliveryUpdateClaim | null
  commitDeliveryUpdateClaim(claimId: string): InboxClaimResult
  releaseDeliveryUpdateClaim(claimId: string): InboxClaimResult
  claimFinalUpdates(limit: number): FinalUpdateClaim | null
  commitFinalUpdateClaim(claimId: string): InboxClaimResult
  releaseFinalUpdateClaim(claimId: string): InboxClaimResult
  admitOutbound(input: OutboundAdmissionInput): OutboundAdmissionResult
  getOutboundRecord(messageId: string): OutboundLedgerRecord | undefined
  transitionOutbound(messageId: string, transition: OutboundTransitionInput): OutboundTransitionResult
  inspectOutboundRetry(messageId: string, requestedTarget: string, payloadHash: string): OutboundRetryResult
  beginOutboundRetry(messageId: string, requestedTarget: string, payloadHash: string): OutboundRetryResult
  recordDeliveryUpdate(input: {
    messageId: string
    receiverInstanceId: string
    peer: PublicPeer
    status: 'delivered' | 'denied' | 'expired'
    receivedAt?: string
  }): DeliveryUpdateRecordResult
  sweep(): void
}
