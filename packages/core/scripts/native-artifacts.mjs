import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const WINDOWS_NATIVE_ARCHES = ['x64', 'arm64']
export const WINDOWS_NATIVE_PROTOCOL_VERSION = 2
export const WINDOWS_SUPERVISOR_FILE = 'xc-shell-supervisor.exe'

const WINDOWS_PE_MACHINES = {
  x64: 0x8664,
  arm64: 0xaa64,
}

function verifyPeArchitecture(bytes, arch) {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`Windows prebuilt helper is not a PE executable for ${arch}`)
  }
  const peOffset = bytes.readUInt32LE(0x3c)
  if (peOffset + 6 > bytes.length || bytes.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`Windows prebuilt helper has an invalid PE header for ${arch}`)
  }
  const actualMachine = bytes.readUInt16LE(peOffset + 4)
  if (actualMachine !== WINDOWS_PE_MACHINES[arch]) {
    throw new Error(
      `Windows prebuilt helper architecture mismatch for ${arch}: received PE machine 0x${actualMachine.toString(16)}`,
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

export async function nativeSourceSha256(coreDir) {
  const sourceDir = path.join(coreDir, 'native', 'windows-job-supervisor')
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

export async function writeWindowsNativeManifest(coreDir, windowsDir) {
  const artifacts = {}
  for (const arch of WINDOWS_NATIVE_ARCHES) {
    const file = `${arch}/${WINDOWS_SUPERVISOR_FILE}`
    const bytes = await fs.readFile(path.join(windowsDir, file))
    verifyPeArchitecture(bytes, arch)
    artifacts[arch] = {
      file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  }
  const manifest = {
    protocolVersion: WINDOWS_NATIVE_PROTOCOL_VERSION,
    sourceSha256: await nativeSourceSha256(coreDir),
    artifacts,
  }
  await fs.mkdir(windowsDir, { recursive: true })
  await fs.writeFile(path.join(windowsDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

export async function verifyWindowsNativeArtifacts(coreDir, windowsDir) {
  const manifestPath = path.join(windowsDir, 'manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  if (manifest.protocolVersion !== WINDOWS_NATIVE_PROTOCOL_VERSION) {
    throw new Error(
      `Windows native protocol mismatch: expected ${WINDOWS_NATIVE_PROTOCOL_VERSION}, received ${String(manifest.protocolVersion)}`,
    )
  }
  const currentSourceHash = await nativeSourceSha256(coreDir)
  if (manifest.sourceSha256 !== currentSourceHash) {
    throw new Error('Windows prebuilt helper is stale; a maintainer must rebuild both architectures')
  }
  for (const arch of WINDOWS_NATIVE_ARCHES) {
    const artifact = manifest.artifacts?.[arch]
    const expectedFile = `${arch}/${WINDOWS_SUPERVISOR_FILE}`
    if (artifact?.file !== expectedFile || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) {
      throw new Error(`Windows prebuilt manifest has an invalid ${arch} artifact`)
    }
    const filePath = path.resolve(windowsDir, artifact.file)
    const relative = path.relative(windowsDir, filePath)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Windows prebuilt manifest ${arch} artifact escapes its directory`)
    }
    const bytes = await fs.readFile(filePath)
    verifyPeArchitecture(bytes, arch)
    const actualHash = createHash('sha256').update(bytes).digest('hex')
    if (actualHash !== artifact.sha256) throw new Error(`Windows prebuilt helper hash mismatch for ${arch}`)
  }
  return manifest
}
