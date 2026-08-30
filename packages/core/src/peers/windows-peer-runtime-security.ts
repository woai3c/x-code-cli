import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { errorMessage, userXcodeDir } from '../utils.js'
import { stripTerminalControls } from './terminal-sanitize.js'
import { type WindowsPeerBrokerArtifact, resolveWindowsPeerBrokerArtifact } from './windows-peer-broker-artifact.js'
import { spawnWindowsPeerBrokerProcess } from './windows-peer-broker-process.js'
import {
  WindowsPeerBrokerFrameKind,
  decodeOneStringPayload,
  decodeOperationErrorPayload,
  encodeSecureRuntimePayload,
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
  try {
    await fs.mkdir(root, { recursive: true })
  } catch (error) {
    throw runtimeError(
      'PEER_WINDOWS_RUNTIME_UNSAFE',
      `Windows peer runtime root creation failed: ${errorMessage(error)}`,
      error,
    )
  }
  const artifact = await (options.artifact ?? resolveWindowsPeerBrokerArtifact())
  if (signal?.aborted) throw abortError()
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
  const brokerProcess = spawnWindowsPeerBrokerProcess({
    artifact,
    mode: 'secure-runtime',
    spawnBroker: options.spawnBroker ?? spawn,
    debugKey: 'peer.windows.runtime-helper',
    onFrame(frame) {
      if (settled) return
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
    },
    onError: settleError,
    onClose() {
      settleError(
        runtimeError(
          'PEER_WINDOWS_RUNTIME_UNSAFE',
          'Windows peer runtime helper exited before completing the security check',
        ),
      )
    },
  })
  const onAbort = (): void => {
    brokerProcess.kill()
    settleError(abortError())
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    brokerProcess.kill()
    settleError(runtimeError('PEER_WINDOWS_RUNTIME_UNSAFE', 'Windows peer runtime security check timed out'))
  }, options.timeoutMs ?? SECURE_RUNTIME_TIMEOUT_MS)
  timer.unref()

  try {
    await brokerProcess.send({
      kind: WindowsPeerBrokerFrameKind.SecureRuntime,
      operationId: SECURE_RUNTIME_OPERATION_ID,
      payload: encodeSecureRuntimePayload(root),
    })
    brokerProcess.endInput()
    const namespaceId = await result
    const status = await brokerProcess.closed
    if (status.code !== 0) {
      throw runtimeError(
        'PEER_WINDOWS_RUNTIME_UNSAFE',
        'Windows peer runtime helper exited before completing the security check',
      )
    }
    const registryDir = path.join(root, 'runtime', 'peers')
    return { registryDir, socketDir: registryDir, namespaceId }
  } catch (error) {
    brokerProcess.kill()
    await brokerProcess.closed
    if (error instanceof Error && (error.name === 'AbortError' || error.name.startsWith('PEER_'))) throw error
    throw runtimeError(
      'PEER_WINDOWS_RUNTIME_UNSAFE',
      `Windows peer runtime security check failed: ${errorMessage(error)}`,
      error,
    )
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
