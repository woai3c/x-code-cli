import type { ModelMessage } from 'ai'

import type { ExecutionAuthority, MessageProvenance, TrackedModelMessage } from '../types/index.js'
import type { LoopState } from './loop-state.js'
import { createTrackedMessage, deriveContextSecurity, provenanceForAuthority } from './provenance.js'

const ARRAY_INDEX = /^(0|[1-9]\d*)$/

function isArrayIndex(property: PropertyKey): property is string {
  return typeof property === 'string' && ARRAY_INDEX.test(property)
}

function currentAuthority(state: LoopState): ExecutionAuthority {
  return state.executionAuthority
}

function recalculate(state: LoopState): void {
  const derived = deriveContextSecurity(state.trackedMessages)
  state.contextSecurity = state.contextSecurity.integrityFailure
    ? { ...derived, peerInfluenceActive: true, integrityFailure: true }
    : derived
}

export function appendTrackedMessage(
  state: LoopState,
  message: ModelMessage,
  provenance = provenanceForAuthority(currentAuthority(state), message.role),
): TrackedModelMessage {
  const entry = createTrackedMessage(message, provenance)
  state.trackedMessages.push(entry)
  recalculate(state)
  return entry
}

export function appendTrackedMessages(
  state: LoopState,
  messages: readonly ModelMessage[],
  provenance?: MessageProvenance,
): TrackedModelMessage[] {
  const added = messages.map((message) =>
    createTrackedMessage(message, provenance ?? provenanceForAuthority(currentAuthority(state), message.role)),
  )
  state.trackedMessages.push(...added)
  recalculate(state)
  return added
}

export function replaceTrackedMessages(
  state: LoopState,
  messages: readonly ModelMessage[],
  fallbackProvenance?: MessageProvenance,
): void {
  const byIdentity = new Map<ModelMessage, TrackedModelMessage[]>()
  for (const entry of state.trackedMessages) {
    const matches = byIdentity.get(entry.message) ?? []
    matches.push(entry)
    byIdentity.set(entry.message, matches)
  }
  state.trackedMessages = messages.map((message) => {
    const matches = byIdentity.get(message)
    const retained = matches?.shift()
    return (
      retained ??
      createTrackedMessage(message, fallbackProvenance ?? provenanceForAuthority(currentAuthority(state), message.role))
    )
  })
  recalculate(state)
}

/** Compatibility view for existing provider/message helpers. It stores no
 * message data of its own: every index and length operation projects the
 * tracked transcript. Structural transformations should use tracked entries
 * directly so moves keep entryId/provenance together. */
export function createModelMessageView(state: LoopState): ModelMessage[] {
  const target: ModelMessage[] = []
  const syncTargetLength = (): void => {
    if (target.length !== state.trackedMessages.length) target.length = state.trackedMessages.length
  }
  return new Proxy(target, {
    get(_target, property, receiver) {
      if (property === 'length') return state.trackedMessages.length
      if (isArrayIndex(property)) return state.trackedMessages[Number(property)]?.message
      syncTargetLength()
      return Reflect.get(receiver === target ? target : target, property, receiver)
    },
    set(_target, property, value) {
      if (property === 'length') {
        const length = Number(value)
        if (!Number.isSafeInteger(length) || length < 0) return false
        state.trackedMessages.length = length
        recalculate(state)
        return true
      }
      if (isArrayIndex(property)) {
        const index = Number(property)
        const message = value as ModelMessage
        const existing = state.trackedMessages[index]
        state.trackedMessages[index] = existing
          ? { ...existing, message }
          : createTrackedMessage(message, provenanceForAuthority(currentAuthority(state), message.role))
        recalculate(state)
        return true
      }
      return Reflect.set(target, property, value)
    },
    deleteProperty(_target, property) {
      if (!isArrayIndex(property)) return Reflect.deleteProperty(target, property)
      state.trackedMessages.splice(Number(property), 1)
      recalculate(state)
      return true
    },
    has(_target, property) {
      if (property === 'length') return true
      if (isArrayIndex(property)) return Number(property) < state.trackedMessages.length
      return Reflect.has(target, property)
    },
    ownKeys() {
      syncTargetLength()
      return [...state.trackedMessages.map((_, index) => String(index)), 'length']
    },
    getOwnPropertyDescriptor(_target, property) {
      if (property === 'length') {
        syncTargetLength()
        return Reflect.getOwnPropertyDescriptor(target, property)
      }
      if (isArrayIndex(property) && Number(property) < state.trackedMessages.length) {
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: state.trackedMessages[Number(property)]?.message,
        }
      }
      return Reflect.getOwnPropertyDescriptor(target, property)
    },
  })
}

export function setTrackedTranscript(state: LoopState, entries: readonly TrackedModelMessage[]): void {
  state.trackedMessages = entries.map((entry) => structuredClone(entry))
  recalculate(state)
}

export function recalculateContextSecurity(state: LoopState): void {
  recalculate(state)
}
