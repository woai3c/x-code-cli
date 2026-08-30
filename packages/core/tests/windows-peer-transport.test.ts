import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { createPeerIdentity } from '../src/peers/identity.js'
import { createPeerRegistry } from '../src/peers/registry.js'
import { createPeerService } from '../src/peers/service.js'
import { createWindowsNamedPipeTransport } from '../src/peers/windows-named-pipe-transport.js'
import { resolveWindowsPeerBrokerArtifact } from '../src/peers/windows-peer-broker-artifact.js'
import {
  WindowsPeerBrokerFrameDecoder,
  WindowsPeerBrokerFrameKind,
  decodeOneStringPayload,
  encodeStartServerPayload,
  encodeWindowsPeerBrokerFrame,
} from '../src/peers/windows-peer-broker-protocol.js'
import { createWindowsPeerRuntimeSecurity } from '../src/peers/windows-peer-runtime-security.js'

const describeWindows = process.platform === 'win32' ? describe : describe.skip
const addressHint = path.join(os.tmpdir(), 'x-code-windows-peer.sock')
const execFileAsync = promisify(execFile)

describeWindows('Windows named pipe peer transport', () => {
  it('creates and secures an absent user runtime root', async () => {
    const root = path.join(os.homedir(), `.x-code-peer-clean-root-${randomUUID()}`)
    const registry = createPeerRegistry({
      windowsRuntimeSecurity: createWindowsPeerRuntimeSecurity({ root }),
    })
    try {
      await registry.initialize()
      expect((await fs.stat(registry.paths().registryDir)).isDirectory()).toBe(true)
      expect(registry.paths().namespaceId).toMatch(/^[a-f0-9]{12}$/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a runtime root reached through a junction', async () => {
    const base = path.join(os.homedir(), `.x-code-peer-junction-${randomUUID()}`)
    const target = path.join(base, 'target')
    const root = path.join(base, 'root')
    await fs.mkdir(target, { recursive: true })
    await fs.symlink(target, root, 'junction')
    try {
      await expect(createWindowsPeerRuntimeSecurity({ root }).initialize()).rejects.toMatchObject({
        name: 'PEER_WINDOWS_RUNTIME_UNSAFE',
      })
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  it('rejects a runtime root replaceable by another ordinary principal', async () => {
    const root = path.join(os.homedir(), `.x-code-peer-insecure-acl-${randomUUID()}`)
    await fs.mkdir(root, { recursive: true })
    await execFileAsync('icacls.exe', [root, '/grant', '*S-1-1-0:(OI)(CI)M'])
    try {
      await expect(createWindowsPeerRuntimeSecurity({ root }).initialize()).rejects.toMatchObject({
        name: 'PEER_WINDOWS_RUNTIME_UNSAFE',
      })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('discovers and sends between two real broker-backed services', async () => {
    const suffix = Date.now().toString(36)
    const sender = createPeerService({ enabled: true, name: `windows-sender-${suffix}` })
    const receiver = createPeerService({ enabled: true, name: `windows-receiver-${suffix}` })
    try {
      await sender.start()
      await receiver.start()
      expect(sender.isAvailable()).toBe(true)
      expect(receiver.isAvailable()).toBe(true)
      const peers = await sender.listAgents()
      expect(peers.some((peer) => peer.address === receiver.identity!.address)).toBe(true)
      await expect(
        sender.sendMessage(receiver.identity!.address, 'Windows transport integration'),
      ).resolves.toMatchObject({
        success: true,
        status: 'delivered',
      })
    } finally {
      await Promise.all([sender.shutdown(), receiver.shutdown()])
    }
  })

  it('rejects a wrong token before dispatching to Node', async () => {
    const senderRegistry = createPeerRegistry()
    const receiverRegistry = createPeerRegistry()
    await Promise.all([senderRegistry.initialize(), receiverRegistry.initialize()])
    const sender = createPeerIdentity({ name: 'transport-sender' })
    const receiver = createPeerIdentity({ name: 'transport-receiver' })
    const senderTransport = createWindowsNamedPipeTransport({ getRuntimePaths: () => senderRegistry.paths() })
    const receiverTransport = createWindowsNamedPipeTransport({ getRuntimePaths: () => receiverRegistry.paths() })
    let dispatches = 0
    const senderServer = await senderTransport.listen({
      address: addressHint,
      instanceId: sender.instanceId,
      inboxToken: sender.inboxToken,
      onRequest: async () => ({ v: 1, type: 'error', code: 'PEER_TEST', message: 'unexpected' }),
    })
    const receiverServer = await receiverTransport.listen({
      address: addressHint,
      instanceId: receiver.instanceId,
      inboxToken: receiver.inboxToken,
      onRequest: async (frame) => {
        dispatches++
        return frame
      },
    })
    try {
      await expect(
        senderTransport.request({
          address: receiverServer.address,
          targetToken: 'x'.repeat(43),
          senderInstanceId: sender.instanceId,
          frame: { v: 1, type: 'ping', requestId: randomUUID() },
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({ name: 'PEER_WINDOWS_PIPE_IO_FAILED' })
      expect(dispatches).toBe(0)
    } finally {
      await Promise.all([senderServer.close(), receiverServer.close()])
    }
  })

  it('propagates abort and bounds shutdown while an inbound callback remains active', async () => {
    const senderRegistry = createPeerRegistry()
    const receiverRegistry = createPeerRegistry()
    await Promise.all([senderRegistry.initialize(), receiverRegistry.initialize()])
    const sender = createPeerIdentity({ name: 'abort-sender' })
    const receiver = createPeerIdentity({ name: 'abort-receiver' })
    const senderTransport = createWindowsNamedPipeTransport({ getRuntimePaths: () => senderRegistry.paths() })
    const receiverTransport = createWindowsNamedPipeTransport({ getRuntimePaths: () => receiverRegistry.paths() })
    let dispatches = 0
    const senderServer = await senderTransport.listen({
      address: addressHint,
      instanceId: sender.instanceId,
      inboxToken: sender.inboxToken,
      onRequest: async () => ({ v: 1, type: 'error', code: 'PEER_TEST', message: 'unexpected' }),
    })
    const receiverServer = await receiverTransport.listen({
      address: addressHint,
      instanceId: receiver.instanceId,
      inboxToken: receiver.inboxToken,
      onRequest: async (frame) => {
        dispatches++
        if (dispatches === 1) return new Promise(() => {})
        return frame
      },
    })
    const controller = new AbortController()
    const request = senderTransport.request({
      address: receiverServer.address,
      targetToken: receiver.inboxToken,
      senderInstanceId: sender.instanceId,
      frame: { v: 1, type: 'ping', requestId: randomUUID() },
      timeoutMs: 5_000,
      signal: controller.signal,
    })
    while (dispatches === 0) await delay(5)
    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    const followUpRequestId = randomUUID()
    await expect(
      senderTransport.request({
        address: receiverServer.address,
        targetToken: receiver.inboxToken,
        senderInstanceId: sender.instanceId,
        frame: { v: 1, type: 'ping', requestId: followUpRequestId },
        timeoutMs: 2_000,
      }),
    ).resolves.toMatchObject({ type: 'ping', requestId: followUpRequestId })
    const startedAt = Date.now()
    await Promise.all([senderServer.close({ deadlineMs: 300 }), receiverServer.close({ deadlineMs: 300 })])
    expect(Date.now() - startedAt).toBeLessThan(1_500)
  })

  it('exits and releases its pipe when the parent stdin channel reaches EOF', async () => {
    const registry = createPeerRegistry()
    await registry.initialize()
    const identity = createPeerIdentity({ name: 'parent-eof' })
    const artifact = await resolveWindowsPeerBrokerArtifact()
    const child = spawn(artifact.executablePath, ['broker', '--protocol', '2'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const decoder = new WindowsPeerBrokerFrameDecoder()
    const address = await new Promise<string>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', () => reject(new Error('broker exited before SERVER_READY')))
      child.stdout.on('data', (chunk: Buffer) => {
        try {
          for (const frame of decoder.push(chunk)) {
            if (frame.kind === WindowsPeerBrokerFrameKind.ServerReady) resolve(decodeOneStringPayload(frame.payload))
          }
        } catch (error) {
          reject(error)
        }
      })
      child.stdin.write(
        encodeWindowsPeerBrokerFrame({
          kind: WindowsPeerBrokerFrameKind.StartServer,
          operationId: 1,
          payload: encodeStartServerPayload({
            namespaceId: registry.paths().namespaceId!,
            instanceId: identity.instanceId,
            inboxToken: identity.inboxToken,
          }),
        }),
      )
    })
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.stdin.end()
    await Promise.race([
      exited,
      delay(2_000).then(() => {
        child.kill()
        throw new Error('broker did not exit after parent EOF')
      }),
    ])
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = net.connect(address)
        socket.once('connect', () => {
          socket.destroy()
          reject(new Error('released peer pipe remained connectable'))
        })
        socket.once('error', () => resolve())
      }),
    ).resolves.toBeUndefined()
  })

  it('receives the graceful shutdown acknowledgement from a real broker', async () => {
    const registry = createPeerRegistry()
    await registry.initialize()
    const identity = createPeerIdentity({ name: 'graceful-shutdown' })
    let acknowledged = false
    let resolveAcknowledgement!: () => void
    let rejectAcknowledgement!: (error: unknown) => void
    const acknowledgement = new Promise<void>((resolve, reject) => {
      resolveAcknowledgement = resolve
      rejectAcknowledgement = reject
    })
    let resolveExit!: (status: { code: number | null; signal: NodeJS.Signals | null }) => void
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      resolveExit = resolve
    })
    const spawnBroker: typeof spawn = ((command, args, options) => {
      const child = spawn(command, args ?? [], options as never) as ChildProcessWithoutNullStreams
      const decoder = new WindowsPeerBrokerFrameDecoder()
      child.stdout.on('data', (chunk: Buffer) => {
        try {
          for (const frame of decoder.push(chunk)) {
            if (frame.kind !== WindowsPeerBrokerFrameKind.ShutdownComplete) continue
            acknowledged = true
            resolveAcknowledgement()
          }
        } catch (error) {
          rejectAcknowledgement(error)
        }
      })
      child.once('close', (code, signal) => {
        if (!acknowledged) rejectAcknowledgement(new Error('broker exited before SHUTDOWN_COMPLETE'))
        resolveExit({ code, signal })
      })
      return child
    }) as typeof spawn
    const transport = createWindowsNamedPipeTransport({ getRuntimePaths: () => registry.paths(), spawnBroker })
    const server = await transport.listen({
      address: addressHint,
      instanceId: identity.instanceId,
      inboxToken: identity.inboxToken,
      onRequest: async (frame) => frame,
    })
    const gracefulExit = expect(Promise.all([acknowledgement, exited])).resolves.toEqual([
      undefined,
      { code: 0, signal: null },
    ])

    await server.close({ deadlineMs: 500 })
    await gracefulExit
  })

  it('reports an unexpected broker exit through server.closed', async () => {
    const registry = createPeerRegistry()
    await registry.initialize()
    const children: ChildProcessWithoutNullStreams[] = []
    const spawnBroker: typeof spawn = ((command, args, options) => {
      const child = spawn(command, args ?? [], options as never) as ChildProcessWithoutNullStreams
      children.push(child)
      return child
    }) as typeof spawn
    const identity = createPeerIdentity({ name: 'crash-receiver' })
    const transport = createWindowsNamedPipeTransport({ getRuntimePaths: () => registry.paths(), spawnBroker })
    const server = await transport.listen({
      address: addressHint,
      instanceId: identity.instanceId,
      inboxToken: identity.inboxToken,
      onRequest: async (frame) => frame,
    })
    expect(children).toHaveLength(1)
    children[0]!.kill()
    await expect(server.closed!).resolves.toMatchObject({ expected: false })
  })

  it('survives clients that disconnect before authentication', async () => {
    const registry = createPeerRegistry()
    await registry.initialize()
    const identity = createPeerIdentity({ name: 'disconnect-stress' })
    const transport = createWindowsNamedPipeTransport({ getRuntimePaths: () => registry.paths() })
    const server = await transport.listen({
      address: addressHint,
      instanceId: identity.instanceId,
      inboxToken: identity.inboxToken,
      onRequest: async (frame) => frame,
    })
    try {
      for (let index = 0; index < 4_000; index++) {
        await new Promise<void>((resolve) => {
          const socket = net.connect(server.address)
          socket.once('connect', () => {
            socket.destroy()
            resolve()
          })
          socket.once('error', () => resolve())
        })
      }

      const requestId = randomUUID()
      await expect(
        transport.request({
          address: server.address,
          targetToken: identity.inboxToken,
          senderInstanceId: identity.instanceId,
          frame: { v: 1, type: 'ping', requestId },
          timeoutMs: 2_000,
        }),
      ).resolves.toMatchObject({ type: 'ping', requestId })
      await expect(Promise.race([server.closed!.then(() => true), delay(50).then(() => false)])).resolves.toBe(false)
    } finally {
      await server.close()
    }
  }, 30_000)

  it('releases capacity after 256 concurrent unreachable operations', async () => {
    const registry = createPeerRegistry()
    await registry.initialize()
    const identity = createPeerIdentity({ name: 'success-capacity' })
    const transport = createWindowsNamedPipeTransport({ getRuntimePaths: () => registry.paths() })
    const server = await transport.listen({
      address: addressHint,
      instanceId: identity.instanceId,
      inboxToken: identity.inboxToken,
      onRequest: async (frame) => frame,
    })
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        const unreachableAddress = `\\\\.\\pipe\\x-code-peer-v2-${registry.paths().namespaceId}-${'B'.repeat(32)}`
        const attempts = await Promise.allSettled(
          Array.from({ length: 256 }, () =>
            transport.request({
              address: unreachableAddress,
              targetToken: identity.inboxToken,
              senderInstanceId: identity.instanceId,
              frame: { v: 1, type: 'ping', requestId: randomUUID() },
              timeoutMs: 500,
            }),
          ),
        )
        expect(attempts.every((attempt) => attempt.status === 'rejected')).toBe(true)

        const requestId = randomUUID()
        await expect(
          transport.request({
            address: server.address,
            targetToken: identity.inboxToken,
            senderInstanceId: identity.instanceId,
            frame: { v: 1, type: 'ping', requestId },
            timeoutMs: 2_000,
          }),
        ).resolves.toMatchObject({ type: 'ping', requestId })
      }
    } finally {
      await server.close()
    }
  }, 15_000)

  it('fails the service closed and removes its registration after a broker crash', async () => {
    const registry = createPeerRegistry()
    const children: ChildProcessWithoutNullStreams[] = []
    const spawnBroker: typeof spawn = ((command, args, options) => {
      const child = spawn(command, args ?? [], options as never) as ChildProcessWithoutNullStreams
      children.push(child)
      return child
    }) as typeof spawn
    const transport = createWindowsNamedPipeTransport({ getRuntimePaths: () => registry.paths(), spawnBroker })
    const service = createPeerService({
      enabled: true,
      name: `crash-cleanup-${Date.now().toString(36)}`,
      registry,
      transport,
    })
    try {
      await service.start()
      expect(service.isAvailable()).toBe(true)
      await expect(registry.read(service.identity!.instanceId)).resolves.not.toBeNull()
      expect(children).toHaveLength(1)

      children[0]!.kill()
      await vi.waitFor(() => expect(service.isAvailable()).toBe(false))
      await vi.waitFor(async () => expect(await registry.read(service.identity!.instanceId)).toBeNull())
      expect(service.getUnavailableReason()).toBeTruthy()
    } finally {
      await service.shutdown()
    }
  })

  it('accepts late canceled terminals but rejects unsolicited duplicate terminals', async () => {
    const namespaceId = '0123456789ab'
    const fakeBroker = String.raw`
      let buffered = Buffer.alloc(0)
      const pending = new Map()
      let cancellations = 0
      const send = (kind, operationId, payload = Buffer.alloc(0)) => {
        const response = Buffer.allocUnsafe(16 + payload.length)
        response.write('XCPB')
        response[4] = 2
        response[5] = kind
        response.writeUInt16LE(0, 6)
        response.writeUInt32LE(operationId, 8)
        response.writeUInt32LE(payload.length, 12)
        payload.copy(response, 16)
        process.stdout.write(response)
      }
      const encodeBytes = (bytes) => {
        const payload = Buffer.allocUnsafe(4 + bytes.length)
        payload.writeUInt32LE(bytes.length, 0)
        bytes.copy(payload, 4)
        return payload
      }
      const readPeerFrame = (payload) => {
        let offset = 0
        for (let index = 0; index < 3; index++) {
          const length = payload.readUInt16LE(offset)
          offset += 2 + length
        }
        offset += 4
        const length = payload.readUInt32LE(offset)
        return Buffer.from(payload.subarray(offset + 4, offset + 4 + length))
      }
      process.stdin.on('data', (chunk) => {
        buffered = Buffer.concat([buffered, chunk])
        while (buffered.length >= 16) {
          const payloadLength = buffered.readUInt32LE(12)
          const frameLength = 16 + payloadLength
          if (buffered.length < frameLength) return
          const kind = buffered[5]
          const operationId = buffered.readUInt32LE(8)
          const payload = buffered.subarray(16, frameLength)
          buffered = buffered.subarray(frameLength)
          if (kind === 2) {
            const namespaceLength = payload.readUInt16LE(0)
            const namespace = payload.subarray(2, 2 + namespaceLength).toString('utf8')
            const address = '\\\\.\\pipe\\x-code-peer-v2-' + namespace + '-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
            const addressBytes = Buffer.from(address)
            const responsePayload = Buffer.allocUnsafe(2 + addressBytes.length)
            responsePayload.writeUInt16LE(addressBytes.length)
            addressBytes.copy(responsePayload, 2)
            send(0x82, 0, responsePayload)
          } else if (kind === 3) {
            pending.set(operationId, readPeerFrame(payload))
            setTimeout(() => {
              const peerFrame = pending.get(operationId)
              if (!peerFrame) return
              pending.delete(operationId)
              send(0x84, operationId, encodeBytes(peerFrame))
              if (cancellations === 300) send(0x84, operationId, encodeBytes(peerFrame))
            }, 10)
          } else if (kind === 5) {
            cancellations++
            const peerFrame = pending.get(operationId)
            if (!peerFrame) continue
            pending.delete(operationId)
            send(0x84, operationId, encodeBytes(peerFrame))
          } else if (kind === 6) {
            send(0x88, 0)
            setTimeout(() => process.exit(0), 10)
          }
        }
      })
    `
    const spawnBroker = (() =>
      spawn(process.execPath, ['-e', fakeBroker], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams) as unknown as typeof spawn
    const transport = createWindowsNamedPipeTransport({
      getRuntimePaths: () => ({ namespaceId }),
      artifact: { executablePath: process.execPath, protocolVersion: 2, sha256: '0'.repeat(64) },
      spawnBroker,
    })
    const identity = createPeerIdentity({ name: 'bounded-operation-client' })
    const server = await transport.listen({
      address: addressHint,
      instanceId: identity.instanceId,
      inboxToken: identity.inboxToken,
      onRequest: async (frame) => frame,
    })
    const request = (signal?: AbortSignal, targetToken = identity.inboxToken) =>
      transport.request({
        address: server.address,
        targetToken,
        senderInstanceId: identity.instanceId,
        frame: { v: 1, type: 'ping', requestId: randomUUID() },
        timeoutMs: 60_000,
        signal,
      })

    try {
      for (let index = 0; index < 300; index++) {
        await expect(request(undefined, 'x'.repeat(65_536))).rejects.toMatchObject({
          name: 'PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH',
        })
      }

      for (let index = 0; index < 300; index++) {
        const controller = new AbortController()
        const pending = request(controller.signal)
        controller.abort()
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      }
      await expect(request()).resolves.toMatchObject({ type: 'ping' })
      await expect(server.closed).resolves.toEqual({
        expected: false,
        reason: 'Unexpected terminal operation ID',
      })
    } finally {
      await server.close({ deadlineMs: 0 })
    }
  })
})
