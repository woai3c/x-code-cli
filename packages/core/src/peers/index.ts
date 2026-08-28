export { createPeerIdentity, isUuid, normalizePeerName, peerAddress } from './identity.js'
export {
  ensurePeerRuntimeDirectories,
  isSocketPathInNamespace,
  peerRegistrationPath,
  peerRegistryDir,
  peerSocketPath,
} from './paths.js'
export { createPeerRegistry } from './registry.js'
export type { PeerRegistry, PeerRegistryOptions } from './registry.js'
export { decideInboundDisposition } from './inbound-policy.js'
export type { InboundPolicyInput } from './inbound-policy.js'
export { createPeerRateLimiter } from './rate-limit.js'
export type { PeerRateLimiter, PeerRateLimiterOptions } from './rate-limit.js'
export { createPeerService } from './service.js'
export type {
  PeerService,
  PeerServiceOptions,
  PreparedPeerSend,
  SendMessageResult,
  SendPeerMessageInput,
} from './service.js'
export { listAgentsTool, sendMessageTool } from './tools.js'
export { MAX_FRAME_BYTES, MAX_MESSAGE_BYTES, NdjsonFrameDecoder, encodePeerFrame, parsePeerFrame } from './protocol.js'
export type { PeerFrameV1 } from './protocol.js'
export { createPlatformPeerTransport } from './platform-transport.js'
export type { PlatformPeerTransportOptions } from './platform-transport.js'
export { createUnixSocketTransport } from './unix-socket-transport.js'
export type { UnixSocketTransportOptions } from './unix-socket-transport.js'
export { createWindowsNamedPipeTransport } from './windows-named-pipe-transport.js'
export type { WindowsNamedPipeTransportOptions } from './windows-named-pipe-transport.js'
export type { PeerTransport, PeerTransportServer } from './transport.js'
export { stripTerminalControls } from './terminal-sanitize.js'
export { MAX_REGISTRATION_BYTES, MAX_REGISTRATION_CANDIDATES, PEER_PROTOCOL_VERSION } from './types.js'
export type {
  CandidateScanResult,
  PeerIdentity,
  PeerRegistrationV1,
  PeerTransportDescriptor,
  RegistrationCandidate,
} from './types.js'
