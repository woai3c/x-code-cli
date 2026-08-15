import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

import { errorMessage } from '../utils.js'
import { NdjsonFrameDecoder, type PeerFrameV1, encodePeerFrame } from './protocol.js'
import type { PeerTransport, PeerTransportServer } from './transport.js'

const DEFAULT_TIMEOUT_MS = 3_000

function tokenMatches(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function abortError(): Error {
  return Object.assign(new Error('PEER_ABORTED'), { name: 'AbortError' })
}

function errorFrame(code: string, message: string, requestId?: string): PeerFrameV1 {
  return { v: 1, type: 'error', code, message, ...(requestId ? { requestId } : {}) }
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

interface UnixSocketFileSystem {
  chmod(filePath: string, mode: number): Promise<void>
  lstat(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>>>
  mkdir(filePath: string, options: { mode: number }): Promise<unknown>
  rename(oldPath: string, newPath: string): Promise<void>
  rmdir(filePath: string): Promise<void>
  unlink(filePath: string): Promise<void>
}

async function lstatIfPresent(
  fileSystem: UnixSocketFileSystem,
  filePath: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fileSystem.lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeFrame(socket: net.Socket, frame: PeerFrameV1, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError()
  const bytes = encodePeerFrame(frame)
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(abortError())
    signal?.addEventListener('abort', abort, { once: true })
    socket.write(bytes, (error) => {
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve()
    })
  })
}

async function probeListener(options: {
  address: string
  inboxToken: string
  senderInstanceId: string
  receiverInstanceId: string
  signal?: AbortSignal
}): Promise<void> {
  const requestId = randomUUID()
  const socket = net.createConnection(options.address)
  const decoder = new NdjsonFrameDecoder()
  let phase: 'auth' | 'ping' = 'auth'
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => settle(new Error('PEER_SOCKET_OWNERSHIP_UNVERIFIED')), 500)
    timer.unref()
    const onAbort = () => settle(abortError())
    options.signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('connect', () => {
      void writeFrame(
        socket,
        {
          v: 1,
          type: 'auth',
          targetToken: options.inboxToken,
          senderInstanceId: options.senderInstanceId,
        },
        options.signal,
      ).catch(settle)
    })
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) {
          if (phase === 'auth') {
            if (frame.type !== 'auth-ok') return settle(new Error('PEER_SOCKET_OWNERSHIP_UNVERIFIED'))
            phase = 'ping'
            void writeFrame(socket, { v: 1, type: 'ping', requestId }, options.signal).catch(settle)
            continue
          }
          if (
            frame.type !== 'pong' ||
            frame.requestId !== requestId ||
            frame.instanceId !== options.receiverInstanceId
          ) {
            return settle(new Error('PEER_SOCKET_OWNERSHIP_UNVERIFIED'))
          }
          settle()
          return
        }
      } catch (error) {
        settle(error)
      }
    })
    socket.once('error', settle)
    socket.once('end', () => settle(new Error('PEER_SOCKET_OWNERSHIP_UNVERIFIED')))
  })
}

export function createUnixSocketTransport(dependencies: { fileSystem?: UnixSocketFileSystem } = {}): PeerTransport {
  const fileSystem = dependencies.fileSystem ?? fs
  if (process.platform === 'win32') {
    return {
      async listen() {
        throw new Error('PEER_UNSUPPORTED_PLATFORM')
      },
      async request() {
        throw new Error('PEER_UNSUPPORTED_PLATFORM')
      },
    }
  }

  return {
    async listen(options): Promise<PeerTransportServer> {
      const address = path.join(path.dirname(options.address), `p-${randomBytes(12).toString('base64url')}.sock`)
      if (Buffer.byteLength(address, 'utf8') > 103) throw new Error('PEER_SOCKET_PATH_TOO_LONG')
      const ownershipProbeSenderId = randomUUID()
      const sockets = new Set<net.Socket>()
      let ownedSocket: Awaited<ReturnType<typeof fs.lstat>> | null = null
      let closePromise: Promise<void> | null = null
      const server = net.createServer((socket) => {
        sockets.add(socket)
        const decoder = new NdjsonFrameDecoder()
        let authenticatedSender: string | undefined
        let handledRequest = false
        socket.setTimeout(DEFAULT_TIMEOUT_MS, () => socket.destroy(new Error('PEER_TIMEOUT')))
        socket.on('data', (chunk: Buffer) => {
          void (async () => {
            try {
              const frames = decoder.push(chunk)
              for (const frame of frames) {
                if (!authenticatedSender) {
                  if (
                    frame.type !== 'auth' ||
                    !tokenMatches(frame.targetToken, options.inboxToken) ||
                    frame.senderInstanceId === options.instanceId
                  ) {
                    await writeFrame(socket, errorFrame('PEER_AUTH_FAILED', 'Authentication failed'))
                    socket.end()
                    return
                  }
                  authenticatedSender = frame.senderInstanceId
                  await writeFrame(socket, { v: 1, type: 'auth-ok' })
                  continue
                }
                if (handledRequest || frame.type === 'auth' || frame.type === 'auth-ok') {
                  await writeFrame(socket, errorFrame('PEER_PROTOCOL_ERROR', 'Expected one request per connection'))
                  socket.end()
                  return
                }
                handledRequest = true
                const response =
                  authenticatedSender === ownershipProbeSenderId && frame.type === 'ping'
                    ? {
                        v: 1 as const,
                        type: 'pong' as const,
                        requestId: frame.requestId,
                        instanceId: options.instanceId,
                      }
                    : await options.onRequest(frame, authenticatedSender)
                await writeFrame(socket, response)
                socket.end()
              }
            } catch (error) {
              const message = errorMessage(error)
              if (!socket.destroyed) {
                await writeFrame(socket, errorFrame(message, 'Invalid peer frame')).catch(() => {})
                socket.end()
              }
            }
          })()
        })
        socket.once('close', () => sockets.delete(socket))
        socket.once('error', () => {})
      })

      const closeBoundServer = (deadlineMs = 500): Promise<void> => {
        if (closePromise) return closePromise
        closePromise = (async () => {
          const expectedOwnedSocket = ownedSocket
          const displaced: Array<{
            path: string
            identity: Awaited<ReturnType<typeof fs.lstat>> | null
          }> = []
          const moveCurrentAside = async (): Promise<void> => {
            const displacedPath = `${address}.closing-${randomUUID()}`
            try {
              await fileSystem.rename(address, displacedPath)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
              throw error
            }
            const entry: (typeof displaced)[number] = { path: displacedPath, identity: null }
            displaced.push(entry)
            entry.identity = await lstatIfPresent(fileSystem, displacedPath)
          }
          const installSentinel = async (): Promise<Awaited<ReturnType<typeof fs.lstat>>> => {
            for (let attempt = 0; attempt < 16; attempt++) {
              if (await lstatIfPresent(fileSystem, address)) await moveCurrentAside()
              try {
                await fileSystem.mkdir(address, { mode: 0o700 })
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
                throw error
              }
              const created = await lstatIfPresent(fileSystem, address)
              if (!created?.isDirectory() || created.isSymbolicLink()) continue
              const verified = await lstatIfPresent(fileSystem, address)
              if (verified?.isDirectory() && !verified.isSymbolicLink() && sameFileIdentity(created, verified)) {
                return verified
              }
            }
            throw new Error('PEER_SOCKET_CLOSE_GUARD_FAILED')
          }

          const sentinel = await installSentinel()
          await new Promise<void>((resolve) => {
            let finished = false
            const finish = () => {
              if (finished) return
              finished = true
              clearTimeout(deadline)
              resolve()
            }
            const deadline = setTimeout(() => {
              for (const socket of sockets) socket.destroy()
            }, deadlineMs)
            deadline.unref()
            try {
              server.close(finish)
            } catch {
              finish()
            }
          })
          for (const socket of sockets) socket.destroy()
          const currentSentinel = await lstatIfPresent(fileSystem, address)
          if (sentinel?.isDirectory() && currentSentinel && sameFileIdentity(sentinel, currentSentinel)) {
            await fileSystem.rmdir(address).catch(() => {})
          }
          for (const entry of displaced) {
            const current = await lstatIfPresent(fileSystem, entry.path)
            if (
              current &&
              entry.identity &&
              sameFileIdentity(current, entry.identity) &&
              expectedOwnedSocket &&
              sameFileIdentity(current, expectedOwnedSocket)
            ) {
              await fileSystem.unlink(entry.path).catch(() => {})
            }
          }
          for (const entry of [...displaced].reverse()) {
            if (await lstatIfPresent(fileSystem, address)) break
            const current = await lstatIfPresent(fileSystem, entry.path)
            if (
              !current ||
              !entry.identity ||
              !sameFileIdentity(current, entry.identity) ||
              (expectedOwnedSocket && sameFileIdentity(current, expectedOwnedSocket))
            ) {
              continue
            }
            await fileSystem.rename(entry.path, address).catch(() => {})
          }
        })()
        return closePromise
      }

      try {
        if (options.signal?.aborted) throw abortError()
        await new Promise<void>((resolve, reject) => {
          let settled = false
          const settle = (error?: unknown) => {
            if (settled) return
            settled = true
            options.signal?.removeEventListener('abort', onAbort)
            server.off('error', onError)
            if (error) reject(error)
            else resolve()
          }
          const onAbort = () => {
            settle(abortError())
            void closeBoundServer(0)
          }
          const onError = (error: Error) => settle(error)
          options.signal?.addEventListener('abort', onAbort, { once: true })
          server.once('error', onError)
          try {
            server.listen({ path: address, signal: options.signal }, () => settle())
          } catch (error) {
            settle(error)
          }
        })
        if (options.signal?.aborted) throw abortError()
        const stat = await fileSystem.lstat(address)
        if (!stat.isSocket() || stat.isSymbolicLink()) throw new Error('PEER_SOCKET_UNSAFE')
        if (options.signal?.aborted) throw abortError()
        await probeListener({
          address,
          inboxToken: options.inboxToken,
          senderInstanceId: ownershipProbeSenderId,
          receiverInstanceId: options.instanceId,
          signal: options.signal,
        })
        if (options.signal?.aborted) throw abortError()
        const probedSocket = await fileSystem.lstat(address)
        if (!probedSocket.isSocket() || probedSocket.isSymbolicLink() || !sameFileIdentity(stat, probedSocket)) {
          throw new Error('PEER_SOCKET_UNSAFE')
        }
        ownedSocket = probedSocket
        if (options.signal?.aborted) throw abortError()
        await fileSystem.chmod(address, 0o600)
        if (options.signal?.aborted) throw abortError()
        const securedSocket = await fileSystem.lstat(address)
        if (
          !securedSocket.isSocket() ||
          securedSocket.isSymbolicLink() ||
          !sameFileIdentity(probedSocket, securedSocket)
        ) {
          throw new Error('PEER_SOCKET_UNSAFE')
        }
        ownedSocket = securedSocket
        if (options.signal?.aborted) throw abortError()
      } catch (error) {
        await closeBoundServer(0)
        if (options.signal?.aborted) throw abortError()
        throw error
      }

      return {
        address,
        async close(closeOptions = {}) {
          await closeBoundServer(closeOptions.deadlineMs ?? 500)
        },
      }
    },

    async request(options): Promise<PeerFrameV1> {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      if (options.signal?.aborted) throw abortError()
      const socket = net.createConnection(options.address)
      const decoder = new NdjsonFrameDecoder()
      let phase: 'auth' | 'request' = 'auth'
      return new Promise<PeerFrameV1>((resolve, reject) => {
        let settled = false
        const settle = (error?: unknown, frame?: PeerFrameV1) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
          socket.destroy()
          if (error) reject(error)
          else resolve(frame!)
        }
        const timer = setTimeout(() => settle(new Error('PEER_TIMEOUT')), timeoutMs)
        timer.unref()
        const onAbort = () => settle(abortError())
        options.signal?.addEventListener('abort', onAbort, { once: true })
        socket.once('connect', () => {
          void writeFrame(socket, {
            v: 1,
            type: 'auth',
            targetToken: options.targetToken,
            senderInstanceId: options.senderInstanceId,
          }).catch(settle)
        })
        socket.on('data', (chunk: Buffer) => {
          try {
            for (const frame of decoder.push(chunk)) {
              if (phase === 'auth') {
                if (frame.type !== 'auth-ok') {
                  settle(new Error(frame.type === 'error' ? frame.code : 'PEER_PROTOCOL_ERROR'))
                  return
                }
                phase = 'request'
                void writeFrame(socket, options.frame, options.signal).catch(settle)
              } else {
                settle(undefined, frame)
                return
              }
            }
          } catch (error) {
            settle(error)
          }
        })
        socket.once('error', settle)
        socket.once('end', () => {
          if (!settled) settle(new Error('PEER_CONNECTION_CLOSED'))
        })
      })
    },
  }
}
