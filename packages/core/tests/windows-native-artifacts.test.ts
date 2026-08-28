import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { resolveWindowsPeerBrokerArtifact } from '../src/peers/windows-peer-broker-artifact.js'

interface ManifestEntry {
  file: string
  protocolVersion: number
  sha256: string
  sourceSha256: string
}

interface NativeManifest {
  manifestVersion: number
  artifacts: Record<'x64' | 'arm64', Record<'shellSupervisor' | 'peerBroker', ManifestEntry>>
}

const nativeRoot = path.resolve('packages/core/dist/native/windows')
const coreDir = path.resolve('packages/core')
const writeManifestScript = path.join(coreDir, 'scripts', 'write-native-manifest.mjs')
const execFileAsync = promisify(execFile)
let testRoot = ''

beforeEach(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'x-code-native-artifacts-'))
  await fs.cp(nativeRoot, testRoot, { recursive: true })
})

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true })
})

async function readManifest(root = testRoot): Promise<NativeManifest> {
  return JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')) as NativeManifest
}

async function writeManifest(manifest: NativeManifest): Promise<void> {
  await fs.writeFile(path.join(testRoot, 'manifest.json'), JSON.stringify(manifest), 'utf8')
}

describe('Windows native artifacts', () => {
  it('packages both independently traceable helpers for x64 and arm64', async () => {
    const manifest = await readManifest(nativeRoot)
    expect(manifest.manifestVersion).toBe(2)
    for (const arch of ['x64', 'arm64'] as const) {
      for (const artifactName of ['shellSupervisor', 'peerBroker'] as const) {
        const artifact = manifest.artifacts[arch][artifactName]
        const bytes = await fs.readFile(path.join(nativeRoot, artifact.file))
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256)
        expect(artifact.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
      }
      expect(manifest.artifacts[arch].shellSupervisor.protocolVersion).toBe(2)
      expect(manifest.artifacts[arch].peerBroker.protocolVersion).toBe(1)
    }
    expect(manifest.artifacts.x64.shellSupervisor.sourceSha256).not.toBe(manifest.artifacts.x64.peerBroker.sourceSha256)
  })

  it('validates protocol, path, hash, and PE architecture before launching a broker', async () => {
    await expect(resolveWindowsPeerBrokerArtifact('x64', testRoot)).resolves.toMatchObject({ protocolVersion: 1 })
    await expect(resolveWindowsPeerBrokerArtifact('arm64', testRoot)).resolves.toMatchObject({ protocolVersion: 1 })

    const protocol = await readManifest()
    protocol.artifacts.x64.peerBroker.protocolVersion = 2
    await writeManifest(protocol)
    await expect(resolveWindowsPeerBrokerArtifact('x64', testRoot)).rejects.toMatchObject({
      name: 'PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH',
    })

    const escaped = await readManifest(nativeRoot)
    escaped.artifacts.x64.peerBroker.file = '../outside.exe'
    await writeManifest(escaped)
    await expect(resolveWindowsPeerBrokerArtifact('x64', testRoot)).rejects.toMatchObject({
      name: 'PEER_WINDOWS_HELPER_HASH_MISMATCH',
    })

    const wrongArchitecture = await readManifest(nativeRoot)
    const armBytes = await fs.readFile(path.join(nativeRoot, wrongArchitecture.artifacts.arm64.peerBroker.file))
    const x64Path = path.join(testRoot, wrongArchitecture.artifacts.x64.peerBroker.file)
    await fs.writeFile(x64Path, armBytes)
    wrongArchitecture.artifacts.x64.peerBroker.sha256 = createHash('sha256').update(armBytes).digest('hex')
    await writeManifest(wrongArchitecture)
    await expect(resolveWindowsPeerBrokerArtifact('x64', testRoot)).rejects.toMatchObject({
      name: 'PEER_WINDOWS_HELPER_HASH_MISMATCH',
    })
  })

  it('fails closed for unsupported Windows architectures', async () => {
    await expect(resolveWindowsPeerBrokerArtifact('ia32', testRoot)).rejects.toMatchObject({
      name: 'PEER_WINDOWS_UNSUPPORTED_ARCH',
    })
  })

  it('preserves source provenance for binaries that were not rebuilt', async () => {
    const scriptRoot = await fs.mkdtemp(path.join(coreDir, '.native-manifest-test-'))
    try {
      await fs.cp(nativeRoot, scriptRoot, { recursive: true })
      const manifest = await readManifest(scriptRoot)
      const currentX64Source = manifest.artifacts.x64.peerBroker.sourceSha256
      manifest.artifacts.arm64.peerBroker.sourceSha256 = '1'.repeat(64)
      await fs.writeFile(path.join(scriptRoot, 'manifest.json'), JSON.stringify(manifest), 'utf8')

      await execFileAsync(process.execPath, [writeManifestScript, scriptRoot, '--built', 'x64:peerBroker'])
      const updated = await readManifest(scriptRoot)
      expect(updated.artifacts.x64.peerBroker.sourceSha256).toBe(currentX64Source)
      expect(updated.artifacts.arm64.peerBroker.sourceSha256).toBe('1'.repeat(64))

      await expect(execFileAsync(process.execPath, [writeManifestScript, scriptRoot])).rejects.toThrow(
        /explicitly built artifact/i,
      )

      await fs.appendFile(path.join(scriptRoot, updated.artifacts.arm64.peerBroker.file), Buffer.from([0]))
      await expect(
        execFileAsync(process.execPath, [writeManifestScript, scriptRoot, '--built', 'x64:peerBroker']),
      ).rejects.toThrow(/cannot preserve provenance/i)
    } finally {
      await fs.rm(scriptRoot, { recursive: true, force: true })
    }
  })
})
