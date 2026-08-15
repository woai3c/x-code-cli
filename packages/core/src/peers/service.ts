import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

import { type PeerMessagingConfig, resolvePeerMessagingConfig } from '../config/index.js'
import { sha256Text } from '../permissions/authority.js'
import type { PublicPeer } from '../types/index.js'
import { debugLog, errorMessage } from '../utils.js'
import { createPeerIdentity, isUuid, normalizePeerName } from './identity.js'
import { decideInboundDisposition } from './inbound-policy.js'
import type {
  AcceptedClaim,
  DeliveryUpdateClaim,
  HeldDecisionResult,
  HeldPeerMessage,
  InboxClaimResult,
  InboxLifecycleResult,
  PeerInbox,
  PeerInboxOptions,
  PeerInboxSnapshot,
} from './inbox-types.js'
import { createPeerInbox } from './inbox.js'
import { peerSocketPath } from './paths.js'
import { MAX_MESSAGE_BYTES, encodePeerFrame } from './protocol.js'
import type { PeerFrameV1 } from './protocol.js'
import { type PeerRateLimiter, createPeerRateLimiter } from './rate-limit.js'
import { type PeerRegistry, createPeerRegistry } from './registry.js'
import { stripTerminalControls } from './terminal-sanitize.js'
import type { PeerTransport, PeerTransportServer } from './transport.js'
import type { PeerIdentity, PeerRegistrationV1, RegistrationCandidate } from './types.js'
import { createUnixSocketTransport } from './unix-socket-transport.js'

export interface PreparedPeerSend {
  requestedTarget: string
  receiverInstanceId: string
  receiverAddress: `peer:${string}`
  message: string
  summary?: string
  messageId?: string
  payloadHash: string
  candidate: RegistrationCandidate
}

export type SendMessageResult =
  | { success: true; status: 'delivered' | 'held'; messageId: string; heldUntil?: string }
  | { success: false; code: string; reason: string; messageId?: string }

export interface SendPeerMessageInput {
  to: string
  message: string
  summary?: string
  messageId?: string
}

export interface PeerServiceOptions {
  enabled?: boolean
  config?: unknown
  name?: string
  cwd?: string
  sessionId?: string
  permissionClass?: 'prompted' | 'bypass'
  getPermissionClass?: () => 'prompted' | 'bypass'
  registry?: PeerRegistry
  transport?: PeerTransport
  identity?: PeerIdentity
  inboxOptions?: PeerInboxOptions
  rateLimiter?: PeerRateLimiter
  now?: () => Date
}

export interface PeerService {
  readonly enabled: boolean
  readonly identity: PeerIdentity | null
  readonly inbox: PeerInbox
  readonly unavailableReason?: string
  isAvailable(): boolean
  getUnavailableReason(): string | undefined
  start(signal?: AbortSignal): Promise<void>
  shutdown(): Promise<void>
  list(signal?: AbortSignal): Promise<{ peers: PublicPeer[]; partial: boolean }>
  listAgents(signal?: AbortSignal): Promise<PublicPeer[]>
  prepareSend(
    to: string,
    message: string,
    summary?: string,
    messageId?: string,
    signal?: AbortSignal,
  ): Promise<PreparedPeerSend>
  sendPrepared(prepared: PreparedPeerSend, signal?: AbortSignal): Promise<SendMessageResult>
  sendMessage(
    to: string,
    message: string,
    summary?: string,
    messageId?: string,
    signal?: AbortSignal,
  ): Promise<SendMessageResult>
  send(input: SendPeerMessageInput, signal?: AbortSignal): Promise<SendMessageResult>
  updateLocalState(patch: {
    name?: string
    sessionId?: string
    status?: 'idle' | 'busy' | 'waiting'
    busyKind?: 'interactive-turn' | 'goal' | 'maintenance'
    permissionClass?: 'prompted' | 'bypass'
  }): Promise<void>
  onInboxChanged(listener: (snapshot: PeerInboxSnapshot) => void): () => void
  claimAccepted(limit: number): AcceptedClaim | null
  commitAcceptedClaim(claimId: string): InboxClaimResult
  releaseAcceptedClaim(claimId: string): InboxClaimResult
  markAgentInputsInjected(keys: readonly string[]): InboxLifecycleResult
  markAgentInputsDropped(keys: readonly string[], reason: string): InboxLifecycleResult
  listHeld(): readonly HeldPeerMessage[]
  decideHeld(key: string, decision: 'accept' | 'reject'): Promise<HeldDecisionResult>
  claimDeliveryUpdates(limit: number): DeliveryUpdateClaim | null
  commitDeliveryUpdateClaim(claimId: string): InboxClaimResult
  releaseDeliveryUpdateClaim(claimId: string): InboxClaimResult
}

function serviceError(code: string, message: string): Error {
  const error = new Error(message)
  error.name = code
  return error
}

function outboundMessageFrame(input: {
  requestId: string
  messageId: string
  senderInstanceId: string
  message: string
  summary?: string
  sentAt: string
  senderPermissionClass: 'prompted' | 'bypass'
}): Extract<PeerFrameV1, { type: 'message' }> {
  return {
    v: 1,
    type: 'message',
    requestId: input.requestId,
    messageId: input.messageId,
    senderInstanceId: input.senderInstanceId,
    text: input.message,
    ...(input.summary ? { summary: input.summary } : {}),
    sentAt: input.sentAt,
    senderPermissionClass: input.senderPermissionClass,
  }
}

function assertOutboundMessageFrameFits(frame: Extract<PeerFrameV1, { type: 'message' }>): void {
  try {
    encodePeerFrame(frame)
  } catch (error) {
    const message = errorMessage(error)
    if (message === 'PEER_FRAME_TOO_LARGE' || message.startsWith('Invalid peer ')) {
      throw serviceError('PEER_MESSAGE_TOO_LARGE', 'Message cannot fit in a complete peer protocol frame')
    }
    throw error
  }
}

function sanitizePublicPeer(peer: PublicPeer): PublicPeer {
  return {
    ...peer,
    name: stripTerminalControls(peer.name),
    cwd: stripTerminalControls(peer.cwd),
  }
}

function publicPeer(registration: PeerRegistrationV1): PublicPeer {
  return sanitizePublicPeer({
    name: registration.name,
    address: `peer:${registration.instanceId}`,
    cwd: registration.cwd,
    status: registration.status,
    ...(registration.busyKind ? { busyKind: registration.busyKind } : {}),
    startedAt: registration.startedAt,
    ...(registration.sessionId ? { sessionId: registration.sessionId } : {}),
  })
}

function sendPayloadHash(message: string, summary?: string): string {
  return sha256Text(JSON.stringify({ message, ...(summary ? { summary } : {}) }))
}

async function lstatIfPresent(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function createPeerService(options: PeerServiceOptions = {}): PeerService {
  const config: PeerMessagingConfig = resolvePeerMessagingConfig(options.config)
  const enabled = options.enabled ?? false
  const registry = options.registry ?? createPeerRegistry()
  const transport = options.transport ?? createUnixSocketTransport()
  const identity = enabled
    ? (options.identity ?? createPeerIdentity({ name: options.name, cwd: options.cwd, now: options.now }))
    : null
  const inbox = createPeerInbox(options.inboxOptions)
  const rateLimiter = options.rateLimiter ?? createPeerRateLimiter()
  const now = options.now ?? (() => new Date())
  let server: PeerTransportServer | undefined
  let started = false
  let shuttingDown = false
  let lifecycleGeneration = 0
  let startPromise: Promise<void> | null = null
  let shutdownPromise: Promise<void> | null = null
  let registration: PeerRegistrationV1 | undefined
  let heartbeat: NodeJS.Timeout | undefined
  let inboundInFlight = 0
  let registrationWriteGeneration = 0
  let registrationWritesEnabled = false
  let registrationWriteTail: Promise<void> = Promise.resolve()
  let unavailableReason: string | undefined = enabled ? undefined : 'This session is not registered as a named agent.'
  let unavailableCode = enabled ? 'PEER_UNAVAILABLE' : 'PEER_DISABLED'

  const writeRegistration = (): Promise<void> => {
    const generation = registrationWriteGeneration
    const operation = registrationWriteTail
      .catch(() => {})
      .then(async () => {
        if (!registration || !registrationWritesEnabled || generation !== registrationWriteGeneration) return
        registration.updatedAt = now().toISOString()
        await registry.write(structuredClone(registration))
      })
    registrationWriteTail = operation
    return operation
  }

  const takeServer = (): PeerTransportServer | undefined => {
    const current = server
    server = undefined
    return current
  }

  const validateSender = async (senderInstanceId: string): Promise<RegistrationCandidate> => {
    if (!identity || senderInstanceId === identity.instanceId)
      throw serviceError('PEER_SELF', 'Self-send is not allowed')
    const sender = await registry.read(senderInstanceId)
    if (!sender) throw serviceError('PEER_AUTH_FAILED', 'Sender registration is missing or unsafe')
    return sender
  }

  const processMessage = async (
    frame: Extract<PeerFrameV1, { type: 'message' }>,
    sender: RegistrationCandidate,
  ): Promise<PeerFrameV1> => {
    if (frame.senderInstanceId !== sender.registration.instanceId) {
      return { v: 1, type: 'error', requestId: frame.requestId, code: 'PEER_AUTH_FAILED', message: 'Sender mismatch' }
    }
    const text = stripTerminalControls(frame.text)
    const summary = frame.summary === undefined ? undefined : stripTerminalControls(frame.summary)
    if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES || (summary !== undefined && summary.length > 200)) {
      return {
        v: 1,
        type: 'error',
        requestId: frame.requestId,
        code: 'PEER_MESSAGE_TOO_LARGE',
        message: 'Peer message exceeds the sanitized payload limit',
      }
    }
    const existingKey = `${sender.registration.instanceId}:${frame.messageId}`
    const existing = inbox.getInboundRecord(existingKey)
    const senderPermissionClass =
      frame.senderPermissionClass === 'bypass' || sender.registration.permissionClass === 'bypass'
        ? 'bypass'
        : 'prompted'
    const disposition =
      !existing && !rateLimiter.admit(sender.registration.instanceId)
        ? ({ kind: 'refuse', reason: 'rate-limit' } as const)
        : decideInboundDisposition({
            policy: config.inbound,
            receiverPermissionClass: registration?.permissionClass ?? 'bypass',
            senderPermissionClass,
            dialogExpiryMs: config.dialogExpiryMs,
            now: now().getTime(),
          })
    const from = publicPeer(sender.registration)
    const admitted = inbox.admitInbound(
      {
        id: frame.messageId,
        from,
        text,
        ...(summary ? { summary } : {}),
        sentAt: frame.sentAt,
        receivedAt: now().toISOString(),
        senderPermissionClass,
      },
      sendPayloadHash(text, summary),
      disposition,
    )
    if (admitted.status === 'accepted') {
      return { v: 1, type: 'ack', requestId: frame.requestId, messageId: frame.messageId, status: 'delivered' }
    }
    if (admitted.status === 'held') {
      return {
        v: 1,
        type: 'ack',
        requestId: frame.requestId,
        messageId: frame.messageId,
        status: 'held',
        heldUntil: admitted.heldUntil,
      }
    }
    if (admitted.status === 'duplicate') {
      const heldUntil =
        admitted.duplicateOfStatus === 'held'
          ? inbox.listHeld().find((entry) => entry.key === admitted.key)?.expiresAt
          : undefined
      return {
        v: 1,
        type: 'ack',
        requestId: frame.requestId,
        messageId: frame.messageId,
        status: 'duplicate',
        duplicateOfStatus: admitted.duplicateOfStatus,
        ...(heldUntil ? { heldUntil } : {}),
      }
    }
    if (admitted.status === 'retry-mismatch') {
      return {
        v: 1,
        type: 'error',
        requestId: frame.requestId,
        code: 'PEER_RETRY_MISMATCH',
        message: 'Message ID payload mismatch',
      }
    }
    const reason = admitted.status === 'refused' ? admitted.reason : 'ledger-full'
    return { v: 1, type: 'ack', requestId: frame.requestId, messageId: frame.messageId, status: 'refused', reason }
  }

  const onRequest = async (frame: PeerFrameV1, senderInstanceId: string): Promise<PeerFrameV1> => {
    try {
      const sender = await validateSender(senderInstanceId)
      if (frame.type === 'ping') {
        return { v: 1, type: 'pong', requestId: frame.requestId, instanceId: identity!.instanceId }
      }
      if (frame.type === 'message') {
        if (inboundInFlight >= 16) {
          return {
            v: 1,
            type: 'ack',
            requestId: frame.requestId,
            messageId: frame.messageId,
            status: 'refused',
            reason: 'receiver-busy',
          }
        }
        inboundInFlight++
        try {
          return await processMessage(frame, sender)
        } finally {
          inboundInFlight--
        }
      }
      if (frame.type === 'delivery-update') {
        if (frame.receiverInstanceId !== sender.registration.instanceId) {
          return {
            v: 1,
            type: 'delivery-update-ack',
            requestId: frame.requestId,
            messageId: frame.messageId,
            status: 'ignored',
            reason: 'target-mismatch',
          }
        }
        const result = inbox.recordDeliveryUpdate({
          messageId: frame.messageId,
          receiverInstanceId: sender.registration.instanceId,
          peer: publicPeer(sender.registration),
          status: frame.status,
          receivedAt: now().toISOString(),
        })
        return {
          v: 1,
          type: 'delivery-update-ack',
          requestId: frame.requestId,
          messageId: frame.messageId,
          status: result.status === 'recorded' || result.status === 'duplicate' ? result.status : 'ignored',
          ...(result.status === 'ignored' ? { reason: result.reason } : {}),
        }
      }
      return { v: 1, type: 'error', code: 'PEER_PROTOCOL_ERROR', message: 'Unsupported request frame' }
    } catch (error) {
      return {
        v: 1,
        type: 'error',
        code: error instanceof Error ? error.name : 'PEER_INTERNAL',
        message: errorMessage(error),
      }
    }
  }

  const sendFinalUpdate = async (
    claim: NonNullable<ReturnType<PeerInbox['claimFinalUpdates']>>,
    deadlineAt?: number,
  ): Promise<boolean> => {
    const update = claim.updates[0]
    if (!update || !identity) return false
    const remaining = deadlineAt === undefined ? undefined : deadlineAt - Date.now()
    if (remaining !== undefined && remaining <= 0) return false
    const timeoutMs = remaining === undefined ? undefined : Math.max(1, Math.min(100, remaining))
    const controller = timeoutMs === undefined ? undefined : new AbortController()
    let signalTimeout!: () => void
    const timeout =
      timeoutMs === undefined
        ? undefined
        : new Promise<null>((resolve) => {
            signalTimeout = () => resolve(null)
          })
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            controller!.abort()
            signalTimeout()
          }, timeoutMs)
    timer?.unref()
    try {
      const targetInstanceId = update.target.address.slice('peer:'.length)
      const candidate = await registry.read(targetInstanceId)
      if (!candidate) return false
      const requestId = randomUUID()
      const request = transport
        .request({
          address: candidate.registration.transport.address,
          targetToken: candidate.registration.inboxToken,
          senderInstanceId: identity.instanceId,
          frame: {
            v: 1,
            type: 'delivery-update',
            requestId,
            messageId: update.messageId,
            receiverInstanceId: identity.instanceId,
            status: update.status,
            ...(update.reason ? { reason: update.reason } : {}),
          },
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(controller ? { signal: controller.signal } : {}),
        })
        .catch(() => null)
      const response = timeout ? await Promise.race([request, timeout]) : await request
      return (
        response !== null &&
        response.type === 'delivery-update-ack' &&
        response.requestId === requestId &&
        response.messageId === update.messageId
      )
    } catch {
      return false
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const flushFinalUpdates = async (deadlineAt?: number): Promise<void> => {
    if ((!started && !shuttingDown) || !identity) return
    const deferredFailures: Array<NonNullable<ReturnType<PeerInbox['claimFinalUpdates']>>> = []
    try {
      do {
        const claims = Array.from({ length: 16 }, () => inbox.claimFinalUpdates(1)).filter(
          (claim): claim is NonNullable<typeof claim> => claim !== null,
        )
        if (claims.length === 0) return
        const results = await Promise.all(claims.map((claim) => sendFinalUpdate(claim, deadlineAt)))
        for (let index = 0; index < claims.length; index++) {
          const claim = claims[index]!
          if (results[index]) inbox.commitFinalUpdateClaim(claim.claimId)
          else if (deadlineAt === undefined) inbox.releaseFinalUpdateClaim(claim.claimId)
          else deferredFailures.push(claim)
        }
        if (deadlineAt === undefined) return
      } while (Date.now() < deadlineAt)
    } finally {
      for (const claim of deferredFailures) inbox.releaseFinalUpdateClaim(claim.claimId)
    }
  }

  const service: PeerService = {
    enabled,
    identity,
    inbox,
    get unavailableReason() {
      return unavailableReason
    },
    isAvailable: () => enabled && started,
    getUnavailableReason: () => unavailableReason,

    async start(signal) {
      if (!enabled || !identity || started) return
      if (shuttingDown) {
        await shutdownPromise
        return
      }
      if (startPromise) {
        await startPromise
        return
      }
      if (process.platform === 'win32') {
        unavailableReason = 'Peer messaging is not supported on Windows in this release.'
        unavailableCode = 'PEER_UNSUPPORTED_PLATFORM'
        return
      }
      const generation = ++lifecycleGeneration
      const startIsCurrent = (): boolean => !shuttingDown && !signal?.aborted && lifecycleGeneration === generation
      const operation = (async (): Promise<void> => {
        let localServer: PeerTransportServer | undefined
        try {
          if (signal?.aborted) throw signal.reason ?? serviceError('AbortError', 'Peer startup aborted')
          registrationWriteGeneration++
          registrationWritesEnabled = true
          await registry.initialize()
          if (!startIsCurrent()) return
          const socketPath = peerSocketPath(registry.paths().socketDir, identity.instanceId)
          const stale = await lstatIfPresent(socketPath)
          if (!startIsCurrent()) return
          if (stale) {
            if (!stale.isSocket() || stale.isSymbolicLink()) {
              throw serviceError('PEER_SOCKET_UNSAFE', 'Peer socket path is occupied by an unsafe file')
            }
            const scan = await registry.listCandidates()
            if (!startIsCurrent()) return
            if (scan.truncated) {
              throw serviceError('PEER_SOCKET_IN_USE', 'Peer socket ownership scan was truncated')
            }
            const owners = scan.candidates.filter(
              (candidate) => candidate.registration.transport.address === socketPath,
            )
            if (owners.length === 0) {
              throw serviceError('PEER_SOCKET_IN_USE', 'Peer socket owner cannot be proven dead')
            }
            for (const owner of owners) {
              await registry.cleanupConfirmedDead(owner).catch(() => false)
              if (!startIsCurrent()) return
            }
            if (await lstatIfPresent(socketPath)) {
              throw serviceError('PEER_SOCKET_IN_USE', 'Peer socket is owned by another active or unverified session')
            }
            if (!startIsCurrent()) return
          }
          localServer = await transport.listen({
            address: socketPath,
            instanceId: identity.instanceId,
            inboxToken: identity.inboxToken,
            onRequest,
            signal,
          })
          if (!startIsCurrent()) return
          server = localServer
          const timestamp = now().toISOString()
          registration = {
            version: 1,
            instanceId: identity.instanceId,
            pid: process.pid,
            ...(options.sessionId ? { sessionId: options.sessionId } : {}),
            name: identity.name,
            cwd: options.cwd ?? process.cwd(),
            transport: { kind: 'unix', address: localServer.address },
            inboxToken: identity.inboxToken,
            permissionClass: options.getPermissionClass?.() ?? options.permissionClass ?? 'prompted',
            status: 'idle',
            startedAt: identity.startedAt,
            updatedAt: timestamp,
            protocolVersion: 1,
          }
          await writeRegistration()
          if (!startIsCurrent()) return
          heartbeat = setInterval(() => {
            inbox.sweep()
            void Promise.all([writeRegistration(), flushFinalUpdates()]).catch((error) =>
              debugLog('peer.heartbeat', String(error)),
            )
          }, 15_000)
          heartbeat.unref()
          started = true
        } catch (error) {
          if (startIsCurrent()) {
            registrationWritesEnabled = false
            registrationWriteGeneration++
            await registrationWriteTail.catch(() => {})
            if (identity) await registry.removeOwn(identity.instanceId).catch(() => false)
            unavailableReason = errorMessage(error)
            unavailableCode = 'PEER_IO_ERROR'
            debugLog('peer.start-failed', unavailableReason)
          }
        } finally {
          if (!startIsCurrent() || !started) {
            registrationWritesEnabled = false
            registrationWriteGeneration++
            await registrationWriteTail.catch(() => {})
            if (identity) await registry.removeOwn(identity.instanceId).catch(() => false)
            registration = undefined
            if (server === localServer) server = undefined
            await localServer?.close().catch(() => {})
          }
        }
      })()
      startPromise = operation
      try {
        await operation
      } finally {
        if (startPromise === operation) startPromise = null
      }
    },

    async shutdown() {
      if (shutdownPromise) {
        await shutdownPromise
        return
      }
      shuttingDown = true
      lifecycleGeneration++
      started = false
      registrationWritesEnabled = false
      registrationWriteGeneration++
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = undefined
      const operation = (async (): Promise<void> => {
        const activeServer = takeServer()
        await activeServer?.close({ deadlineMs: 500 }).catch(() => {})
        await startPromise?.catch(() => {})
        const lateServer = takeServer()
        if (lateServer && lateServer !== activeServer) await lateServer.close({ deadlineMs: 500 }).catch(() => {})
        inbox.expireAllHeld()
        await flushFinalUpdates(Date.now() + 500).catch(() => {})
        await registrationWriteTail.catch(() => {})
        if (identity) await registry.removeOwn(identity.instanceId).catch(() => false)
        registration = undefined
      })()
      shutdownPromise = operation
      await operation
    },

    async listAgents(signal) {
      return (await this.list(signal)).peers
    },

    async list(signal) {
      if (!enabled || !identity) throw serviceError('PEER_DISABLED', unavailableReason ?? 'Peer messaging is disabled')
      if (!started) throw serviceError(unavailableCode, unavailableReason ?? 'Peer service is not running')
      const live = await registry.listLive({ transport, senderInstanceId: identity.instanceId, signal })
      return { peers: live.peers.slice(0, 100).map(sanitizePublicPeer), partial: live.partial }
    },

    async prepareSend(to, message, summary, messageId, signal) {
      if (!enabled || !identity) throw serviceError('PEER_DISABLED', unavailableReason ?? 'Peer messaging is disabled')
      if (!started) throw serviceError(unavailableCode, unavailableReason ?? 'Peer service is not running')
      const requestedTarget = to.trim()
      if (!requestedTarget || requestedTarget === '*')
        throw serviceError('PEER_INVALID_TARGET', 'Broadcast and empty targets are not supported')
      if (requestedTarget === identity.address) throw serviceError('PEER_SELF', 'Self-send is not allowed')
      if (!message || Buffer.byteLength(message, 'utf8') > 96_000)
        throw serviceError('PEER_MESSAGE_TOO_LARGE', 'Message exceeds the UTF-8 byte limit')
      if (summary && summary.length > 200)
        throw serviceError('PEER_MESSAGE_TOO_LARGE', 'Summary exceeds 200 characters')
      const payloadHash = sendPayloadHash(message, summary)
      let candidate: RegistrationCandidate | null = null
      if (messageId) {
        if (!isUuid(messageId)) throw serviceError('PEER_RETRY_NOT_FOUND', 'Retry message ID must be a UUID')
        const retry = inbox.inspectOutboundRetry(messageId, requestedTarget, payloadHash)
        if (retry.status !== 'ready') {
          const code = retry.status === 'retry-mismatch' ? 'PEER_RETRY_MISMATCH' : 'PEER_RETRY_NOT_FOUND'
          throw serviceError(code, `Message ${messageId} is not eligible for retry`)
        }
        candidate = await registry.read(retry.record.receiverInstanceId)
        if (!candidate || `peer:${candidate.registration.instanceId}` !== retry.record.receiverAddress) {
          throw serviceError('PEER_STALE', 'The originally resolved receiver is no longer registered')
        }
      } else {
        const live = await registry.listLive({ transport, senderInstanceId: identity.instanceId, signal })
        if (requestedTarget.startsWith('peer:')) {
          const instanceId = requestedTarget.slice('peer:'.length)
          if (!isUuid(instanceId)) throw serviceError('PEER_INVALID_TARGET', 'Peer address must contain a full UUID')
          candidate = live.registrations.find((entry) => entry.registration.instanceId === instanceId) ?? null
        } else {
          const matches = live.registrations.filter((entry) => entry.registration.name === requestedTarget)
          if (matches.length > 1) {
            throw serviceError(
              'PEER_AMBIGUOUS_NAME',
              `Name is ambiguous; use one of: ${matches.map((entry) => `peer:${entry.registration.instanceId}`).join(', ')}`,
            )
          }
          candidate = matches[0] ?? null
        }
        if (!candidate) throw serviceError('PEER_NOT_FOUND', `No live peer matches ${requestedTarget}`)
      }
      if (candidate.registration.instanceId === identity.instanceId)
        throw serviceError('PEER_SELF', 'Self-send is not allowed')
      assertOutboundMessageFrameFits(
        outboundMessageFrame({
          requestId: randomUUID(),
          messageId: messageId ?? randomUUID(),
          senderInstanceId: identity.instanceId,
          message,
          ...(summary ? { summary } : {}),
          sentAt: now().toISOString(),
          senderPermissionClass: registration?.permissionClass ?? 'bypass',
        }),
      )
      return {
        requestedTarget,
        receiverInstanceId: candidate.registration.instanceId,
        receiverAddress: `peer:${candidate.registration.instanceId}`,
        message,
        ...(summary ? { summary } : {}),
        ...(messageId ? { messageId } : {}),
        payloadHash,
        candidate,
      }
    },

    async sendPrepared(prepared, signal) {
      if (!identity || !started)
        return {
          success: false,
          code: unavailableCode,
          reason: unavailableReason ?? 'Peer service is not running',
        }
      const current = await registry.read(prepared.receiverInstanceId)
      if (
        !current ||
        current.registration.instanceId !== prepared.candidate.registration.instanceId ||
        current.registration.transport.address !== prepared.candidate.registration.transport.address ||
        current.registration.inboxToken !== prepared.candidate.registration.inboxToken
      ) {
        return {
          success: false,
          code: 'PEER_STALE',
          reason: 'Prepared receiver identity changed',
          ...(prepared.messageId ? { messageId: prepared.messageId } : {}),
        }
      }
      const messageId = prepared.messageId ?? randomUUID()
      if (signal?.aborted) {
        return {
          success: false,
          code: 'PEER_ABORTED',
          reason: 'Peer send was interrupted before dispatch',
          ...(prepared.messageId ? { messageId: prepared.messageId } : {}),
        }
      }
      const requestId = randomUUID()
      const frame = outboundMessageFrame({
        requestId,
        messageId,
        senderInstanceId: identity.instanceId,
        message: prepared.message,
        ...(prepared.summary ? { summary: prepared.summary } : {}),
        sentAt: now().toISOString(),
        senderPermissionClass: registration?.permissionClass ?? 'bypass',
      })
      try {
        assertOutboundMessageFrameFits(frame)
      } catch (error) {
        return {
          success: false,
          code: error instanceof Error ? error.name : 'PEER_MESSAGE_TOO_LARGE',
          reason: stripTerminalControls(errorMessage(error)),
          ...(prepared.messageId ? { messageId: prepared.messageId } : {}),
        }
      }
      if (prepared.messageId) {
        const retry = inbox.beginOutboundRetry(messageId, prepared.requestedTarget, prepared.payloadHash)
        if (retry.status !== 'ready') {
          return {
            success: false,
            code: retry.status === 'retry-mismatch' ? 'PEER_RETRY_MISMATCH' : 'PEER_RETRY_NOT_FOUND',
            reason: `Message ${messageId} is not eligible for retry`,
            messageId,
          }
        }
      } else {
        const admitted = inbox.admitOutbound({
          messageId,
          requestedTarget: prepared.requestedTarget,
          receiverInstanceId: prepared.receiverInstanceId,
          receiverAddress: prepared.receiverAddress,
          payloadHash: prepared.payloadHash,
        })
        if (admitted.status !== 'admitted') {
          return { success: false, code: 'PEER_QUEUE_FULL', reason: admitted.status, messageId }
        }
      }
      try {
        const response = await transport.request({
          address: current.registration.transport.address,
          targetToken: current.registration.inboxToken,
          senderInstanceId: identity.instanceId,
          frame,
          signal,
        })
        if (response.type === 'error') {
          const code = stripTerminalControls(response.code)
          const reason = stripTerminalControls(response.message)
          inbox.transitionOutbound(messageId, { state: 'refused', reason: code })
          return { success: false, code, reason, messageId }
        }
        if (response.type !== 'ack' || response.requestId !== requestId || response.messageId !== messageId) {
          throw serviceError('PEER_PROTOCOL_ERROR', 'Mismatched message acknowledgement')
        }
        const status = response.status === 'duplicate' ? response.duplicateOfStatus : response.status
        if (status === 'delivered') {
          inbox.transitionOutbound(messageId, { state: 'delivered' })
          return { success: true, status: 'delivered', messageId }
        }
        if (status === 'held') {
          if (!response.heldUntil) throw serviceError('PEER_PROTOCOL_ERROR', 'Held acknowledgement omitted deadline')
          inbox.transitionOutbound(messageId, { state: 'held', heldUntil: response.heldUntil })
          return { success: true, status: 'held', messageId, heldUntil: response.heldUntil }
        }
        const terminal = status === 'denied' || status === 'expired' || status === 'refused' ? status : 'refused'
        const reason = response.reason === undefined ? undefined : stripTerminalControls(response.reason)
        inbox.transitionOutbound(messageId, { state: terminal, reason })
        return {
          success: false,
          code:
            terminal === 'refused' && reason === 'rate-limit'
              ? 'PEER_RATE_LIMITED'
              : terminal === 'refused' && (reason === 'accepted-queue-full' || reason === 'held-queue-full')
                ? 'PEER_QUEUE_FULL'
                : `PEER_${terminal.toUpperCase()}`,
          reason: reason ?? terminal,
          messageId,
        }
      } catch (error) {
        const reason = stripTerminalControls(errorMessage(error))
        inbox.transitionOutbound(messageId, {
          state: 'delivery-unknown',
          reason,
        })
        return {
          success: false,
          code: 'PEER_DELIVERY_UNKNOWN',
          reason: 'The connection closed before a matching acknowledgement; retry only with the same message ID.',
          messageId,
        }
      }
    },

    async sendMessage(to, message, summary, messageId, signal) {
      try {
        return await this.sendPrepared(await this.prepareSend(to, message, summary, messageId, signal), signal)
      } catch (error) {
        return {
          success: false,
          code: error instanceof Error ? error.name : 'PEER_INTERNAL',
          reason: stripTerminalControls(errorMessage(error)),
          ...(messageId ? { messageId } : {}),
        }
      }
    },

    async send(input, signal) {
      return this.sendMessage(input.to, input.message, input.summary, input.messageId, signal)
    },

    async updateLocalState(patch) {
      if (!registration || !started || shuttingDown) return
      registration = {
        ...registration,
        ...(patch.name ? { name: normalizePeerName(patch.name) } : {}),
        ...(patch.sessionId !== undefined ? { sessionId: patch.sessionId } : {}),
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.status === 'idle'
          ? { busyKind: undefined }
          : patch.busyKind !== undefined
            ? { busyKind: patch.busyKind }
            : {}),
        ...(patch.permissionClass
          ? { permissionClass: patch.permissionClass }
          : options.getPermissionClass
            ? { permissionClass: options.getPermissionClass() }
            : {}),
      }
      await writeRegistration()
    },

    onInboxChanged: (listener) => inbox.onChanged(listener),
    claimAccepted: (limit) => inbox.claimAccepted(limit),
    commitAcceptedClaim: (claimId) => inbox.commitAcceptedClaim(claimId),
    releaseAcceptedClaim: (claimId) => inbox.releaseAcceptedClaim(claimId),
    markAgentInputsInjected: (keys) => inbox.markAgentInputsInjected(keys),
    markAgentInputsDropped: (keys, reason) => inbox.markAgentInputsDropped(keys, reason),
    listHeld: () => inbox.listHeld(),
    async decideHeld(key, decision) {
      const result = inbox.decideHeld(key, decision)
      if (result.status === 'accepted' || result.status === 'rejected') await flushFinalUpdates()
      return result
    },
    claimDeliveryUpdates: (limit) => inbox.claimDeliveryUpdates(limit),
    commitDeliveryUpdateClaim: (claimId) => inbox.commitDeliveryUpdateClaim(claimId),
    releaseDeliveryUpdateClaim: (claimId) => inbox.releaseDeliveryUpdateClaim(claimId),
  }

  return service
}
