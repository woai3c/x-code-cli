import { createHash, randomUUID } from 'node:crypto'

import type { ModelMessage } from 'ai'

import type {
  ContextSecurityState,
  ExecutionAuthority,
  MessageProvenance,
  PeerOrigin,
  PeerOriginSummary,
  TrackedModelMessage,
} from '../types/index.js'

export const MAX_PEER_ORIGIN_ITEMS = 16

const CLEAN_PROVENANCE: MessageProvenance = {
  authority: 'internal',
  derivedFromPeer: false,
}

function originKey(origin: PeerOrigin): string {
  return `${origin.instanceId}\u0000${origin.messageId}\u0000${origin.nameAtReceipt}`
}

function hashOriginKeys(keys: readonly string[]): string {
  const accumulator = Buffer.alloc(32)
  for (const key of keys) {
    const digest = createHash('sha256').update(key).digest()
    for (let index = 0; index < accumulator.length; index++) accumulator[index] ^= digest[index]!
  }
  return accumulator.toString('hex')
}

function mergeOriginDigests(digests: readonly string[]): string {
  const accumulator = Buffer.alloc(32)
  for (const hex of digests) {
    const digest = Buffer.from(hex, 'hex')
    for (let index = 0; index < accumulator.length; index++) accumulator[index] ^= digest[index]!
  }
  return accumulator.toString('hex')
}

export function canonicalSecurityJson(value: unknown): string {
  const seen = new Set<object>()
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Non-finite transcript number')
      return item
    }
    if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol' || item === undefined) {
      throw new Error('Unsupported transcript value')
    }
    if (Array.isArray(item)) return item.map(normalize)
    if (typeof item !== 'object') throw new Error('Unsupported transcript value')
    if (seen.has(item)) throw new Error('Cyclic transcript value')
    seen.add(item)
    const record = item as Record<string, unknown>
    const normalized: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      // Model SDK objects commonly retain optional own-properties as
      // undefined. JSONL persistence omits them, so digest that same shape.
      if (record[key] !== undefined) normalized[key] = normalize(record[key])
    }
    seen.delete(item)
    return normalized
  }
  return JSON.stringify(normalize(value))
}

export function summarizePeerOrigins(origins: readonly PeerOrigin[]): PeerOriginSummary | undefined {
  if (origins.length === 0) return undefined
  const unique = new Map<string, PeerOrigin>()
  for (const origin of origins) {
    const normalized = {
      instanceId: origin.instanceId.slice(0, 128),
      nameAtReceipt: origin.nameAtReceipt.slice(0, 64),
      messageId: origin.messageId.slice(0, 128),
    }
    unique.set(originKey(normalized), normalized)
  }
  const entries = [...unique.entries()].sort(([a], [b]) => a.localeCompare(b))
  return {
    items: entries.slice(0, MAX_PEER_ORIGIN_ITEMS).map(([, origin]) => origin),
    totalCount: entries.length,
    digest: hashOriginKeys(entries.map(([key]) => key)),
    truncated: entries.length > MAX_PEER_ORIGIN_ITEMS,
  }
}

export function mergePeerOriginSummaries(
  summaries: readonly (PeerOriginSummary | undefined)[],
): PeerOriginSummary | undefined {
  const distinct = new Map<string, PeerOriginSummary>()
  for (const summary of summaries) {
    if (summary) distinct.set(`${summary.digest}:${summary.totalCount}`, summary)
  }
  const values = [...distinct.values()]
  if (values.length === 0) return undefined
  if (values.length === 1) return structuredClone(values[0]!)
  const visible = values.flatMap((summary) => summary.items)

  const unique = new Map<string, PeerOrigin>()
  for (const origin of visible) unique.set(originKey(origin), origin)
  const sorted = [...unique.entries()].sort(([a], [b]) => a.localeCompare(b))
  const duplicateVisibleCount = visible.length - unique.size
  const totalCount = Math.max(
    unique.size,
    values.reduce((sum, summary) => sum + summary.totalCount, 0) - duplicateVisibleCount,
  )
  const digest = mergeOriginDigests(values.map((summary) => summary.digest))
  return {
    items: sorted.slice(0, MAX_PEER_ORIGIN_ITEMS).map(([, origin]) => origin),
    totalCount,
    digest,
    truncated: totalCount > MAX_PEER_ORIGIN_ITEMS || values.some((summary) => summary.truncated),
  }
}

export function provenanceForAuthority(
  authority: ExecutionAuthority,
  messageRole: ModelMessage['role'],
): MessageProvenance {
  const peerOrigins = authority.peerOrigins
  if (messageRole === 'user') {
    return authority.peerTainted
      ? { authority: authority.source, derivedFromPeer: true, ...(peerOrigins ? { peerOrigins } : {}) }
      : { authority: 'user', derivedFromPeer: false }
  }
  return authority.peerTainted
    ? { authority: 'internal', derivedFromPeer: true, ...(peerOrigins ? { peerOrigins } : {}) }
    : { ...CLEAN_PROVENANCE }
}

export function createTrackedMessage(
  message: ModelMessage,
  provenance: MessageProvenance,
  entryId: string = randomUUID(),
): TrackedModelMessage {
  return {
    entryId,
    message,
    provenance: structuredClone(provenance),
  }
}

export function mergeProvenance(entries: readonly TrackedModelMessage[]): MessageProvenance {
  const derivedFromPeer = entries.some((entry) => entry.provenance.derivedFromPeer)
  const peerOrigins = derivedFromPeer
    ? mergePeerOriginSummaries(entries.map((entry) => entry.provenance.peerOrigins))
    : undefined
  return {
    authority: 'internal',
    derivedFromPeer,
    ...(peerOrigins ? { peerOrigins } : {}),
  }
}

export function deriveContextSecurity(entries: readonly TrackedModelMessage[]): ContextSecurityState {
  const tainted = entries.filter((entry) => entry.provenance.derivedFromPeer)
  if (tainted.length === 0) return { peerInfluenceActive: false }
  const peerOrigins = mergePeerOriginSummaries(tainted.map((entry) => entry.provenance.peerOrigins))
  return {
    peerInfluenceActive: true,
    firstTaintedEntryId: tainted[0]!.entryId,
    ...(peerOrigins ? { peerOrigins } : {}),
  }
}

export function effectiveExecutionAuthority(
  requested: ExecutionAuthority | undefined,
  context: ContextSecurityState,
): ExecutionAuthority {
  const base = requested ?? { source: 'user', peerTainted: false }
  const peerTainted = base.peerTainted || context.peerInfluenceActive || context.integrityFailure === true
  const peerOrigins = peerTainted ? mergePeerOriginSummaries([base.peerOrigins, context.peerOrigins]) : undefined
  return {
    source: base.source,
    peerTainted,
    ...(peerOrigins ? { peerOrigins } : {}),
  }
}

export function canonicalTranscriptDigest(entries: readonly TrackedModelMessage[]): string {
  const hash = createHash('sha256')
  for (const entry of entries) {
    hash.update(
      canonicalSecurityJson({
        entryId: entry.entryId,
        message: entry.message,
        provenance: entry.provenance,
      }),
    )
    hash.update('\n')
  }
  return hash.digest('hex')
}

export function isValidPeerOriginSummary(value: unknown): value is PeerOriginSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const summary = value as Partial<PeerOriginSummary>
  if (
    !Array.isArray(summary.items) ||
    summary.items.length > MAX_PEER_ORIGIN_ITEMS ||
    !Number.isSafeInteger(summary.totalCount) ||
    (summary.totalCount ?? -1) < summary.items.length ||
    typeof summary.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(summary.digest) ||
    typeof summary.truncated !== 'boolean'
  ) {
    return false
  }
  return summary.items.every(
    (origin) =>
      origin &&
      typeof origin === 'object' &&
      typeof origin.instanceId === 'string' &&
      origin.instanceId.length <= 128 &&
      typeof origin.nameAtReceipt === 'string' &&
      origin.nameAtReceipt.length <= 64 &&
      typeof origin.messageId === 'string' &&
      origin.messageId.length <= 128,
  )
}

export function isValidProvenance(value: unknown): value is MessageProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const provenance = value as Partial<MessageProvenance>
  if (!['user', 'peer', 'internal'].includes(provenance.authority ?? '')) return false
  if (typeof provenance.derivedFromPeer !== 'boolean') return false
  if (provenance.peerOrigins !== undefined && !isValidPeerOriginSummary(provenance.peerOrigins)) return false
  if (!provenance.derivedFromPeer && provenance.peerOrigins !== undefined) return false
  return true
}

export function isValidContextSecurity(
  value: unknown,
  entries: readonly TrackedModelMessage[],
): value is ContextSecurityState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Partial<ContextSecurityState>
  if (typeof state.peerInfluenceActive !== 'boolean') return false
  if (state.firstTaintedEntryId !== undefined && typeof state.firstTaintedEntryId !== 'string') return false
  if (state.peerOrigins !== undefined && !isValidPeerOriginSummary(state.peerOrigins)) return false
  const derived = deriveContextSecurity(entries)
  return (
    state.peerInfluenceActive === derived.peerInfluenceActive &&
    state.firstTaintedEntryId === derived.firstTaintedEntryId &&
    (state.peerOrigins?.digest ?? '') === (derived.peerOrigins?.digest ?? '')
  )
}
