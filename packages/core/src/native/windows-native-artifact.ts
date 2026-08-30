import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const WINDOWS_NATIVE_MANIFEST_VERSION = 2

const WINDOWS_PE_MACHINES: Record<'x64' | 'arm64', number> = { x64: 0x8664, arm64: 0xaa64 }

interface WindowsNativeManifestEntry {
  file: string
  protocolVersion: number
  sha256: string
  sourceSha256: string
}

interface WindowsNativeManifest {
  manifestVersion: number
  artifacts: Record<string, Record<string, WindowsNativeManifestEntry | undefined> | undefined>
}

export interface WindowsNativeArtifact {
  executablePath: string
  sha256: string
  protocolVersion: number
}

type WindowsNativeArtifactFailure = 'unsupported-arch' | 'missing' | 'protocol-mismatch' | 'integrity-mismatch'

export interface WindowsNativeArtifactSpec {
  artifactName: string
  executableName: string
  displayName: string
  protocolVersion: number
  createError?: (failure: WindowsNativeArtifactFailure, message: string, cause?: unknown) => Error
}

function failure(
  spec: WindowsNativeArtifactSpec,
  kind: WindowsNativeArtifactFailure,
  message: string,
  cause?: unknown,
): never {
  if (spec.createError) throw spec.createError(kind, message, cause)
  throw new Error(message, cause === undefined ? undefined : { cause })
}

function verifyPeArchitecture(bytes: Buffer, arch: 'x64' | 'arm64', spec: WindowsNativeArtifactSpec): void {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) {
    failure(spec, 'integrity-mismatch', `${spec.displayName} is not a PE executable for ${arch}`)
  }
  const peOffset = bytes.readUInt32LE(0x3c)
  if (
    peOffset + 6 > bytes.length ||
    bytes.readUInt32LE(peOffset) !== 0x00004550 ||
    bytes.readUInt16LE(peOffset + 4) !== WINDOWS_PE_MACHINES[arch]
  ) {
    failure(spec, 'integrity-mismatch', `${spec.displayName} PE architecture mismatch for ${arch}`)
  }
}

export function resolveWindowsNativeRoot(modulePath: string): string {
  let directory = path.dirname(path.resolve(modulePath))
  for (let depth = 0; depth < 8; depth++) {
    const name = path.basename(directory)
    if (name === 'dist') return path.join(directory, 'native', 'windows')
    if (name === 'src') return path.join(path.dirname(directory), 'dist', 'native', 'windows')
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error(`Windows native helper has an unsupported package layout: ${modulePath}`)
}

export async function resolveWindowsNativeArtifact(options: {
  arch?: NodeJS.Architecture
  nativeRoot: string
  spec: WindowsNativeArtifactSpec
}): Promise<WindowsNativeArtifact> {
  const arch = options.arch ?? process.arch
  const { nativeRoot, spec } = options
  if (arch !== 'x64' && arch !== 'arm64') {
    failure(spec, 'unsupported-arch', `${spec.displayName} does not support architecture ${arch}`)
  }
  let manifest: WindowsNativeManifest
  try {
    manifest = JSON.parse(await fs.readFile(path.join(nativeRoot, 'manifest.json'), 'utf8')) as WindowsNativeManifest
  } catch (error) {
    failure(spec, 'missing', `${spec.displayName} is missing for ${arch}; reinstall x-code-cli`, error)
  }
  if (manifest.manifestVersion !== WINDOWS_NATIVE_MANIFEST_VERSION) {
    failure(
      spec,
      'protocol-mismatch',
      `Windows native manifest mismatch: expected ${WINDOWS_NATIVE_MANIFEST_VERSION}, received ${manifest.manifestVersion}`,
    )
  }
  const artifact = manifest.artifacts?.[arch]?.[spec.artifactName]
  if (!artifact) failure(spec, 'missing', `${spec.displayName} manifest has no ${arch} artifact`)
  if (artifact.protocolVersion !== spec.protocolVersion) {
    failure(
      spec,
      'protocol-mismatch',
      `${spec.displayName} protocol mismatch: expected ${spec.protocolVersion}, received ${artifact.protocolVersion}`,
    )
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || !/^[a-f0-9]{64}$/.test(artifact.sourceSha256)) {
    failure(spec, 'integrity-mismatch', `${spec.displayName} manifest hash is invalid`)
  }
  const expectedFile = `${arch}/${spec.executableName}`
  if (artifact.file !== expectedFile) {
    failure(spec, 'integrity-mismatch', `${spec.displayName} manifest has an invalid ${arch} path`)
  }
  const executablePath = path.resolve(nativeRoot, artifact.file)
  const relative = path.relative(nativeRoot, executablePath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    failure(spec, 'integrity-mismatch', `${spec.displayName} path escapes its native directory`)
  }
  let bytes: Buffer
  try {
    bytes = await fs.readFile(executablePath)
  } catch (error) {
    failure(spec, 'missing', `${spec.displayName} is missing for ${arch}; reinstall x-code-cli`, error)
  }
  verifyPeArchitecture(bytes, arch, spec)
  const actualHash = createHash('sha256').update(bytes).digest('hex')
  if (actualHash !== artifact.sha256) {
    failure(spec, 'integrity-mismatch', `${spec.displayName} hash mismatch for ${arch}`)
  }
  return { executablePath, sha256: actualHash, protocolVersion: artifact.protocolVersion }
}
