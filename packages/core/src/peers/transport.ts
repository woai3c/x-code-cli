import type { PeerFrameV1 } from './protocol.js'
import type { PeerTransportDescriptor } from './types.js'

export interface PeerTransportServer {
  address: string
  closed?: Promise<{ expected: boolean; reason?: string }>
  close(options?: { deadlineMs?: number }): Promise<void>
}

export interface PeerTransport {
  readonly kind?: PeerTransportDescriptor['kind']
  validateAddress?(address: string): boolean
  listen(options: {
    address: string
    instanceId: string
    inboxToken: string
    onRequest: (frame: PeerFrameV1, senderInstanceId: string) => Promise<PeerFrameV1>
    signal?: AbortSignal
  }): Promise<PeerTransportServer>
  request(options: {
    address: string
    targetToken: string
    senderInstanceId: string
    frame: PeerFrameV1
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<PeerFrameV1>
  cleanupConfirmedDeadEndpoint?(address: string): Promise<void>
}
