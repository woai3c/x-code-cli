export const WINDOWS_SUPERVISOR_PROTOCOL_VERSION = 2
export const WINDOWS_SUPERVISOR_MAGIC = Buffer.from('XCSH', 'ascii')
export const WINDOWS_SUPERVISOR_HEADER_BYTES = 12
export const WINDOWS_SUPERVISOR_MAX_FRAME_BYTES = 64 * 1024 * 1024

export const WindowsSupervisorFrameKind = {
  launch: 0x01,
  graceful: 0x02,
  force: 0x03,
  close: 0x04,
  ready: 0x81,
  stdout: 0x82,
  stderr: 0x83,
  rootExit: 0x84,
  treeEmpty: 0x85,
  spawnError: 0x86,
  terminationError: 0x87,
  stdoutEof: 0x88,
  stderrEof: 0x89,
} as const

export type WindowsSupervisorFrameKindValue =
  (typeof WindowsSupervisorFrameKind)[keyof typeof WindowsSupervisorFrameKind]

export interface WindowsSupervisorFrame {
  kind: WindowsSupervisorFrameKindValue
  payload: Buffer
}

function encodeString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32LE(bytes.length)
  return Buffer.concat([length, bytes])
}

export function encodeWindowsSupervisorFrame(kind: WindowsSupervisorFrameKindValue, payload = Buffer.alloc(0)): Buffer {
  if (payload.length > WINDOWS_SUPERVISOR_MAX_FRAME_BYTES) throw new RangeError('Windows supervisor frame is too large')
  const header = Buffer.alloc(WINDOWS_SUPERVISOR_HEADER_BYTES)
  WINDOWS_SUPERVISOR_MAGIC.copy(header, 0)
  header[4] = WINDOWS_SUPERVISOR_PROTOCOL_VERSION
  header[5] = kind
  header.writeUInt32LE(payload.length, 8)
  return Buffer.concat([header, payload])
}

export function encodeWindowsSupervisorLaunch(input: {
  cwd: string
  application: string
  commandLine: string
}): Buffer {
  return encodeWindowsSupervisorFrame(
    WindowsSupervisorFrameKind.launch,
    Buffer.concat([encodeString(input.cwd), encodeString(input.application), encodeString(input.commandLine)]),
  )
}

export class WindowsSupervisorFrameDecoder {
  private pending = Buffer.alloc(0)

  push(chunk: Uint8Array): WindowsSupervisorFrame[] {
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)])
    const frames: WindowsSupervisorFrame[] = []
    while (this.pending.length >= WINDOWS_SUPERVISOR_HEADER_BYTES) {
      if (!this.pending.subarray(0, 4).equals(WINDOWS_SUPERVISOR_MAGIC)) {
        throw new Error('Windows shell supervisor sent an invalid protocol magic')
      }
      if (this.pending[4] !== WINDOWS_SUPERVISOR_PROTOCOL_VERSION) {
        throw new Error(
          `Windows shell supervisor protocol mismatch: expected ${WINDOWS_SUPERVISOR_PROTOCOL_VERSION}, received ${this.pending[4]}`,
        )
      }
      const payloadBytes = this.pending.readUInt32LE(8)
      if (payloadBytes > WINDOWS_SUPERVISOR_MAX_FRAME_BYTES) {
        throw new Error(`Windows shell supervisor frame exceeds ${WINDOWS_SUPERVISOR_MAX_FRAME_BYTES} bytes`)
      }
      const frameBytes = WINDOWS_SUPERVISOR_HEADER_BYTES + payloadBytes
      if (this.pending.length < frameBytes) break
      const kind = this.pending[5] as WindowsSupervisorFrameKindValue
      const payload = Buffer.from(this.pending.subarray(WINDOWS_SUPERVISOR_HEADER_BYTES, frameBytes))
      frames.push({ kind, payload })
      this.pending = this.pending.subarray(frameBytes)
    }
    return frames
  }

  end(): void {
    if (this.pending.length > 0) throw new Error('Windows shell supervisor ended with a truncated protocol frame')
  }
}

export function quoteWindowsCommandArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/.test(value)) return value
  let result = '"'
  let backslashes = 0
  for (const char of value) {
    if (char === '\\') {
      backslashes++
      continue
    }
    if (char === '"') {
      result += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    result += '\\'.repeat(backslashes) + char
    backslashes = 0
  }
  result += '\\'.repeat(backslashes * 2) + '"'
  return result
}
