export const PEER_PROTOCOL_VERSION = 1 as const
export const MAX_REGISTRATION_BYTES = 64 * 1024
export const MAX_REGISTRATION_CANDIDATES = 256

export type PeerTransportDescriptor = { kind: 'unix'; address: string } | { kind: 'windows-pipe'; address: string }

export interface PeerRegistrationV1 {
  version: 1
  instanceId: string
  pid: number
  sessionId?: string
  name: string
  cwd: string
  transport: PeerTransportDescriptor
  inboxToken: string
  permissionClass: 'prompted' | 'bypass'
  status: 'idle' | 'busy' | 'waiting'
  busyKind?: 'interactive-turn' | 'goal' | 'maintenance'
  startedAt: string
  updatedAt: string
  protocolVersion: 1
}

export interface PeerIdentity {
  instanceId: string
  address: `peer:${string}`
  shortId: string
  inboxToken: string
  name: string
  startedAt: string
}

export interface RegistrationCandidate {
  registration: PeerRegistrationV1
  registrationPath: string
  mtimeMs: number
}

export interface CandidateScanResult {
  candidates: RegistrationCandidate[]
  scanned: number
  rejected: number
  truncated: boolean
}
