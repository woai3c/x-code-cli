import { fileURLToPath } from 'node:url'

import {
  type WindowsNativeArtifact,
  type WindowsNativeArtifactSpec,
  resolveWindowsNativeArtifact,
  resolveWindowsNativeRoot,
} from '../native/windows-native-artifact.js'
import { WINDOWS_PEER_BROKER_PROTOCOL_VERSION } from './windows-peer-broker-protocol.js'

const SPEC: WindowsNativeArtifactSpec = {
  artifactName: 'peerBroker',
  executableName: 'xc-peer-broker.exe',
  displayName: 'Windows peer broker',
  protocolVersion: WINDOWS_PEER_BROKER_PROTOCOL_VERSION,
  createError(failure, message, cause) {
    const names = {
      'unsupported-arch': 'PEER_WINDOWS_UNSUPPORTED_ARCH',
      missing: 'PEER_WINDOWS_HELPER_MISSING',
      'protocol-mismatch': 'PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH',
      'integrity-mismatch': 'PEER_WINDOWS_HELPER_HASH_MISMATCH',
    } as const
    const error = new Error(message, cause === undefined ? undefined : { cause })
    error.name = names[failure]
    return error
  },
}

export type WindowsPeerBrokerArtifact = WindowsNativeArtifact

export function resolveWindowsPeerBrokerNativeRoot(modulePath: string): string {
  try {
    return resolveWindowsNativeRoot(modulePath)
  } catch (error) {
    throw SPEC.createError!(
      'missing',
      `Windows peer broker bundle has an unsupported package layout: ${modulePath}`,
      error,
    )
  }
}

export function resolveWindowsPeerBrokerArtifact(
  arch: NodeJS.Architecture = process.arch,
  nativeRoot = resolveWindowsPeerBrokerNativeRoot(fileURLToPath(import.meta.url)),
): Promise<WindowsPeerBrokerArtifact> {
  return resolveWindowsNativeArtifact({ arch, nativeRoot, spec: SPEC })
}
