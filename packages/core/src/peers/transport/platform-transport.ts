import type { PeerTransport } from './transport.js'
import { createUnixSocketTransport } from './unix-socket-transport.js'
import { createWindowsNamedPipeTransport } from './windows-named-pipe-transport.js'

export interface PlatformPeerTransportOptions {
  getRuntimePaths: () => { socketDir: string; namespaceId?: string }
  platform?: NodeJS.Platform
}

function createUnsupportedTransport(): PeerTransport {
  const unsupported = (): never => {
    throw Object.assign(new Error('Peer messaging is not supported on this platform.'), {
      name: 'PEER_UNSUPPORTED_PLATFORM',
    })
  }
  return {
    kind: 'unix',
    validateAddress: () => false,
    listen: async () => unsupported(),
    request: async () => unsupported(),
  }
}

export function createPlatformPeerTransport(options: PlatformPeerTransportOptions): PeerTransport {
  const platform = options.platform ?? process.platform
  if (platform === 'darwin' || platform === 'linux') {
    return createUnixSocketTransport({
      getSocketDir: () => options.getRuntimePaths().socketDir,
    })
  }
  if (platform === 'win32') {
    return createWindowsNamedPipeTransport({
      getRuntimePaths: options.getRuntimePaths,
    })
  }
  return createUnsupportedTransport()
}
