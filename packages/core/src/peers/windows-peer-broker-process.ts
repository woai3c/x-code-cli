import { type ChildProcessWithoutNullStreams, type spawn } from 'node:child_process'

import { debugLog } from '../utils.js'
import { stripTerminalControls } from './terminal-sanitize.js'
import type { WindowsPeerBrokerArtifact } from './windows-peer-broker-artifact.js'
import {
  WINDOWS_PEER_BROKER_PROTOCOL_VERSION,
  type WindowsPeerBrokerFrame,
  WindowsPeerBrokerFrameDecoder,
  encodeWindowsPeerBrokerFrame,
} from './windows-peer-broker-protocol.js'

const MAX_STDERR_BYTES = 4_096

export interface WindowsPeerBrokerProcess {
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  send(frame: WindowsPeerBrokerFrame): Promise<void>
  endInput(): void
  kill(): void
}

export function spawnWindowsPeerBrokerProcess(options: {
  artifact: WindowsPeerBrokerArtifact
  mode: 'broker' | 'secure-runtime'
  spawnBroker: typeof spawn
  debugKey: string
  onFrame: (frame: WindowsPeerBrokerFrame) => void
  onError: (error: unknown) => void
  onClose?: (status: { code: number | null; signal: NodeJS.Signals | null }) => void
}): WindowsPeerBrokerProcess {
  const child: ChildProcessWithoutNullStreams = options.spawnBroker(
    options.artifact.executablePath,
    [options.mode, '--protocol', String(WINDOWS_PEER_BROKER_PROTOCOL_VERSION)],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  )
  const decoder = new WindowsPeerBrokerFrameDecoder()
  let exited = false
  let stderrBytes = 0
  let writeTail = Promise.resolve()
  let resolveClosed!: (status: { code: number | null; signal: NodeJS.Signals | null }) => void
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveClosed = resolve
  })

  const fail = (error: unknown): void => options.onError(error)
  child.stdin.on('error', fail)
  child.stdout.on('error', fail)
  child.stderr.on('error', fail)
  child.stdout.on('data', (chunk: Buffer) => {
    if (exited) return
    try {
      for (const frame of decoder.push(chunk)) options.onFrame(frame)
    } catch (error) {
      child.kill()
      fail(error)
    }
  })
  child.stdout.once('end', () => {
    try {
      decoder.finish()
    } catch (error) {
      fail(error)
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBytes >= MAX_STDERR_BYTES) return
    const bytes = chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes)
    stderrBytes += bytes.length
    const text = stripTerminalControls(bytes.toString('utf8'))
    if (text) debugLog(options.debugKey, text)
  })
  child.once('error', fail)
  child.once('close', (code, signal) => {
    exited = true
    const status = { code, signal }
    resolveClosed(status)
    options.onClose?.(status)
  })

  return {
    closed,
    send(frame) {
      if (exited) return Promise.reject(new Error('Windows peer broker exited unexpectedly'))
      const bytes = encodeWindowsPeerBrokerFrame(frame)
      const operation = writeTail.then(
        () =>
          new Promise<void>((resolve, reject) => {
            child.stdin.write(bytes, (error) => {
              if (error) reject(error)
              else resolve()
            })
          }),
      )
      writeTail = operation.catch(() => {})
      return operation
    },
    endInput: () => child.stdin.end(),
    kill: () => child.kill(),
  }
}
