import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'

import type { PeerIdentity } from './types.js'

const VALID_PEER_NAME_RE = /^[\p{L}\p{N} _.\-]+$/u

export function normalizePeerName(value: string): string {
  if (/[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error('Peer name cannot contain control characters')
  }
  const name = value.trim().replace(/\s+/g, ' ')
  if (name.length < 1 || name.length > 64 || !VALID_PEER_NAME_RE.test(name)) {
    throw new Error('Peer name must be 1-64 characters using letters, numbers, spaces, "-", "_", or "."')
  }
  return name
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export function peerAddress(instanceId: string): `peer:${string}` {
  if (!isUuid(instanceId)) throw new Error('Peer instance ID must be a UUID')
  return `peer:${instanceId}`
}

function defaultPeerName(cwd: string, instanceId: string): string {
  const basename = path.basename(cwd).normalize('NFKC')
  const safe = [...basename]
    .map((character) => (/[\p{L}\p{N} _.\-]/u.test(character) ? character : '-'))
    .join('')
    .replace(/-+/g, '-')
    .replace(/^[- .]+|[- .]+$/g, '')
    .slice(0, 59)
  return normalizePeerName(`${safe || 'x-code'}-${instanceId.slice(0, 4)}`)
}

export function createPeerIdentity(options: { name?: string; cwd?: string; now?: () => Date } = {}): PeerIdentity {
  const instanceId = randomUUID()
  return {
    instanceId,
    address: peerAddress(instanceId),
    shortId: instanceId.slice(0, 8),
    inboxToken: randomBytes(32).toString('base64url'),
    name: options.name ? normalizePeerName(options.name) : defaultPeerName(options.cwd ?? process.cwd(), instanceId),
    startedAt: (options.now?.() ?? new Date()).toISOString(),
  }
}
