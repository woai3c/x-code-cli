import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const WINDOWS_NATIVE_ARCHES = ['x64', 'arm64']
export const WINDOWS_NATIVE_MANIFEST_VERSION = 2
export const WINDOWS_SUPERVISOR_PROTOCOL_VERSION = 2
export const WINDOWS_PEER_BROKER_PROTOCOL_VERSION = 1

export const WINDOWS_NATIVE_ARTIFACTS = {
  shellSupervisor: {
    file: 'xc-shell-supervisor.exe',
    protocolVersion: WINDOWS_SUPERVISOR_PROTOCOL_VERSION,
    sourceDirectory: 'windows-job-supervisor',
  },
  peerBroker: {
    file: 'xc-peer-broker.exe',
    protocolVersion: WINDOWS_PEER_BROKER_PROTOCOL_VERSION,
    sourceDirectory: 'windows-peer-broker',
  },
}

const WINDOWS_PE_MACHINES = {
  x64: 0x8664,
  arm64: 0xaa64,
}

export function verifyPeArchitecture(bytes, arch, artifactName = 'helper') {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`Windows prebuilt ${artifactName} is not a PE executable for ${arch}`)
  }
  const peOffset = bytes.readUInt32LE(0x3c)
  if (peOffset + 6 > bytes.length || bytes.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`Windows prebuilt ${artifactName} has an invalid PE header for ${arch}`)
  }
  const actualMachine = bytes.readUInt16LE(peOffset + 4)
  if (actualMachine !== WINDOWS_PE_MACHINES[arch]) {
    throw new Error(
      `Windows prebuilt ${artifactName} architecture mismatch for ${arch}: received PE machine 0x${actualMachine.toString(16)}`,
    )
  }
}

async function sourceFiles(root, relative = '') {
  const directory = path.join(root, relative)
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const child = path.join(relative, entry.name)
    if (entry.isDirectory() && entry.name !== 'target') files.push(...(await sourceFiles(root, child)))
    else if (entry.isFile()) files.push(child)
  }
  return files
}

export async function nativeSourceSha256(coreDir, artifactName = 'shellSupervisor') {
  const definition = WINDOWS_NATIVE_ARTIFACTS[artifactName]
  if (!definition) throw new Error(`Unknown Windows native artifact: ${artifactName}`)
  const sourceDir = path.join(coreDir, 'native', definition.sourceDirectory)
  const relativeFiles = (await sourceFiles(sourceDir))
    .filter((file) => file === 'Cargo.toml' || file === 'Cargo.lock' || file.endsWith('.rs'))
    .sort((left, right) => left.localeCompare(right, 'en'))
  const hash = createHash('sha256')
  for (const relativeFile of relativeFiles) {
    hash.update(relativeFile.replaceAll(path.sep, '/'))
    hash.update('\0')
    const contents = await fs.readFile(path.join(sourceDir, relativeFile), 'utf8')
    hash.update(contents.replaceAll('\r\n', '\n'))
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function artifactSourceHashes(coreDir) {
  return Object.fromEntries(
    await Promise.all(
      Object.keys(WINDOWS_NATIVE_ARTIFACTS).map(async (artifactName) => [
        artifactName,
        await nativeSourceSha256(coreDir, artifactName),
      ]),
    ),
  )
}

function builtEntrySet(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Windows native manifest requires at least one explicitly built artifact')
  }
  const built = new Set()
  for (const entry of entries) {
    if (!WINDOWS_NATIVE_ARCHES.includes(entry?.arch) || !WINDOWS_NATIVE_ARTIFACTS[entry?.artifactName]) {
      throw new Error(`Invalid Windows native build provenance: ${String(entry?.arch)}:${String(entry?.artifactName)}`)
    }
    built.add(`${entry.arch}:${entry.artifactName}`)
  }
  return built
}

async function previousWindowsNativeManifest(windowsDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(windowsDir, 'manifest.json'), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

export async function updateWindowsNativeManifest(coreDir, windowsDir, builtEntries) {
  const built = builtEntrySet(builtEntries)
  const sourceHashes = await artifactSourceHashes(coreDir)
  const previous = await previousWindowsNativeManifest(windowsDir)
  const artifacts = {}
  for (const arch of WINDOWS_NATIVE_ARCHES) {
    artifacts[arch] = {}
    for (const [artifactName, definition] of Object.entries(WINDOWS_NATIVE_ARTIFACTS)) {
      const file = `${arch}/${definition.file}`
      const bytes = await fs.readFile(path.join(windowsDir, file))
      verifyPeArchitecture(bytes, arch, artifactName)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      let sourceSha256
      if (built.has(`${arch}:${artifactName}`)) {
        sourceSha256 = sourceHashes[artifactName]
      } else {
        const previousEntry = previous?.artifacts?.[arch]?.[artifactName]
        if (
          previousEntry?.file !== file ||
          previousEntry.protocolVersion !== definition.protocolVersion ||
          previousEntry.sha256 !== sha256 ||
          !/^[a-f0-9]{64}$/.test(previousEntry.sourceSha256 ?? '')
        ) {
          throw new Error(`Cannot preserve provenance for unbuilt Windows ${arch} ${artifactName}`)
        }
        sourceSha256 = previousEntry.sourceSha256
      }
      artifacts[arch][artifactName] = {
        file,
        protocolVersion: definition.protocolVersion,
        sha256,
        sourceSha256,
      }
    }
  }
  const manifest = {
    manifestVersion: WINDOWS_NATIVE_MANIFEST_VERSION,
    artifacts,
  }
  await fs.mkdir(windowsDir, { recursive: true })
  const manifestPath = path.join(windowsDir, 'manifest.json')
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`
  await fs.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await fs.rename(temporaryPath, manifestPath)
  return manifest
}

export async function verifyWindowsNativeArtifacts(coreDir, windowsDir) {
  const manifestPath = path.join(windowsDir, 'manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  if (manifest.manifestVersion !== WINDOWS_NATIVE_MANIFEST_VERSION) {
    throw new Error(
      `Windows native manifest mismatch: expected ${WINDOWS_NATIVE_MANIFEST_VERSION}, received ${String(manifest.manifestVersion)}`,
    )
  }
  const sourceHashes = await artifactSourceHashes(coreDir)
  for (const arch of WINDOWS_NATIVE_ARCHES) {
    for (const [artifactName, definition] of Object.entries(WINDOWS_NATIVE_ARTIFACTS)) {
      const artifact = manifest.artifacts?.[arch]?.[artifactName]
      const expectedFile = `${arch}/${definition.file}`
      if (
        artifact?.file !== expectedFile ||
        artifact.protocolVersion !== definition.protocolVersion ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '') ||
        !/^[a-f0-9]{64}$/.test(artifact.sourceSha256 ?? '')
      ) {
        throw new Error(`Windows prebuilt manifest has an invalid ${arch} ${artifactName} artifact`)
      }
      if (artifact.sourceSha256 !== sourceHashes[artifactName]) {
        throw new Error(`Windows prebuilt ${artifactName} is stale; a maintainer must rebuild both architectures`)
      }
      const filePath = path.resolve(windowsDir, artifact.file)
      const relative = path.relative(windowsDir, filePath)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Windows prebuilt manifest ${arch} ${artifactName} artifact escapes its directory`)
      }
      const bytes = await fs.readFile(filePath)
      verifyPeArchitecture(bytes, arch, artifactName)
      const actualHash = createHash('sha256').update(bytes).digest('hex')
      if (actualHash !== artifact.sha256) {
        throw new Error(`Windows prebuilt ${artifactName} hash mismatch for ${arch}`)
      }
    }
  }
  return manifest
}
