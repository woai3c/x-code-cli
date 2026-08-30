import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { errorMessage } from '../utils.js'
import { NdjsonFrameDecoder, encodePeerFrame } from './protocol.js'
import type { PeerFrameV1 } from './protocol.js'
import { stripTerminalControls } from './terminal-sanitize.js'
import type { PeerTransport, PeerTransportServer } from './transport.js'
import { type WindowsPeerBrokerArtifact, resolveWindowsPeerBrokerArtifact } from './windows-peer-broker-artifact.js'
import { type WindowsPeerBrokerProcess, spawnWindowsPeerBrokerProcess } from './windows-peer-broker-process.js'
import {
  WINDOWS_PEER_BROKER_MAX_OPERATIONS,
  type WindowsPeerBrokerFrame,
  WindowsPeerBrokerFrameKind,
  decodeInboundRequestPayload,
  decodeOneStringPayload,
  decodeOperationErrorPayload,
  decodePeerFramePayload,
  encodeOutboundRequestPayload,
  encodePeerFramePayload,
  encodeStartServerPayload,
} from './windows-peer-broker-protocol.js'
import { isValidWindowsPeerPipeAddress } from './windows-pipe-address.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 3_000
const STARTUP_TIMEOUT_MS = 5_000
const INBOUND_CALLBACK_TIMEOUT_MS = 29_000
const CAPACITY_RETRY_DELAY_MS = 10
const CANCELED_OPERATION_TTL_MS = 125_000
const MAX_CANCELED_OPERATIONS = WINDOWS_PEER_BROKER_MAX_OPERATIONS * 4
const SHUTDOWN_OPERATION_ID = 0xffff_ffff

interface RuntimePaths {
  namespaceId?: string
}

export interface WindowsNamedPipeTransportOptions {
  getRuntimePaths: () => RuntimePaths
  artifact?: WindowsPeerBrokerArtifact | Promise<WindowsPeerBrokerArtifact>
  spawnBroker?: typeof spawn
  requestTimeoutMs?: number
}

interface PendingOperation {
  resolve: (frame: PeerFrameV1) => void
  reject: (error: unknown) => void
  timer: NodeJS.Timeout
  signal?: AbortSignal
  onAbort?: () => void
}

interface StartupOperation {
  operationId: number
  resolve: (address: string) => void
  reject: (error: unknown) => void
}

function transportError(code: string, message: string, cause?: unknown): Error {
  const error = new Error(stripTerminalControls(message), cause === undefined ? undefined : { cause })
  error.name = code
  return error
}

function abortError(): Error {
  return Object.assign(new Error('Peer request was interrupted'), { name: 'AbortError' })
}

function parseBusinessFrame(bytes: Buffer): PeerFrameV1 {
  const decoder = new NdjsonFrameDecoder()
  const frames = decoder.push(bytes)
  decoder.finish()
  if (frames.length !== 1) {
    throw transportError('PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH', 'Windows peer broker returned multiple peer frames')
  }
  return frames[0]!
}

class BrokerClient {
  readonly closed: Promise<{ expected: boolean; reason?: string }>
  private readonly brokerProcess: WindowsPeerBrokerProcess
  private readonly pending = new Map<number, PendingOperation>()
  private readonly canceled = new Map<number, number>()
  private readonly inbound = new Set<number>()
  private readonly onRequest: (frame: PeerFrameV1, senderInstanceId: string) => Promise<PeerFrameV1>
  private readonly requestTimeoutMs: number
  private readonly resolveClosed: (result: { expected: boolean; reason?: string }) => void
  private nextOperationId = 1
  private startup?: StartupOperation
  private expectedClose = false
  private exited = false
  private fatalReason?: string
  private resolveShutdown?: () => void
  private closePromise?: Promise<void>

  constructor(
    artifact: WindowsPeerBrokerArtifact,
    options: {
      spawnBroker: typeof spawn
      onRequest: (frame: PeerFrameV1, senderInstanceId: string) => Promise<PeerFrameV1>
      requestTimeoutMs: number
    },
  ) {
    this.onRequest = options.onRequest
    this.requestTimeoutMs = options.requestTimeoutMs
    let resolveClosed!: (result: { expected: boolean; reason?: string }) => void
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve
    })
    this.resolveClosed = resolveClosed
    this.brokerProcess = spawnWindowsPeerBrokerProcess({
      artifact,
      mode: 'broker',
      spawnBroker: options.spawnBroker,
      debugKey: 'peer.windows.broker-stderr',
      onFrame: (frame) => this.handleFrame(frame),
      onError: (error) => this.fail(error),
      onClose: () => this.onExit(),
    })
  }

  async startServer(input: { namespaceId: string; instanceId: string; inboxToken: string }): Promise<string> {
    if (this.startup) {
      throw transportError('PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH', 'Windows peer broker server is already starting')
    }
    const operationId = this.allocateOperationId()
    return new Promise<string>((resolve, reject) => {
      this.startup = { operationId, resolve, reject }
      void this.send({
        kind: WindowsPeerBrokerFrameKind.StartServer,
        operationId,
        payload: encodeStartServerPayload(input),
      }).catch((error) => {
        if (this.startup?.operationId === operationId) this.startup = undefined
        reject(error)
      })
    })
  }

  request(options: {
    address: string
    targetToken: string
    senderInstanceId: string
    frame: PeerFrameV1
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<PeerFrameV1> {
    if (options.signal?.aborted) return Promise.reject(abortError())
    const timeoutMs = Math.min(120_000, Math.max(1, options.timeoutMs ?? this.requestTimeoutMs))
    return this.requestWithCapacityRetry(options, timeoutMs)
  }

  private async requestWithCapacityRetry(
    options: {
      address: string
      targetToken: string
      senderInstanceId: string
      frame: PeerFrameV1
      signal?: AbortSignal
    },
    timeoutMs: number,
  ): Promise<PeerFrameV1> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        throw transportError('PEER_WINDOWS_REQUEST_TIMEOUT', 'Windows peer request timed out')
      }
      try {
        return await this.requestOnce(options, remainingMs)
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'PEER_WINDOWS_OPERATION_CAPACITY') throw error
        if (options.signal?.aborted) throw abortError()
        const retryDelayMs = Math.min(CAPACITY_RETRY_DELAY_MS, deadline - Date.now())
        if (retryDelayMs <= 0) throw error
        try {
          await delay(retryDelayMs, undefined, { signal: options.signal, ref: false })
        } catch (delayError) {
          if (options.signal?.aborted) throw abortError()
          throw delayError
        }
      }
    }
  }

  private requestOnce(
    options: {
      address: string
      targetToken: string
      senderInstanceId: string
      frame: PeerFrameV1
      signal?: AbortSignal
    },
    timeoutMs: number,
  ): Promise<PeerFrameV1> {
    let payload: Buffer
    try {
      payload = encodeOutboundRequestPayload({
        address: options.address,
        targetToken: options.targetToken,
        senderInstanceId: options.senderInstanceId,
        timeoutMs,
        peerFrame: encodePeerFrame(options.frame),
      })
    } catch (error) {
      return Promise.reject(error)
    }
    if (this.pending.size >= WINDOWS_PEER_BROKER_MAX_OPERATIONS) {
      return Promise.reject(
        transportError('PEER_WINDOWS_OPERATION_CAPACITY', 'Windows peer broker operation capacity is exhausted'),
      )
    }
    const operationId = this.allocateOperationId()
    return new Promise<PeerFrameV1>((resolve, reject) => {
      const onAbort = () => this.cancelOperation(operationId, abortError())
      const timer = setTimeout(
        () =>
          this.cancelOperation(
            operationId,
            transportError('PEER_WINDOWS_REQUEST_TIMEOUT', 'Windows peer request timed out'),
          ),
        timeoutMs,
      )
      timer.unref()
      this.pending.set(operationId, {
        resolve,
        reject,
        timer,
        signal: options.signal,
        onAbort,
      })
      options.signal?.addEventListener('abort', onAbort, { once: true })
      void this.send({
        kind: WindowsPeerBrokerFrameKind.OutboundRequest,
        operationId,
        payload,
      }).catch((error) => this.finishPending(operationId, error))
    })
  }

  close(deadlineMs: number): Promise<void> {
    this.closePromise ??= this.closeOnce(deadlineMs)
    return this.closePromise
  }

  private async closeOnce(deadlineMs: number): Promise<void> {
    this.expectedClose = true
    if (this.exited) return
    const shutdown = new Promise<void>((resolve) => {
      this.resolveShutdown = resolve
    })
    await this.send({
      kind: WindowsPeerBrokerFrameKind.Shutdown,
      operationId: SHUTDOWN_OPERATION_ID,
      payload: Buffer.alloc(0),
    }).catch(() => {})
    let timer: NodeJS.Timeout | undefined
    const acknowledged = await Promise.race([
      shutdown.then(() => true),
      this.closed.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, deadlineMs))
        timer.unref()
      }),
    ])
    if (timer) clearTimeout(timer)
    if (acknowledged) await this.waitForExit(250)
    if (!this.exited) this.brokerProcess.kill()
    await this.waitForExit(250)
  }

  private async waitForExit(deadlineMs: number): Promise<boolean> {
    if (this.exited) return true
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        this.closed.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, deadlineMs))
          timer.unref()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private allocateOperationId(): number {
    if (this.nextOperationId >= SHUTDOWN_OPERATION_ID) {
      const failure = transportError(
        'PEER_WINDOWS_OPERATION_CAPACITY',
        'Windows peer broker operation IDs are exhausted',
      )
      this.fail(failure)
      throw failure
    }
    return this.nextOperationId++
  }

  private handleFrame(frame: WindowsPeerBrokerFrame): void {
    switch (frame.kind) {
      case WindowsPeerBrokerFrameKind.ServerReady:
        this.handleServerReady(frame)
        return
      case WindowsPeerBrokerFrameKind.InboundRequest:
        this.handleInbound(frame)
        return
      case WindowsPeerBrokerFrameKind.OutboundResponse:
        this.handleTerminal(frame, undefined)
        return
      case WindowsPeerBrokerFrameKind.OperationError:
        this.handleOperationError(frame)
        return
      case WindowsPeerBrokerFrameKind.ServerFatal: {
        if (frame.operationId !== 0) throw this.protocolViolation('SERVER_FATAL operation ID must be zero')
        const failure = decodeOperationErrorPayload(frame.payload)
        this.fatalReason = failure.message
        this.fail(transportError(failure.code, failure.message))
        return
      }
      case WindowsPeerBrokerFrameKind.ShutdownComplete:
        if (frame.operationId !== 0 || frame.payload.length !== 0) {
          throw this.protocolViolation('SHUTDOWN_COMPLETE frame is invalid')
        }
        if (!this.resolveShutdown) throw this.protocolViolation('Unexpected SHUTDOWN_COMPLETE frame')
        this.resolveShutdown()
        this.resolveShutdown = undefined
        return
      default:
        throw this.protocolViolation('Unexpected broker-to-Node frame kind')
    }
  }

  private handleServerReady(frame: WindowsPeerBrokerFrame): void {
    if (frame.operationId !== 0 || !this.startup) throw this.protocolViolation('Unexpected SERVER_READY frame')
    const address = decodeOneStringPayload(frame.payload)
    const startup = this.startup
    this.startup = undefined
    startup.resolve(address)
  }

  private handleInbound(frame: WindowsPeerBrokerFrame): void {
    if (frame.operationId === 0 || this.inbound.has(frame.operationId) || this.inbound.size >= 256) {
      throw this.protocolViolation('Invalid inbound operation ID')
    }
    const request = decodeInboundRequestPayload(frame.payload)
    this.inbound.add(frame.operationId)
    void (async () => {
      let response: PeerFrameV1
      let callbackTimer: NodeJS.Timeout | undefined
      try {
        response = await Promise.race([
          this.onRequest(parseBusinessFrame(request.peerFrame), request.senderInstanceId),
          new Promise<PeerFrameV1>((resolve) => {
            callbackTimer = setTimeout(
              () =>
                resolve({
                  v: 1,
                  type: 'error',
                  code: 'PEER_REQUEST_TIMEOUT',
                  message: 'Peer request processing timed out',
                }),
              INBOUND_CALLBACK_TIMEOUT_MS,
            )
            callbackTimer.unref()
          }),
        ])
      } catch (error) {
        response = {
          v: 1,
          type: 'error',
          code: 'PEER_PROTOCOL_ERROR',
          message: stripTerminalControls(errorMessage(error)),
        }
      } finally {
        if (callbackTimer) clearTimeout(callbackTimer)
      }
      try {
        await this.send({
          kind: WindowsPeerBrokerFrameKind.InboundResponse,
          operationId: frame.operationId,
          payload: encodePeerFramePayload(encodePeerFrame(response)),
        })
      } catch (error) {
        this.fail(error)
      } finally {
        this.inbound.delete(frame.operationId)
      }
    })()
  }

  private handleOperationError(frame: WindowsPeerBrokerFrame): void {
    if (frame.operationId === 0) throw this.protocolViolation('OPERATION_ERROR operation ID must be nonzero')
    const failure = decodeOperationErrorPayload(frame.payload)
    if (this.startup?.operationId === frame.operationId) {
      const startup = this.startup
      this.startup = undefined
      startup.reject(transportError(failure.code, failure.message))
      return
    }
    this.handleTerminal(frame, transportError(failure.code, failure.message))
  }

  private handleTerminal(frame: WindowsPeerBrokerFrame, failure: Error | undefined): void {
    const pending = this.pending.get(frame.operationId)
    if (!pending) {
      if (this.consumeCanceled(frame.operationId)) return
      throw this.protocolViolation('Unexpected terminal operation ID')
    }
    let response: PeerFrameV1 | undefined
    if (!failure && frame.kind === WindowsPeerBrokerFrameKind.OutboundResponse) {
      response = parseBusinessFrame(decodePeerFramePayload(frame.payload))
    }
    this.pending.delete(frame.operationId)
    this.disposePending(pending)
    if (failure) pending.reject(failure)
    else pending.resolve(response!)
  }

  private cancelOperation(operationId: number, reason: Error): void {
    const pending = this.pending.get(operationId)
    if (!pending) return
    this.pending.delete(operationId)
    this.rememberCanceled(operationId)
    this.disposePending(pending)
    pending.reject(reason)
    void this.send({
      kind: WindowsPeerBrokerFrameKind.CancelOperation,
      operationId,
      payload: Buffer.alloc(0),
    }).catch((error) => this.fail(error))
  }

  private finishPending(operationId: number, error: unknown): void {
    const pending = this.pending.get(operationId)
    if (!pending) return
    this.pending.delete(operationId)
    this.disposePending(pending)
    pending.reject(error)
  }

  private disposePending(pending: PendingOperation): void {
    clearTimeout(pending.timer)
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort)
  }

  private rememberCanceled(operationId: number): void {
    const now = Date.now()
    for (const [candidate, expiresAt] of this.canceled) {
      if (expiresAt > now) continue
      this.canceled.delete(candidate)
    }
    if (this.canceled.size >= MAX_CANCELED_OPERATIONS) {
      this.fail(
        transportError('PEER_WINDOWS_OPERATION_CAPACITY', 'Windows peer broker cancellation tracking is exhausted'),
      )
      return
    }
    this.canceled.set(operationId, now + CANCELED_OPERATION_TTL_MS)
  }

  private consumeCanceled(operationId: number): boolean {
    const expiresAt = this.canceled.get(operationId)
    if (expiresAt === undefined) return false
    this.canceled.delete(operationId)
    return expiresAt > Date.now()
  }

  private send(frame: WindowsPeerBrokerFrame): Promise<void> {
    if (this.exited) {
      return Promise.reject(
        transportError('PEER_WINDOWS_BROKER_EXITED', this.fatalReason ?? 'Windows peer broker exited unexpectedly'),
      )
    }
    return this.brokerProcess.send(frame)
  }

  private fail(error: unknown): void {
    if (this.exited) return
    this.fatalReason = stripTerminalControls(errorMessage(error))
    this.brokerProcess.kill()
  }

  private onExit(): void {
    if (this.exited) return
    this.exited = true
    const failure = transportError(
      'PEER_WINDOWS_BROKER_EXITED',
      this.fatalReason ?? 'Windows peer broker exited unexpectedly',
    )
    this.startup?.reject(failure)
    this.startup = undefined
    for (const pending of this.pending.values()) {
      this.disposePending(pending)
      pending.reject(failure)
    }
    this.pending.clear()
    this.canceled.clear()
    this.inbound.clear()
    this.resolveShutdown?.()
    this.resolveClosed({
      expected: this.expectedClose,
      ...(this.expectedClose ? {} : { reason: failure.message }),
    })
  }

  private protocolViolation(message: string): Error {
    return transportError('PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH', message)
  }
}

export function createWindowsNamedPipeTransport(options: WindowsNamedPipeTransportOptions): PeerTransport {
  let client: BrokerClient | undefined
  let server: PeerTransportServer | undefined
  const namespaceId = (): string => {
    const value = options.getRuntimePaths().namespaceId
    if (!value || !/^[a-f0-9]{12}$/.test(value))
      throw transportError('PEER_RUNTIME_NOT_INITIALIZED', 'Peer runtime is not initialized')
    return value
  }
  return {
    kind: 'windows-pipe',
    validateAddress: (address) => isValidWindowsPeerPipeAddress(address, options.getRuntimePaths().namespaceId),

    async listen(listenOptions) {
      if (server) throw transportError('PEER_WINDOWS_PIPE_CREATE_FAILED', 'Windows peer broker is already listening')
      const expectedNamespace = namespaceId()
      if (listenOptions.signal?.aborted) throw abortError()
      const artifact = await (options.artifact ?? resolveWindowsPeerBrokerArtifact())
      if (listenOptions.signal?.aborted) throw abortError()
      const broker = new BrokerClient(artifact, {
        spawnBroker: options.spawnBroker ?? spawn,
        onRequest: listenOptions.onRequest,
        requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      })
      client = broker
      const onAbort = () => void broker.close(0)
      listenOptions.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        let startupTimer: NodeJS.Timeout | undefined
        const address = await Promise.race([
          broker.startServer({
            namespaceId: expectedNamespace,
            instanceId: listenOptions.instanceId,
            inboxToken: listenOptions.inboxToken,
          }),
          new Promise<string>((_, reject) => {
            startupTimer = setTimeout(
              () => reject(transportError('PEER_WINDOWS_PIPE_CREATE_FAILED', 'Windows peer broker startup timed out')),
              STARTUP_TIMEOUT_MS,
            )
            startupTimer.unref()
          }),
        ]).finally(() => {
          if (startupTimer) clearTimeout(startupTimer)
        })
        if (!isValidWindowsPeerPipeAddress(address, expectedNamespace)) {
          throw transportError(
            'PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH',
            'Windows peer broker returned an invalid pipe address',
          )
        }
        const created: PeerTransportServer = {
          address,
          closed: broker.closed,
          async close(closeOptions = {}) {
            await broker.close(closeOptions.deadlineMs ?? 500)
          },
        }
        server = created
        return created
      } catch (error) {
        await broker.close(0).catch(() => {})
        throw error
      } finally {
        listenOptions.signal?.removeEventListener('abort', onAbort)
      }
    },

    async request(requestOptions) {
      if (!client || !server) {
        throw transportError('PEER_WINDOWS_BROKER_EXITED', 'Windows peer broker is not running')
      }
      if (!isValidWindowsPeerPipeAddress(requestOptions.address, namespaceId())) {
        throw transportError('PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH', 'Windows peer pipe address is invalid')
      }
      return client.request(requestOptions)
    },
  }
}
