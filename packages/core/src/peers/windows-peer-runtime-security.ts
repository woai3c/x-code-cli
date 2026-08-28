import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import path from 'node:path'

import { debugLog, errorMessage, userXcodeDir } from '../utils.js'
import { stripTerminalControls } from './terminal-sanitize.js'
import { type WindowsPeerBrokerArtifact, resolveWindowsPeerBrokerArtifact } from './windows-peer-broker-artifact.js'
import {
  WINDOWS_PEER_BROKER_PROTOCOL_VERSION,
  WindowsPeerBrokerFrameDecoder,
  WindowsPeerBrokerFrameKind,
  decodeOneStringPayload,
  decodeOperationErrorPayload,
  encodeSecureRuntimePayload,
  encodeWindowsPeerBrokerFrame,
} from './windows-peer-broker-protocol.js'

const SECURE_RUNTIME_OPERATION_ID = 1
const SECURE_RUNTIME_TIMEOUT_MS = 5_000

export interface WindowsPeerRuntimePaths {
  registryDir: string
  socketDir: string
  namespaceId: string
}

export interface WindowsPeerRuntimeSecurityProvider {
  initialize(signal?: AbortSignal): Promise<WindowsPeerRuntimePaths>
}

export interface WindowsPeerRuntimeSecurityOptions {
  root?: string
  artifact?: WindowsPeerBrokerArtifact | Promise<WindowsPeerBrokerArtifact>
  spawnBroker?: typeof spawn
  timeoutMs?: number
}

function runtimeError(code: string, message: string, cause?: unknown): Error {
  const error = new Error(stripTerminalControls(message), cause === undefined ? undefined : { cause })
  error.name = code
  return error
}

function abortError(): Error {
  return Object.assign(new Error('Windows peer runtime initialization was interrupted'), { name: 'AbortError' })
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

export function createWindowsPeerRuntimeSecurity(
  options: WindowsPeerRuntimeSecurityOptions = {},
): WindowsPeerRuntimeSecurityProvider {
  let initialized: Promise<WindowsPeerRuntimePaths> | undefined
  return {
    initialize(signal) {
      if (initialized) return initialized
      const operation = secureWindowsPeerRuntime(options, signal).catch((error) => {
        initialized = undefined
        throw error
      })
      initialized = operation
      return operation
    },
  }
}

async function secureWindowsPeerRuntime(
  options: WindowsPeerRuntimeSecurityOptions,
  signal?: AbortSignal,
): Promise<WindowsPeerRuntimePaths> {
  if (process.platform !== 'win32') {
    throw runtimeError('PEER_UNSUPPORTED_PLATFORM', 'Windows peer runtime security is only available on Windows')
  }
  if (signal?.aborted) throw abortError()
  const root = path.resolve(options.root ?? userXcodeDir())
  const artifact = await (options.artifact ?? resolveWindowsPeerBrokerArtifact())
  if (signal?.aborted) throw abortError()
  const spawnBroker = options.spawnBroker ?? spawn
  const child = spawnBroker(
    artifact.executablePath,
    ['secure-runtime', '--protocol', String(WINDOWS_PEER_BROKER_PROTOCOL_VERSION)],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  const decoder = new WindowsPeerBrokerFrameDecoder()
  let stderr = ''
  let settled = false
  let resolveResult!: (namespaceId: string) => void
  let rejectResult!: (error: unknown) => void
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  const settleError = (error: unknown): void => {
    if (settled) return
    settled = true
    rejectResult(error)
  }
  const onAbort = (): void => {
    child.kill()
    settleError(abortError())
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  child.stdout.on('data', (chunk: Buffer) => {
    if (settled) return
    try {
      for (const frame of decoder.push(chunk)) {
        if (frame.operationId !== SECURE_RUNTIME_OPERATION_ID) {
          throw runtimeError(
            'PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH',
            'Windows peer runtime helper returned an unknown operation ID',
          )
        }
        if (frame.kind === WindowsPeerBrokerFrameKind.SecureRuntimeResult) {
          const namespaceId = decodeOneStringPayload(frame.payload)
          if (!/^[a-f0-9]{12}$/.test(namespaceId)) {
            throw runtimeError(
              'PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH',
              'Windows peer runtime helper returned an invalid namespace',
            )
          }
          settled = true
          resolveResult(namespaceId)
        } else if (frame.kind === WindowsPeerBrokerFrameKind.OperationError) {
          const failure = decodeOperationErrorPayload(frame.payload)
          settleError(runtimeError(failure.code, failure.message))
        } else {
          throw runtimeError(
            'PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH',
            'Windows peer runtime helper returned an unexpected frame',
          )
        }
      }
    } catch (error) {
      child.kill()
      settleError(error)
    }
  })
  child.stdout.once('end', () => {
    try {
      decoder.finish()
    } catch (error) {
      settleError(error)
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length >= 4_096) return
    stderr += stripTerminalControls(chunk.toString('utf8')).slice(0, 4_096 - stderr.length)
  })
  const exit = waitForExit(child)
  const timer = setTimeout(() => {
    child.kill()
    settleError(runtimeError('PEER_WINDOWS_RUNTIME_UNSAFE', 'Windows peer runtime security check timed out'))
  }, options.timeoutMs ?? SECURE_RUNTIME_TIMEOUT_MS)
  timer.unref()

  try {
    const request = encodeWindowsPeerBrokerFrame({
      kind: WindowsPeerBrokerFrameKind.SecureRuntime,
      operationId: SECURE_RUNTIME_OPERATION_ID,
      payload: encodeSecureRuntimePayload(root),
    })
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(request, (error) => {
        if (error) reject(error)
        else {
          child.stdin.end()
          resolve()
        }
      })
    })
    const namespaceId = await result
    const status = await exit
    if (status.code !== 0) {
      throw runtimeError(
        'PEER_WINDOWS_RUNTIME_UNSAFE',
        'Windows peer runtime helper exited before completing the security check',
      )
    }
    if (stderr) debugLog('peer.windows.runtime-helper', stderr)
    const registryDir = path.join(root, 'runtime', 'peers')
    return { registryDir, socketDir: registryDir, namespaceId }
  } catch (error) {
    child.kill()
    const status = await exit.catch(() => null)
    if (stderr) debugLog('peer.windows.runtime-helper', stderr)
    if (error instanceof Error && (error.name === 'AbortError' || error.name.startsWith('PEER_'))) throw error
    throw runtimeError(
      'PEER_WINDOWS_RUNTIME_UNSAFE',
      `Windows peer runtime security check failed: ${errorMessage(error)}`,
      status,
    )
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
