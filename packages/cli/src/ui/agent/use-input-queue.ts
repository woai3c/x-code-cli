// @x-code-cli/cli — Mid-turn input queue for useAgent.
//
// Plain-text submits (and peer messages) that arrive while a turn is in
// flight live here until the agent loop drains them at the next tool
// boundary (steering). The ref is the source of truth: `consumeQueuedInputs`
// is called synchronously by the agent loop between awaits, where reading
// React state would see a stale closure — every mutation mirrors into
// `state.queuedMessages` in the same tick.
import { useCallback, useRef } from 'react'

import type { QueuedAgentInput } from '@x-code-cli/core'

import { partitionQueuedInputsForDraft, takeFreshQueuedInput } from './queued-agent-inputs.js'
import type { AgentState, QueuedMessage } from './use-agent.js'

type SetState = (update: AgentState | ((previous: AgentState) => AgentState)) => void

/** Project the internal mixed queue (user + peer entries) into the
 *  display-side pending list — only user entries are shown. */
function toQueuedUserMessages(queued: readonly QueuedAgentInput[]): QueuedMessage[] {
  return queued
    .filter((message): message is Extract<QueuedAgentInput, { source: 'user' }> => message.source === 'user')
    .map((message) => ({ id: message.id, text: message.display, inject: message.content }))
}

export function useInputQueue(setState: SetState) {
  /** Source of truth for the mid-turn message queue. The React state
   *  mirror (`state.queuedMessages`) drives ChatInput's pending list. */
  const queuedMessagesRef = useRef<QueuedAgentInput[]>([])
  const consumedPeerInboxKeysRef = useRef<Set<string>>(new Set())
  /** Monotonic id source for queued messages / draft restores. Date.now()
   *  collides within the same millisecond (and `length` repeats after a
   *  pop), which breaks React keys, pop-by-id, and nonce comparisons. */
  const queueSeqRef = useRef(0)

  /** Queue a plain-text submit that arrived while a turn was in flight.
   *  The agent loop drains it at the next tool boundary (or on `stop`).
   *  `inject` overrides what the model sees (display text stays clean). */
  const queueMessage = useCallback(
    (text: string, inject?: string) => {
      const entry: QueuedAgentInput = {
        id: `queued-${queueSeqRef.current++}`,
        source: 'user',
        display: text,
        content: inject ?? text,
      }
      queuedMessagesRef.current = [...queuedMessagesRef.current, entry]
      setState((prev) => ({ ...prev, queuedMessages: toQueuedUserMessages(queuedMessagesRef.current) }))
    },
    [setState],
  )

  /** Remove one queued message by id (ChatInput's ↑-to-pop-back editing). */
  const popQueuedMessage = useCallback(
    (id: string) => {
      queuedMessagesRef.current = queuedMessagesRef.current.filter(
        (message) => message.source === 'peer' || message.id !== id,
      )
      setState((prev) => ({ ...prev, queuedMessages: toQueuedUserMessages(queuedMessagesRef.current) }))
    },
    [setState],
  )

  /** Drain the queue: move every queued message into scrollback as a
   *  regular user message and return the texts for injection into
   *  `state.messages`. Passed to agentLoop as `consumeQueuedInputs` —
   *  MUST stay atomic (read + clear in one synchronous step) so a
   *  message can never be injected twice. */
  const consumeQueuedInputs = useCallback((): QueuedAgentInput[] | undefined => {
    const queued = queuedMessagesRef.current
    if (queued.length === 0) return undefined
    queuedMessagesRef.current = []
    for (const message of queued) {
      if (message.source === 'peer' && message.inboxKey) consumedPeerInboxKeysRef.current.add(message.inboxKey)
    }
    const now = Date.now()
    setState((prev) => ({
      ...prev,
      queuedMessages: [],
      messages: [
        ...prev.messages,
        ...queued.map((message) => ({
          id: message.id,
          role: 'user' as const,
          content: message.display,
          timestamp: now,
          ...(message.source === 'peer'
            ? { kind: 'peer-message' as const, peer: message.peer, peerMessageId: message.messageId }
            : {}),
        })),
      ],
    }))
    return queued
  }, [setState])

  const dequeueFreshInput = useCallback((): QueuedAgentInput | undefined => {
    if (queuedMessagesRef.current.length === 0) return undefined
    const taken = takeFreshQueuedInput(queuedMessagesRef.current)
    const next = taken.next
    if (!next) return undefined
    queuedMessagesRef.current = taken.remaining
    setState((prev) => ({
      ...prev,
      queuedMessages: toQueuedUserMessages(queuedMessagesRef.current),
      messages: [
        ...prev.messages,
        {
          id: next.id,
          role: 'user',
          content: next.display,
          timestamp: Date.now(),
          ...(next.source === 'peer'
            ? { kind: 'peer-message' as const, peer: next.peer, peerMessageId: next.messageId }
            : {}),
        },
      ],
    }))
    return next
  }, [setState])

  /** Move every still-queued message back into the input box as a single
   *  merged draft (Codex's input_restore semantics — zero loss on Esc).
   *  Used by abort() and by submit's aborted-completion path for messages
   *  that raced in after abort() already ran. */
  const restoreQueueToDraft = useCallback(() => {
    const queued = queuedMessagesRef.current
    if (queued.length === 0) return
    const { draft, retained } = partitionQueuedInputsForDraft(queued)
    queuedMessagesRef.current = retained
    if (!draft) return
    setState((prev) => ({ ...prev, queuedMessages: [], restoredDraft: { text: draft, nonce: queueSeqRef.current++ } }))
  }, [setState])

  return {
    queuedMessagesRef,
    consumedPeerInboxKeysRef,
    queueSeqRef,
    queueMessage,
    popQueuedMessage,
    consumeQueuedInputs,
    dequeueFreshInput,
    restoreQueueToDraft,
  }
}
