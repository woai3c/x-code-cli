import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { PublicPeer } from '../types/index.js'
import { isUuid, normalizePeerName } from './identity.js'
import { ensurePeerRuntimeDirectories, isSocketPathInNamespace } from './paths.js'
import { stripTerminalControls } from './terminal-sanitize.js'
import type { PeerTransport } from './transport.js'
import {
  type CandidateScanResult,
  MAX_REGISTRATION_BYTES,
  MAX_REGISTRATION_CANDIDATES,
  type PeerRegistrationV1,
  type RegistrationCandidate,
} from './types.js'

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(record).every((key) => allowedSet.has(key))
}

function validIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
}

function parseRegistration(value: unknown, socketDir: string): PeerRegistrationV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  if (
    !exactKeys(source, [
      'version',
      'instanceId',
      'pid',
      'sessionId',
      'name',
      'cwd',
      'transport',
      'inboxToken',
      'permissionClass',
      'status',
      'busyKind',
      'startedAt',
      'updatedAt',
      'protocolVersion',
    ])
  ) {
    return null
  }
  const record = { ...source }
  if (typeof record.name === 'string') record.name = stripTerminalControls(record.name)
  if (typeof record.cwd === 'string') record.cwd = stripTerminalControls(record.cwd)
  if (
    record.version !== 1 ||
    record.protocolVersion !== 1 ||
    typeof record.instanceId !== 'string' ||
    !isUuid(record.instanceId) ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    (record.sessionId !== undefined && (typeof record.sessionId !== 'string' || record.sessionId.length > 128)) ||
    typeof record.name !== 'string' ||
    typeof record.cwd !== 'string' ||
    record.cwd.length === 0 ||
    record.cwd.length > 4096 ||
    !path.isAbsolute(record.cwd) ||
    typeof record.inboxToken !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(record.inboxToken) ||
    (record.permissionClass !== 'prompted' && record.permissionClass !== 'bypass') ||
    !['idle', 'busy', 'waiting'].includes(record.status as string) ||
    (record.busyKind !== undefined &&
      !['interactive-turn', 'goal', 'maintenance'].includes(record.busyKind as string)) ||
    !validIsoDate(record.startedAt) ||
    !validIsoDate(record.updatedAt)
  ) {
    return null
  }
  try {
    if (normalizePeerName(record.name) !== record.name) return null
  } catch {
    return null
  }
  if (!record.transport || typeof record.transport !== 'object' || Array.isArray(record.transport)) return null
  const transport = record.transport as Record<string, unknown>
  if (
    !exactKeys(transport, ['kind', 'address']) ||
    transport.kind !== 'unix' ||
    typeof transport.address !== 'string' ||
    !isSocketPathInNamespace(transport.address, socketDir) ||
    (path.basename(transport.address) !== `${record.instanceId.slice(0, 8)}.sock` &&
      !/^p-[A-Za-z0-9_-]{16}\.sock$/.test(path.basename(transport.address)))
  ) {
    return null
  }
  return structuredClone(record) as unknown as PeerRegistrationV1
}

async function validateOpenRegistration(handle: fs.FileHandle): Promise<{ size: number; mtimeMs: number } | null> {
  const stat = await handle.stat()
  if (!stat.isFile() || stat.size > MAX_REGISTRATION_BYTES) return null
  if (process.platform !== 'win32') {
    const uid = process.getuid?.()
    if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o777) !== 0o600) return null
  }
  return { size: stat.size, mtimeMs: stat.mtimeMs }
}

async function readCandidateFile(
  registrationPath: string,
  expectedInstanceId: string,
  socketDir: string,
): Promise<RegistrationCandidate | null> {
  let handle: fs.FileHandle | undefined
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    handle = await fs.open(registrationPath, flags)
    const safe = await validateOpenRegistration(handle)
    if (!safe) return null
    const raw = await handle.readFile({ encoding: 'utf8' })
    if (Buffer.byteLength(raw, 'utf8') > MAX_REGISTRATION_BYTES) return null
    const registration = parseRegistration(JSON.parse(raw), socketDir)
    if (!registration || registration.instanceId !== expectedInstanceId) return null
    return { registration, registrationPath, mtimeMs: safe.mtimeMs }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function pidExists(pid: number): Promise<boolean | 'unknown'> {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    return 'unknown'
  }
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

export interface PeerRegistry {
  initialize(): Promise<void>
  write(registration: PeerRegistrationV1): Promise<void>
  read(instanceId: string): Promise<RegistrationCandidate | null>
  listCandidates(): Promise<CandidateScanResult>
  listLive(options: {
    transport: PeerTransport
    senderInstanceId: string
    signal?: AbortSignal
    concurrency?: number
    deadlineMs?: number
  }): Promise<{ peers: PublicPeer[]; registrations: RegistrationCandidate[]; partial: boolean }>
  removeOwn(instanceId: string): Promise<boolean>
  cleanupConfirmedDead(candidate: RegistrationCandidate, graceMs?: number): Promise<boolean>
  paths(): { registryDir: string; socketDir: string }
}

export function createPeerRegistry(): PeerRegistry {
  let registryDir = ''
  let socketDir = ''

  const initialize = async (): Promise<void> => {
    const paths = await ensurePeerRuntimeDirectories()
    registryDir = paths.registryDir
    socketDir = paths.socketDir
  }

  const ensureInitialized = async (): Promise<void> => {
    if (!registryDir || !socketDir) await initialize()
  }

  const read = async (instanceId: string): Promise<RegistrationCandidate | null> => {
    if (!isUuid(instanceId)) return null
    await ensureInitialized()
    return readCandidateFile(path.join(registryDir, `${instanceId}.json`), instanceId, socketDir)
  }

  return {
    initialize,

    async write(registration) {
      await ensureInitialized()
      const validated = parseRegistration(registration, socketDir)
      if (!validated) throw new Error('Invalid peer registration')
      const finalPath = path.join(registryDir, `${validated.instanceId}.json`)
      const tempPath = path.join(registryDir, `.${validated.instanceId}.${randomUUID()}.tmp`)
      const bytes = JSON.stringify(validated) + '\n'
      if (Buffer.byteLength(bytes, 'utf8') > MAX_REGISTRATION_BYTES) throw new Error('Peer registration is too large')
      let handle: fs.FileHandle | undefined
      try {
        handle = await fs.open(tempPath, 'wx', 0o600)
        if (process.platform !== 'win32') await handle.chmod(0o600)
        if (!(await validateOpenRegistration(handle))) throw new Error('Unsafe peer registration temporary file')
        await handle.writeFile(bytes, 'utf8')
        await handle.sync()
        await handle.close()
        handle = undefined
        await fs.rename(tempPath, finalPath)
        // Windows cannot flush directory handles (fsync returns EPERM).
        // The registration file itself has already been flushed above.
        if (process.platform !== 'win32') {
          const directory = await fs.open(registryDir, 'r')
          try {
            await directory.sync()
          } finally {
            await directory.close()
          }
        }
      } catch (error) {
        await handle?.close().catch(() => {})
        await fs.unlink(tempPath).catch(() => {})
        throw error
      }
    },

    read,

    async listCandidates() {
      await ensureInitialized()
      const names = (await fs.readdir(registryDir)).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name)).sort()
      const selected = names.slice(0, MAX_REGISTRATION_CANDIDATES)
      const candidates: RegistrationCandidate[] = []
      let rejected = 0
      for (const name of selected) {
        const instanceId = name.slice(0, -'.json'.length)
        if (!isUuid(instanceId)) {
          rejected++
          continue
        }
        const candidate = await readCandidateFile(path.join(registryDir, name), instanceId, socketDir)
        if (candidate) candidates.push(candidate)
        else rejected++
      }
      return { candidates, scanned: selected.length, rejected, truncated: names.length > selected.length }
    },

    async listLive(options) {
      const scan = await this.listCandidates()
      const candidates = scan.candidates.filter(
        (candidate) => candidate.registration.instanceId !== options.senderInstanceId,
      )
      const registrations: RegistrationCandidate[] = []
      const concurrency = Math.min(16, Math.max(8, options.concurrency ?? 12))
      const deadlineAt = Date.now() + (options.deadlineMs ?? 4_000)
      const controller = new AbortController()
      let deadlineTriggered = false
      const onAbort = () => controller.abort()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(
        () => {
          deadlineTriggered = true
          controller.abort()
        },
        Math.max(0, deadlineAt - Date.now()),
      )
      timer.unref()
      let cursor = 0
      let partial = scan.truncated
      const worker = async (): Promise<void> => {
        while (!controller.signal.aborted) {
          const index = cursor++
          const candidate = candidates[index]
          if (!candidate) return
          const livePid = await pidExists(candidate.registration.pid)
          if (livePid === false) {
            await this.cleanupConfirmedDead(candidate).catch(() => false)
            continue
          }
          const requestId = randomUUID()
          try {
            const response = await options.transport.request({
              address: candidate.registration.transport.address,
              targetToken: candidate.registration.inboxToken,
              senderInstanceId: options.senderInstanceId,
              frame: { v: 1, type: 'ping', requestId },
              timeoutMs: Math.min(1_000, Math.max(1, deadlineAt - Date.now())),
              signal: controller.signal,
            })
            if (
              response.type === 'pong' &&
              response.requestId === requestId &&
              response.instanceId === candidate.registration.instanceId
            ) {
              registrations.push(candidate)
            }
          } catch {
            // A live PID may have a blocked event loop. Ping failure hides it
            // from this live view but never authorizes registration/socket deletion.
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()))
      if (deadlineTriggered || (controller.signal.aborted && cursor < candidates.length)) partial = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (options.signal?.aborted) throw Object.assign(new Error('PEER_ABORTED'), { name: 'AbortError' })
      registrations.sort((a, b) => a.registration.startedAt.localeCompare(b.registration.startedAt))
      const peers = registrations.map(({ registration }) => ({
        name: registration.name,
        address: `peer:${registration.instanceId}` as const,
        cwd: registration.cwd,
        status: registration.status,
        ...(registration.busyKind ? { busyKind: registration.busyKind } : {}),
        startedAt: registration.startedAt,
        ...(registration.sessionId ? { sessionId: registration.sessionId } : {}),
      }))
      return { peers, registrations, partial }
    },

    async removeOwn(instanceId) {
      if (!isUuid(instanceId)) return false
      await ensureInitialized()
      const candidate = await read(instanceId)
      if (!candidate || candidate.registration.pid !== process.pid) return false
      await fs.unlink(candidate.registrationPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      return true
    },

    async cleanupConfirmedDead(candidate, graceMs = 30_000) {
      await ensureInitialized()
      const registration = candidate.registration
      if ((await pidExists(registration.pid)) !== false) return false
      if (Date.now() - Date.parse(registration.updatedAt) < graceMs) return false
      const current = await read(registration.instanceId)
      if (
        !current ||
        current.mtimeMs !== candidate.mtimeMs ||
        current.registration.pid !== registration.pid ||
        current.registration.updatedAt !== registration.updatedAt ||
        (await pidExists(registration.pid)) !== false
      ) {
        return false
      }
      const socketPath = registration.transport.address
      const socketBefore = isSocketPathInNamespace(socketPath, socketDir)
        ? await fs.lstat(socketPath).catch(() => null)
        : null
      await fs.unlink(current.registrationPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      if (socketBefore?.isSocket() && !socketBefore.isSymbolicLink()) {
        const remaining = await this.listCandidates()
        const shared = remaining.candidates.some((other) => other.registration.transport.address === socketPath)
        if (!remaining.truncated && remaining.rejected === 0 && !shared) {
          const socketAfter = await fs.lstat(socketPath).catch(() => null)
          if (socketAfter?.isSocket() && !socketAfter.isSymbolicLink() && sameFileIdentity(socketBefore, socketAfter)) {
            await fs.unlink(socketPath).catch(() => {})
          }
        }
      }
      return true
    },

    paths() {
      if (!registryDir || !socketDir) throw new Error('Peer registry has not been initialized')
      return { registryDir, socketDir }
    },
  }
}
