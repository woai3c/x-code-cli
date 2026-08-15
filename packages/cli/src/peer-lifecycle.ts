import {
  type PeerMessagingConfig,
  type PeerService,
  type PeerServiceOptions,
  createPeerService,
  debugLog,
  resolvePeerMessagingConfig,
} from '@x-code-cli/core'

import { errorMessage } from '../../core/src/utils.js'

export interface CliPeerStartupOptions {
  userConfig?: unknown
  printMode: boolean
  name?: string
  cwd: string
  getPermissionClass: () => 'prompted' | 'bypass'
}

type PeerServiceFactory = (options: PeerServiceOptions) => PeerService

export function resolveCliPeerMessagingConfig(userConfig: unknown): PeerMessagingConfig {
  return resolvePeerMessagingConfig(userConfig)
}

export async function startCliPeerService(
  options: CliPeerStartupOptions,
  factory: PeerServiceFactory = createPeerService,
): Promise<PeerService | null> {
  if (options.printMode || !options.name?.trim()) return null
  const config = resolveCliPeerMessagingConfig(options.userConfig)

  let service: PeerService
  try {
    service = factory({
      enabled: true,
      config,
      name: options.name,
      cwd: options.cwd,
      getPermissionClass: options.getPermissionClass,
    })
  } catch (error) {
    debugLog('peer.start-failed', errorMessage(error))
    return null
  }
  try {
    await service.start()
  } catch (error) {
    debugLog('peer.start-failed', errorMessage(error))
  }
  return service
}
