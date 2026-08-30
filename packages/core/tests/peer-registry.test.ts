import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createPeerIdentity } from '../src/peers/identity.js'
import { peerSocketPath } from '../src/peers/paths.js'
import { createPeerRegistry, parseRegistration } from '../src/peers/registry.js'
import type { PeerTransport } from '../src/peers/transport.js'
import type { PeerRegistrationV1 } from '../src/peers/types.js'

let testDir: string
const itPosix = it.runIf(process.platform !== 'win32')

beforeEach(async () => {
  testDir = await mkdtemp(path.join(tmpdir(), 'x-code-registry-'))
  process.env.X_CODE_HOME = path.join(testDir, 'nested', 'x-code-home')
})

afterEach(async () => {
  delete process.env.X_CODE_HOME
  await rm(testDir, { recursive: true, force: true })
})

function createTestRegistry() {
  if (process.platform !== 'win32') return createPeerRegistry({})
  return createPeerRegistry({
    transportKind: 'unix',
    windowsRuntimeSecurity: {
      async initialize() {
        const registryDir = path.join(process.env.X_CODE_HOME!, 'runtime', 'peers')
        const socketDir = path.join(process.env.X_CODE_HOME!, 'runtime', 'peer-sockets')
        await Promise.all([mkdir(registryDir, { recursive: true }), mkdir(socketDir, { recursive: true })])
        return { registryDir, socketDir, namespaceId: '0123456789ab' }
      },
    },
  })
}

function registration(socketDir: string, overrides: Partial<PeerRegistrationV1> = {}): PeerRegistrationV1 {
  const identity = createPeerIdentity({ name: 'backend' })
  const now = '2026-08-13T00:00:00.000Z'
  return {
    version: 1,
    instanceId: identity.instanceId,
    pid: process.pid,
    name: identity.name,
    cwd: process.cwd(),
    transport: { kind: 'unix', address: peerSocketPath(socketDir, identity.instanceId) },
    inboxToken: identity.inboxToken,
    permissionClass: 'prompted',
    status: 'idle',
    startedAt: now,
    updatedAt: now,
    protocolVersion: 1,
    ...overrides,
  }
}

async function runChild(script: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()))
    child.once('error', reject)
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`))))
  })
}

describe('owner-only peer registry', () => {
  itPosix('rejects a symlink X_CODE_HOME without changing its target permissions', async () => {
    const target = path.join(testDir, 'target-home')
    await mkdir(target, { mode: 0o755 })
    const linked = path.join(testDir, 'linked-home')
    await symlink(target, linked)
    process.env.X_CODE_HOME = linked
    await expect(createTestRegistry().initialize()).rejects.toThrow('Unsafe peer runtime directory')
    if (process.platform !== 'win32') expect((await lstat(target)).mode & 0o777).toBe(0o755)
  })

  it('routes through X_CODE_HOME and atomically writes owner-only registrations', async () => {
    const registry = createTestRegistry()
    await registry.initialize()
    const paths = registry.paths()
    expect(paths.registryDir).toBe(path.join(process.env.X_CODE_HOME!, 'runtime', 'peers'))
    const value = registration(paths.socketDir)

    await registry.write(value)
    const candidate = await registry.read(value.instanceId)
    expect(candidate?.registration).toEqual(value)
    expect(JSON.parse(await readFile(candidate!.registrationPath, 'utf8'))).toEqual(value)
    if (process.platform !== 'win32') {
      expect((await lstat(paths.registryDir)).mode & 0o777).toBe(0o700)
      expect((await lstat(candidate!.registrationPath)).mode & 0o777).toBe(0o600)
    }
    expect((await readFile(candidate!.registrationPath, 'utf8')).length).toBeGreaterThan(0)
  })

  it('enumerates duplicate names and short-display collisions with full UUID identities', async () => {
    const registry = createTestRegistry()
    await registry.initialize()
    const socketDir = registry.paths().socketDir
    const oneInstanceId = '12345678-1111-4111-8111-111111111111'
    const twoInstanceId = '12345678-2222-4222-8222-222222222222'
    const one = registration(registry.paths().socketDir, {
      instanceId: oneInstanceId,
      name: 'same-name',
      transport: { kind: 'unix', address: peerSocketPath(socketDir, oneInstanceId) },
    })
    const two = registration(registry.paths().socketDir, {
      instanceId: twoInstanceId,
      name: 'same-name',
      transport: { kind: 'unix', address: peerSocketPath(socketDir, twoInstanceId) },
    })
    await registry.write(one)
    await registry.write(two)

    const scan = await registry.listCandidates()
    expect(scan.candidates.map((candidate) => candidate.registration.instanceId).sort()).toEqual(
      [one.instanceId, two.instanceId].sort(),
    )
    expect(new Set(scan.candidates.map((candidate) => candidate.registration.instanceId.slice(0, 8))).size).toBe(1)
    expect(new Set(scan.candidates.map((candidate) => `peer:${candidate.registration.instanceId}`)).size).toBe(2)
  })

  it('sanitizes untrusted registry name and cwd fields before exposing candidates', async () => {
    const registry = createTestRegistry()
    await registry.initialize()
    const value = registration(registry.paths().socketDir, {
      name: 'back\x1b]52;c;Y2xpcGJvYXJk\x07end\u202e',
      cwd: `${process.cwd()}\x1b]8;;https://evil.test\x1b\\`,
    })

    await registry.write(value)
    const candidate = await registry.read(value.instanceId)
    expect(candidate?.registration.name).toBe('backend')
    expect(candidate?.registration.cwd).toBe(process.cwd())
    expect(JSON.parse(await readFile(candidate!.registrationPath, 'utf8'))).toMatchObject({
      name: 'backend',
      cwd: process.cwd(),
    })
  })

  it('rejects symlinks, broad modes, oversized files, bad schema, and socket namespace escape', async () => {
    const registry = createTestRegistry()
    await registry.initialize()
    const { registryDir, socketDir } = registry.paths()

    const good = registration(socketDir)
    await registry.write(good)
    if (process.platform !== 'win32') await chmod(path.join(registryDir, `${good.instanceId}.json`), 0o644)

    const target = path.join(testDir, 'target.json')
    await writeFile(target, '{}')
    const symlinkId = randomUUID()
    if (process.platform !== 'win32') await symlink(target, path.join(registryDir, `${symlinkId}.json`))

    const oversizedId = randomUUID()
    await writeFile(path.join(registryDir, `${oversizedId}.json`), 'x'.repeat(64 * 1024 + 1), { mode: 0o600 })

    const badSchemaId = randomUUID()
    await writeFile(path.join(registryDir, `${badSchemaId}.json`), JSON.stringify({ version: 2 }), { mode: 0o600 })

    const escape = registration(socketDir)
    await writeFile(
      path.join(registryDir, `${escape.instanceId}.json`),
      JSON.stringify({ ...escape, transport: { kind: 'unix', address: path.join(testDir, 'victim.sock') } }),
      { mode: 0o600 },
    )

    const scan = await registry.listCandidates()
    expect(scan.candidates.map((candidate) => candidate.registration.instanceId)).toEqual(
      process.platform === 'win32' ? [good.instanceId] : [],
    )
    expect(scan.rejected).toBe(process.platform === 'win32' ? 3 : 5)
  })

  it('does not remove a registration for a live pid during residual cleanup', async () => {
    const registry = createTestRegistry()
    await registry.initialize()
    const value = registration(registry.paths().socketDir, {
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    })
    await registry.write(value)
    const candidate = await registry.read(value.instanceId)
    expect(await registry.cleanupConfirmedDead(candidate!, 0)).toBe(false)
    expect(await registry.read(value.instanceId)).not.toBeNull()
  })

  it('removes only a twice-confirmed dead registration after the grace period', async () => {
    const registry = createTestRegistry()
    await registry.initialize()
    const value = registration(registry.paths().socketDir, {
      pid: 2_147_483_647,
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    })
    await registry.write(value)
    const candidate = await registry.read(value.instanceId)
    expect(await registry.cleanupConfirmedDead(candidate!, 30_000)).toBe(true)
    expect(await registry.read(value.instanceId)).toBeNull()
  })

  itPosix('removes a dead colliding registration without unlinking a live registration shared socket', async () => {
    const registry = createTestRegistry()
    await registry.initialize()
    const deadId = 'bbbbbbbb-1111-4111-8111-111111111111'
    const liveId = 'bbbbbbbb-2222-4222-8222-222222222222'
    const sharedSocket = peerSocketPath(registry.paths().socketDir, deadId)
    const server = net.createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(sharedSocket, resolve)
    })
    const dead = registration(registry.paths().socketDir, {
      instanceId: deadId,
      pid: 2_147_483_647,
      transport: { kind: 'unix', address: sharedSocket },
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    })
    const live = registration(registry.paths().socketDir, {
      instanceId: liveId,
      pid: process.pid,
      transport: { kind: 'unix', address: sharedSocket },
      updatedAt: new Date().toISOString(),
    })
    await registry.write(dead)
    await registry.write(live)
    const before = await lstat(sharedSocket)

    try {
      expect(await registry.cleanupConfirmedDead((await registry.read(deadId))!, 0)).toBe(true)
      expect(await registry.read(deadId)).toBeNull()
      expect(await registry.read(liveId)).not.toBeNull()
      const after = await lstat(sharedSocket)
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('allows two independent processes to publish static candidates', async () => {
    const registryModule = path.join(process.cwd(), 'packages/core/dist/peers/registry.js')
    const identityModule = path.join(process.cwd(), 'packages/core/dist/peers/identity.js')
    const pathsModule = path.join(process.cwd(), 'packages/core/dist/peers/paths.js')
    const childScript = `
      import { mkdir } from 'node:fs/promises'
      import path from 'node:path'
      import { createPeerRegistry } from ${JSON.stringify(`file://${registryModule}`)}
      import { createPeerIdentity } from ${JSON.stringify(`file://${identityModule}`)}
      import { peerSocketPath } from ${JSON.stringify(`file://${pathsModule}`)}
      const windowsRuntimeSecurity = { initialize: async () => {
        const registryDir = path.join(process.env.X_CODE_HOME, 'runtime', 'peers')
        const socketDir = path.join(process.env.X_CODE_HOME, 'runtime', 'peer-sockets')
        await Promise.all([mkdir(registryDir, { recursive: true }), mkdir(socketDir, { recursive: true })])
        return { registryDir, socketDir, namespaceId: '0123456789ab' }
      } }
      const registry = createPeerRegistry(process.platform === 'win32' ? { transportKind: 'unix', windowsRuntimeSecurity } : {})
      await registry.initialize()
      const identity = createPeerIdentity({ name: 'child' })
      const now = new Date().toISOString()
      await registry.write({ version: 1, instanceId: identity.instanceId, pid: process.pid, name: identity.name,
        cwd: process.cwd(), transport: { kind: 'unix', address: peerSocketPath(registry.paths().socketDir, identity.instanceId) },
        inboxToken: identity.inboxToken, permissionClass: 'prompted', status: 'idle', startedAt: now, updatedAt: now,
        protocolVersion: 1 })
    `
    await Promise.all([runChild(childScript), runChild(childScript)])

    const registry = createTestRegistry()
    await registry.initialize()
    const scan = await registry.listCandidates()
    expect(scan.candidates).toHaveLength(2)
    expect(scan.candidates.every((candidate) => candidate.registration.name === 'child')).toBe(true)
  })

  it('strictly validates Windows pipe descriptors and namespace isolation', () => {
    const value = registration('C:\\runtime', {
      transport: {
        kind: 'windows-pipe',
        address: '\\\\.\\pipe\\x-code-peer-v2-0123456789ab-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    })
    expect(parseRegistration(value, { socketDir: 'C:\\runtime', namespaceId: '0123456789ab' })).not.toBeNull()
    expect(parseRegistration(value, { socketDir: 'C:\\runtime', namespaceId: 'ffffffffffff' })).toBeNull()
    expect(
      parseRegistration(
        { ...value, transport: { kind: 'windows-pipe', address: '\\\\.\\pipe\\x-code-peer-v2-0123456789ab-..' } },
        { socketDir: 'C:\\runtime', namespaceId: '0123456789ab' },
      ),
    ).toBeNull()
  })

  it('rejects registration tokens that are not full random 32-byte base64url values', async () => {
    const registry = createTestRegistry()
    await registry.initialize()
    const value = registration(registry.paths().socketDir, { inboxToken: randomBytes(8).toString('base64url') })
    await expect(registry.write(value)).rejects.toThrow('Invalid peer registration')
  })

  it('bounds listLive ping concurrency and returns only authenticated pong identities', async () => {
    const registry = createTestRegistry()
    await registry.initialize()
    const values = Array.from({ length: 20 }, () => registration(registry.paths().socketDir))
    for (const value of values) await registry.write(value)
    const byAddress = new Map(values.map((value) => [value.transport.address, value]))
    let active = 0
    let maximum = 0
    const transport: PeerTransport = {
      listen: vi.fn() as never,
      request: async ({ address, frame }) => {
        active++
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 2))
        active--
        const value = byAddress.get(address)!
        if (frame.type !== 'ping') throw new Error('expected ping')
        return { v: 1 as const, type: 'pong' as const, requestId: frame.requestId, instanceId: value.instanceId }
      },
    }
    const live = await registry.listLive({ transport, senderInstanceId: randomUUID() })
    expect(live.peers).toHaveLength(20)
    expect(maximum).toBeLessThanOrEqual(12)
    expect(live.partial).toBe(false)
  })

  it('never deletes a live-pid registration merely because ping times out', async () => {
    const registry = createTestRegistry()
    await registry.initialize()
    const value = registration(registry.paths().socketDir, {
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    })
    await registry.write(value)
    const transport: PeerTransport = {
      kind: 'unix',
      validateAddress: () => true,
      listen: vi.fn() as never,
      request: vi.fn(async () => {
        throw new Error('PEER_TIMEOUT')
      }),
    }
    const live = await registry.listLive({ transport, senderInstanceId: randomUUID() })
    expect(live.peers).toEqual([])
    expect(live.partial).toBe(true)
    expect(await registry.read(value.instanceId)).not.toBeNull()
  })

  it('honors the overall listLive deadline and caller abort', async () => {
    const registry = createTestRegistry()
    await registry.initialize()
    for (let index = 0; index < 20; index++) await registry.write(registration(registry.paths().socketDir))
    const transport: PeerTransport = {
      kind: 'unix',
      validateAddress: () => true,
      listen: vi.fn() as never,
      request: ({ signal }) =>
        new Promise<never>((_, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        ),
    }
    const limited = await registry.listLive({ transport, senderInstanceId: randomUUID(), deadlineMs: 10 })
    expect(limited).toMatchObject({ peers: [], partial: true })

    const controller = new AbortController()
    const aborted = registry.listLive({
      transport,
      senderInstanceId: randomUUID(),
      signal: controller.signal,
      deadlineMs: 1_000,
    })
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
  })
})
