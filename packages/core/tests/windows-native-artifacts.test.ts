import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

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
})
