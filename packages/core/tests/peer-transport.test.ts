import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { randomBytes, randomUUID } from 'node:crypto'
import fs, { lstat, mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { MAX_FRAME_BYTES, encodePeerFrame } from '../src/peers/protocol.js'
import { createUnixSocketTransport } from '../src/peers/unix-socket-transport.js'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'x-code-transport-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function token(): string {
  return randomBytes(32).toString('base64url')
}

async function listenReplacement(address: string, sockets: Set<net.Socket>): Promise<net.Server> {
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.end('replacement')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(address, resolve)
  })
  return server
}

async function expectReplacementReachable(address: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const client = net.createConnection(address)
    client.once('data', (chunk) => {
      expect(chunk.toString()).toBe('replacement')
      client.destroy()
      resolve()
    })
    client.once('error', reject)
  })
}

async function closeReplacement(server: net.Server, sockets: Set<net.Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

describe.runIf(process.platform !== 'win32')('Unix peer transport', () => {
  it('closes the bound listener and removes its owned socket when post-bind initialization fails', async () => {
    const address = path.join(directory, 'post-bind-failure.sock')
    let boundAddress: string | undefined
    const chmod = vi.fn(async (filePath: string) => {
      boundAddress = filePath
      throw new Error('simulated post-bind chmod failure')
    })
    const transport = createUnixSocketTransport({ fileSystem: { ...fs, chmod } })

    await expect(
      transport.listen({
        address,
        instanceId: randomUUID(),
        inboxToken: token(),
        onRequest: async () => ({ v: 1, type: 'error', code: 'unused', message: 'unused' }),
      }),
    ).rejects.toThrow('simulated post-bind chmod failure')

    expect(boundAddress).toMatch(
      new RegExp(`^${directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/p-[A-Za-z0-9_-]{16}\\.sock$`),
    )
    expect(chmod).toHaveBeenCalledWith(boundAddress, 0o600)
    await expect(lstat(boundAddress!)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      new Promise<void>((resolve, reject) => {
        const client = net.createConnection(boundAddress!)
        client.once('connect', () => reject(new Error('listener leaked after initialization failure')))
        client.once('error', () => resolve())
      }),
    ).resolves.toBeUndefined()
  })

  it('aborts a listener while post-bind initialization is in flight without leaking the socket', async () => {
    const address = path.join(directory, 'post-bind-abort.sock')
    let signalChmod!: () => void
    const chmodStarted = new Promise<void>((resolve) => (signalChmod = resolve))
    let releaseChmod!: () => void
    const chmodGate = new Promise<void>((resolve) => (releaseChmod = resolve))
    let boundAddress: string | undefined
    const transport = createUnixSocketTransport({
      fileSystem: {
        ...fs,
        chmod: vi.fn(async (filePath, mode) => {
          boundAddress = String(filePath)
          signalChmod()
          await chmodGate
          return fs.chmod(filePath, mode)
        }),
      },
    })
    const controller = new AbortController()
    const listening = transport.listen({
      address,
      instanceId: randomUUID(),
      inboxToken: token(),
      onRequest: async () => ({ v: 1, type: 'error', code: 'unused', message: 'unused' }),
      signal: controller.signal,
    })
    await chmodStarted
    controller.abort()
    releaseChmod()

    await expect(listening).rejects.toMatchObject({ name: 'AbortError' })
    expect(boundAddress).toBeDefined()
    await expect(lstat(boundAddress!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readdir(directory)).toEqual([])
  })

  it('does not trust or unlink a replacement observed by the first post-bind lstat', async () => {
    let replacement: net.Server | undefined
    let replacementAddress: string | undefined
    const replacementSockets = new Set<net.Socket>()
    let replaced = false
    const transport = createUnixSocketTransport({
      fileSystem: {
        ...fs,
        lstat: vi.fn(async (filePath: string) => {
          const candidate = String(filePath)
          if (!replaced && path.basename(candidate).startsWith('p-')) {
            replaced = true
            replacementAddress = candidate
            await fs.rm(candidate)
            replacement = await listenReplacement(candidate, replacementSockets)
          }
          return fs.lstat(filePath)
        }),
      },
    })

    await expect(
      transport.listen({
        address: path.join(directory, 'race.sock'),
        instanceId: randomUUID(),
        inboxToken: token(),
        onRequest: async () => ({ v: 1, type: 'error', code: 'unused', message: 'unused' }),
      }),
    ).rejects.toThrow(/PEER_SOCKET_OWNERSHIP_UNVERIFIED|PEER_CONNECTION_CLOSED|PEER_INVALID_JSON/)

    expect(replacementAddress).toBeDefined()
    await expect(lstat(replacementAddress!)).resolves.toMatchObject({})
    await expectReplacementReachable(replacementAddress!)
    await closeReplacement(replacement!, replacementSockets)
  })

  it('restores a replacement swapped in between close lstat and rename', async () => {
    let boundAddress: string | undefined
    let injectReplacement = false
    let replacement: net.Server | undefined
    let replacementIdentity: Awaited<ReturnType<typeof lstat>> | undefined
    const replacementSockets = new Set<net.Socket>()
    const transport = createUnixSocketTransport({
      fileSystem: {
        ...fs,
        rename: vi.fn(async (oldPath: string, newPath: string) => {
          if (injectReplacement && oldPath === boundAddress && newPath.includes('.closing-')) {
            injectReplacement = false
            await fs.rm(oldPath)
            replacement = await listenReplacement(oldPath, replacementSockets)
            replacementIdentity = await lstat(oldPath)
          }
          return fs.rename(oldPath, newPath)
        }),
      },
    })
    const server = await transport.listen({
      address: path.join(directory, 'close-lstat-rename.sock'),
      instanceId: randomUUID(),
      inboxToken: token(),
      onRequest: async () => ({ v: 1, type: 'error', code: 'unused', message: 'unused' }),
    })
    boundAddress = server.address
    injectReplacement = true

    await server.close()

    const restored = await lstat(boundAddress)
    expect({ dev: restored.dev, ino: restored.ino }).toEqual({
      dev: replacementIdentity!.dev,
      ino: replacementIdentity!.ino,
    })
    expect((await fs.readdir(directory)).filter((entry) => entry.includes('.closing-'))).toEqual([])
    await expectReplacementReachable(boundAddress)
    await closeReplacement(replacement!, replacementSockets)
  })

  it('moves and restores a replacement that wins between rename and sentinel creation', async () => {
    let boundAddress: string | undefined
    let injectReplacement = false
    let replacement: net.Server | undefined
    let replacementIdentity: Awaited<ReturnType<typeof lstat>> | undefined
    const replacementSockets = new Set<net.Socket>()
    const transport = createUnixSocketTransport({
      fileSystem: {
        ...fs,
        mkdir: vi.fn(async (filePath: string, options: { mode: number }) => {
          if (injectReplacement && filePath === boundAddress) {
            injectReplacement = false
            replacement = await listenReplacement(filePath, replacementSockets)
            replacementIdentity = await lstat(filePath)
          }
          return fs.mkdir(filePath, options)
        }),
      },
    })
    const server = await transport.listen({
      address: path.join(directory, 'close-rename-sentinel.sock'),
      instanceId: randomUUID(),
      inboxToken: token(),
      onRequest: async () => ({ v: 1, type: 'error', code: 'unused', message: 'unused' }),
    })
    boundAddress = server.address
    injectReplacement = true

    await server.close()

    const restored = await lstat(boundAddress)
    expect({ dev: restored.dev, ino: restored.ino }).toEqual({
      dev: replacementIdentity!.dev,
      ino: replacementIdentity!.ino,
    })
    expect((await fs.readdir(directory)).filter((entry) => entry.includes('.closing-'))).toEqual([])
    await expectReplacementReachable(boundAddress)
    await closeReplacement(replacement!, replacementSockets)
  })

  it('authenticates and completes a ping/pong round trip', async () => {
    const transport = createUnixSocketTransport()
    const instanceId = randomUUID()
    const inboxToken = token()
    const server = await transport.listen({
      address: path.join(directory, 'peer.sock'),
      instanceId,
      inboxToken,
      onRequest: async (frame) => {
        if (frame.type !== 'ping') throw new Error('unexpected')
        return { v: 1, type: 'pong', requestId: frame.requestId, instanceId }
      },
    })
    const requestId = randomUUID()
    await expect(
      transport.request({
        address: server.address,
        targetToken: inboxToken,
        senderInstanceId: randomUUID(),
        frame: { v: 1, type: 'ping', requestId },
      }),
    ).resolves.toEqual({ v: 1, type: 'pong', requestId, instanceId })
    await server.close()
  })

  it('rejects an incorrect token before dispatch', async () => {
    const transport = createUnixSocketTransport()
    const onRequest = vi.fn()
    const server = await transport.listen({
      address: path.join(directory, 'auth.sock'),
      instanceId: randomUUID(),
      inboxToken: token(),
      onRequest,
    })
    await expect(
      transport.request({
        address: server.address,
        targetToken: token(),
        senderInstanceId: randomUUID(),
        frame: { v: 1, type: 'ping', requestId: randomUUID() },
      }),
    ).rejects.toThrow('PEER_AUTH_FAILED')
    expect(onRequest).not.toHaveBeenCalled()
    await server.close()
  })

  it('times out and honors AbortSignal while waiting for a reply', async () => {
    const transport = createUnixSocketTransport()
    const server = await transport.listen({
      address: path.join(directory, 'timeout.sock'),
      instanceId: randomUUID(),
      inboxToken: token(),
      onRequest: async () => new Promise(() => {}),
    })
    const params = {
      address: server.address,
      targetToken: token(),
      senderInstanceId: randomUUID(),
      frame: { v: 1, type: 'ping', requestId: randomUUID() } as const,
    }
    // Use the server's real token after constructing one shared parameter object.
    const actualToken = token()
    await server.close()
    const active = await transport.listen({
      address: path.join(directory, 'active.sock'),
      instanceId: randomUUID(),
      inboxToken: actualToken,
      onRequest: async () => new Promise(() => {}),
    })
    await expect(
      transport.request({ ...params, address: active.address, targetToken: actualToken, timeoutMs: 20 }),
    ).rejects.toThrow('PEER_TIMEOUT')
    const controller = new AbortController()
    const aborted = transport.request({
      ...params,
      address: active.address,
      targetToken: actualToken,
      signal: controller.signal,
    })
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    await active.close()
  })

  it('drops malformed and oversized raw client frames without dispatching', async () => {
    const transport = createUnixSocketTransport()
    const instanceId = randomUUID()
    const inboxToken = token()
    const onRequest = vi.fn()
    const server = await transport.listen({
      address: path.join(directory, 'raw.sock'),
      instanceId,
      inboxToken,
      onRequest,
    })
    const sendRaw = async (payload: Buffer): Promise<void> => {
      await new Promise<void>((resolve) => {
        const socket = net.createConnection(server.address, () => socket.write(payload))
        socket.on('data', () => {})
        socket.on('close', resolve)
        socket.on('error', resolve)
      })
    }
    await sendRaw(Buffer.from([0xc3, 0x28, 0x0a]))
    await sendRaw(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61))
    expect(onRequest).not.toHaveBeenCalled()
    await server.close()
  })

  it('drains active connections on shutdown within the configured deadline', async () => {
    const transport = createUnixSocketTransport()
    const inboxToken = token()
    const server = await transport.listen({
      address: path.join(directory, 'shutdown.sock'),
      instanceId: randomUUID(),
      inboxToken,
      onRequest: async () => new Promise(() => {}),
    })
    const pending = transport
      .request({
        address: server.address,
        targetToken: inboxToken,
        senderInstanceId: randomUUID(),
        frame: { v: 1, type: 'ping', requestId: randomUUID() },
        timeoutMs: 1_000,
      })
      .catch((error) => error)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const started = Date.now()
    await server.close({ deadlineMs: 20 })
    expect(Date.now() - started).toBeLessThan(200)
    await expect(pending).resolves.toBeInstanceOf(Error)
  })

  it('does not unlink a replacement socket when its owned path changes identity before close', async () => {
    const address = path.join(directory, 'replaced.sock')
    const transport = createUnixSocketTransport()
    const server = await transport.listen({
      address,
      instanceId: randomUUID(),
      inboxToken: token(),
      onRequest: async () => ({ v: 1, type: 'error', code: 'unused', message: 'unused' }),
    })
    const boundAddress = server.address
    await rm(boundAddress)
    const replacement = net.createServer((socket) => socket.end('replacement'))
    await new Promise<void>((resolve, reject) => {
      replacement.once('error', reject)
      replacement.listen(boundAddress, resolve)
    })
    const replacementIdentity = await lstat(boundAddress)

    await server.close()

    const after = await lstat(boundAddress)
    expect({ dev: after.dev, ino: after.ino }).toEqual({
      dev: replacementIdentity.dev,
      ino: replacementIdentity.ino,
    })
    await new Promise<void>((resolve, reject) => {
      const client = net.createConnection(boundAddress)
      client.once('data', (chunk) => {
        expect(chunk.toString()).toBe('replacement')
        client.destroy()
        resolve()
      })
      client.once('error', reject)
    })
    await new Promise<void>((resolve) => replacement.close(() => resolve()))
  })
})
