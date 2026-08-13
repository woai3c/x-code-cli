import { useCallback, useEffect, useRef, useState } from 'react'

import type { HeldPeerMessage, PeerInboxSnapshot, PeerService, PublicPeer } from '@x-code-cli/core'

import type { TurnOwner } from './turn-coordinator.js'

export interface PeerInboxAdapterOptions {
  service?: PeerService
  activeOwner: () => TurnOwner | null
  dialogsBlocked: boolean
  enqueuePeerInput(input: { content: string; peer: PublicPeer; messageId: string; inboxKey: string }): boolean
  addPeerStatus(content: string, peer?: PublicPeer): void
  addHeldPeerPreview(content: string, peer: PublicPeer, summary?: string): void
  askQuestion(
    question: string,
    options: { label: string; description: string }[],
    opts?: { noOther?: boolean; layout?: 'compact' | 'compact-vertical' },
  ): Promise<string>
}

const EMPTY_SNAPSHOT: PeerInboxSnapshot = {
  accepted: 0,
  held: 0,
  deliveryUpdates: 0,
  pendingFinalUpdates: 0,
  droppedDeliveryNotifications: 0,
  droppedFinalUpdates: 0,
  inboundLedger: 0,
  outboundLedger: 0,
  activeOutbound: 0,
  revision: 0,
}

export function blocksPeerClaim(owner: TurnOwner | null): boolean {
  return owner === 'goal' || owner === 'compact' || owner === 'resume' || owner === 'rewind' || owner === 'clear'
}

export function formatDeliveryUpdateStatus(update: {
  messageId: string
  status: 'delivered' | 'denied' | 'expired' | 'final-status-unknown'
  peer: PublicPeer
}): string {
  if (update.status === 'final-status-unknown') {
    return `Message ${update.messageId.slice(0, 8)}: PEER_FINAL_STATUS_UNKNOWN for ${update.peer.name}; it was held, but the final accept/refuse result is unknown.`
  }
  const label = update.status === 'delivered' ? 'accepted' : update.status
  return `Message ${update.messageId.slice(0, 8)}: ${label} by ${update.peer.name}.`
}

export function transferAcceptedToAgentQueue(
  service: PeerService,
  enqueuePeerInput: PeerInboxAdapterOptions['enqueuePeerInput'],
  limit = 50,
): number {
  let transferred = 0
  while (transferred < limit) {
    const claim = service.claimAccepted(1)
    if (!claim) break
    const message = claim.messages[0]
    const key = claim.keys[0]
    if (
      !message ||
      !key ||
      !enqueuePeerInput({ content: message.text, peer: message.from, messageId: message.id, inboxKey: key })
    ) {
      service.releaseAcceptedClaim(claim.claimId)
      break
    }
    service.commitAcceptedClaim(claim.claimId)
    transferred++
  }
  return transferred
}

function heldPrompt(entry: HeldPeerMessage): string {
  const summary = entry.message.summary ? ` Summary: ${entry.message.summary}` : ''
  return `Accept held message from ${entry.message.from.name} (${entry.message.from.address})?${summary}`
}

export function usePeerInboxAdapter(options: PeerInboxAdapterOptions): PeerInboxSnapshot {
  const { service, activeOwner, dialogsBlocked, enqueuePeerInput, addPeerStatus, addHeldPeerPreview, askQuestion } =
    options
  const [snapshot, setSnapshot] = useState(() => service?.inbox.getSnapshot() ?? EMPTY_SNAPSHOT)
  const [pumpTick, setPumpTick] = useState(0)
  const heldDialogKeyRef = useRef<string | null>(null)

  const pump = useCallback(() => {
    if (!service || !service.isAvailable()) return

    const updateClaim = service.claimDeliveryUpdates(32)
    if (updateClaim) {
      try {
        for (const update of updateClaim.updates) {
          addPeerStatus(formatDeliveryUpdateStatus(update), update.peer)
        }
        service.commitDeliveryUpdateClaim(updateClaim.claimId)
      } catch {
        service.releaseDeliveryUpdateClaim(updateClaim.claimId)
      }
    }

    if (dialogsBlocked || blocksPeerClaim(activeOwner())) return
    transferAcceptedToAgentQueue(service, enqueuePeerInput)

    const held = service.listHeld()[0]
    if (!held || heldDialogKeyRef.current) return
    heldDialogKeyRef.current = held.key
    addHeldPeerPreview(held.message.text, held.message.from, held.message.summary)
    void askQuestion(
      heldPrompt(held),
      [
        { label: 'Accept', description: 'Queue this plain-text message for the agent.' },
        { label: 'Refuse', description: 'Reject it and notify the sender.' },
      ],
      { noOther: true, layout: 'compact-vertical' },
    )
      .then(async (answer) => {
        const decision = answer === 'Accept' ? 'accept' : 'reject'
        const result = await service.decideHeld(held.key, decision)
        addPeerStatus(
          result.status === 'accepted'
            ? `Accepted held message from ${held.message.from.name}.`
            : result.status === 'rejected'
              ? `Refused held message from ${held.message.from.name}.`
              : `Held message decision failed: ${result.status}.`,
          held.message.from,
        )
      })
      .finally(() => {
        heldDialogKeyRef.current = null
        setPumpTick((value) => value + 1)
      })
  }, [activeOwner, addHeldPeerPreview, addPeerStatus, askQuestion, dialogsBlocked, enqueuePeerInput, service])

  useEffect(() => {
    if (!service) return
    const unsubscribe = service.onInboxChanged((next) => {
      setSnapshot(next)
      pump()
    })
    pump()
    return unsubscribe
  }, [service, pump])

  useEffect(() => {
    pump()
  }, [dialogsBlocked, pump, pumpTick, snapshot.revision])

  return snapshot
}
