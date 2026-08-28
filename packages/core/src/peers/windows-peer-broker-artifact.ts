import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { WINDOWS_PEER_BROKER_PROTOCOL_VERSION } from './windows-peer-broker-protocol.js'

const WINDOWS_NATIVE_MANIFEST_VERSION = 2
const WINDOWS_PE_MACHINES: Record<'x64' | 'arm64', number> = { x64: 0x8664, arm64: 0xaa64 }

interface WindowsPeerBrokerManifestEntry {
  file: string
  protocolVersion: number
  sha256: string
  sourceSha256: string
}

interface WindowsNativeManifest {
  manifestVersion: number
  artifacts: Record<string, { peerBroker?: WindowsPeerBrokerManifestEntry }>
}

export interface WindowsPeerBrokerArtifact {
  executablePath: string
  sha256: string
  protocolVersion: number
}

function artifactError(code: string, message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.name = code
  return error
}

export function resolveWindowsPeerBrokerNativeRoot(modulePath: string): string {
  const moduleDir = path.dirname(modulePath)
  if (!/^windows-peer-broker-artifact\.(?:[cm]?js|ts)$/.test(path.basename(modulePath))) {
    if (path.basename(moduleDir) === 'dist') return path.join(moduleDir, 'native', 'windows')
    if (path.basename(moduleDir) === 'chunks' && path.basename(path.dirname(moduleDir)) === 'dist') {
      return path.join(path.dirname(moduleDir), 'native', 'windows')
    }
    throw artifactError(
      'PEER_WINDOWS_HELPER_MISSING',
      `Windows peer broker bundle has an unsupported package layout: ${modulePath}`,
    )
  }

  const sourceRoot = path.dirname(moduleDir)
  if (path.basename(sourceRoot) === 'dist') return path.join(sourceRoot, 'native', 'windows')
  if (path.basename(sourceRoot) === 'src') {
    return path.join(path.dirname(sourceRoot), 'dist', 'native', 'windows')
  }
  throw artifactError(
    'PEER_WINDOWS_HELPER_MISSING',
    `Windows peer broker module has an unsupported package layout: ${modulePath}`,
  )
}

function verifyPeArchitecture(bytes: Buffer, arch: 'x64' | 'arm64'): void {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) {
    throw artifactError('PEER_WINDOWS_HELPER_HASH_MISMATCH', `Windows peer broker is not a PE executable for ${arch}`)
  }
  const peOffset = bytes.readUInt32LE(0x3c)
  if (
    peOffset + 6 > bytes.length ||
    bytes.readUInt32LE(peOffset) !== 0x00004550 ||
    bytes.readUInt16LE(peOffset + 4) !== WINDOWS_PE_MACHINES[arch]
  ) {
    throw artifactError('PEER_WINDOWS_HELPER_HASH_MISMATCH', `Windows peer broker PE architecture mismatch for ${arch}`)
  }
}

export async function resolveWindowsPeerBrokerArtifact(
  arch: NodeJS.Architecture = process.arch,
  nativeRoot = resolveWindowsPeerBrokerNativeRoot(fileURLToPath(import.meta.url)),
): Promise<WindowsPeerBrokerArtifact> {
  if (arch !== 'x64' && arch !== 'arm64') {
    throw artifactError('PEER_WINDOWS_UNSUPPORTED_ARCH', `Windows peer messaging does not support architecture ${arch}`)
  }
  let manifest: WindowsNativeManifest
  try {
    manifest = JSON.parse(await fs.readFile(path.join(nativeRoot, 'manifest.json'), 'utf8')) as WindowsNativeManifest
  } catch (error) {
    throw artifactError(
      'PEER_WINDOWS_HELPER_MISSING',
      `Windows peer broker is missing for ${arch}; reinstall x-code-cli`,
      error,
    )
  }
  if (manifest.manifestVersion !== WINDOWS_NATIVE_MANIFEST_VERSION) {
    throw artifactError(
      'PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH',
      `Windows native manifest mismatch: expected ${WINDOWS_NATIVE_MANIFEST_VERSION}, received ${manifest.manifestVersion}`,
    )
  }
  const artifact = manifest.artifacts?.[arch]?.peerBroker
  if (!artifact) {
    throw artifactError('PEER_WINDOWS_HELPER_MISSING', `Windows peer broker manifest has no ${arch} artifact`)
  }
  if (artifact.protocolVersion !== WINDOWS_PEER_BROKER_PROTOCOL_VERSION) {
    throw artifactError(
      'PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH',
      `Windows peer broker protocol mismatch: expected ${WINDOWS_PEER_BROKER_PROTOCOL_VERSION}, received ${artifact.protocolVersion}`,
    )
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || !/^[a-f0-9]{64}$/.test(artifact.sourceSha256)) {
    throw artifactError('PEER_WINDOWS_HELPER_HASH_MISMATCH', 'Windows peer broker manifest hash is invalid')
  }
  if (artifact.file !== `${arch}/xc-peer-broker.exe`) {
    throw artifactError('PEER_WINDOWS_HELPER_HASH_MISMATCH', `Windows peer broker manifest has an invalid ${arch} path`)
  }
  const executablePath = path.resolve(nativeRoot, artifact.file)
  const relative = path.relative(nativeRoot, executablePath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw artifactError('PEER_WINDOWS_HELPER_HASH_MISMATCH', 'Windows peer broker path escapes its native directory')
  }
  let bytes: Buffer
  try {
    bytes = await fs.readFile(executablePath)
  } catch (error) {
    throw artifactError(
      'PEER_WINDOWS_HELPER_MISSING',
      `Windows peer broker is missing for ${arch}; reinstall x-code-cli`,
      error,
    )
  }
  verifyPeArchitecture(bytes, arch)
  const actualHash = createHash('sha256').update(bytes).digest('hex')
  if (actualHash !== artifact.sha256) {
    throw artifactError('PEER_WINDOWS_HELPER_HASH_MISMATCH', `Windows peer broker hash mismatch for ${arch}`)
  }
  return { executablePath, sha256: actualHash, protocolVersion: artifact.protocolVersion }
}
