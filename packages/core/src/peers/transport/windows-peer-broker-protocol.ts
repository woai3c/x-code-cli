export const WINDOWS_PEER_BROKER_PROTOCOL_VERSION = 2
export const WINDOWS_PEER_BROKER_HEADER_BYTES = 16
export const WINDOWS_PEER_BROKER_MAX_PAYLOAD_BYTES = 139_264
export const WINDOWS_PEER_BROKER_MAX_OPERATIONS = 256

const MAGIC = Buffer.from('XCPB')
const MAX_PEER_FRAME_BYTES = 131_072

export const WindowsPeerBrokerFrameKind = {
  SecureRuntime: 0x01,
  StartServer: 0x02,
  OutboundRequest: 0x03,
  InboundResponse: 0x04,
  CancelOperation: 0x05,
  Shutdown: 0x06,
  SecureRuntimeResult: 0x81,
  ServerReady: 0x82,
  InboundRequest: 0x83,
  OutboundResponse: 0x84,
  OperationError: 0x86,
  ServerFatal: 0x87,
  ShutdownComplete: 0x88,
} as const

export type WindowsPeerBrokerFrameKind = (typeof WindowsPeerBrokerFrameKind)[keyof typeof WindowsPeerBrokerFrameKind]

const KNOWN_KINDS = new Set<number>(Object.values(WindowsPeerBrokerFrameKind))

export interface WindowsPeerBrokerFrame {
  kind: WindowsPeerBrokerFrameKind
  operationId: number
  payload: Buffer
}

function protocolError(message: string): Error {
  return Object.assign(new Error(message), { name: 'PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH' })
}

function assertOperationId(operationId: number): void {
  if (!Number.isSafeInteger(operationId) || operationId < 0 || operationId > 0xffff_ffff) {
    throw protocolError('Windows peer broker operation ID is invalid')
  }
}

export function encodeWindowsPeerBrokerFrame(frame: WindowsPeerBrokerFrame): Buffer {
  assertOperationId(frame.operationId)
  if (!KNOWN_KINDS.has(frame.kind)) throw protocolError('Windows peer broker frame kind is invalid')
  if (frame.payload.length > WINDOWS_PEER_BROKER_MAX_PAYLOAD_BYTES) {
    throw protocolError('Windows peer broker frame exceeds the payload limit')
  }
  const bytes = Buffer.allocUnsafe(WINDOWS_PEER_BROKER_HEADER_BYTES + frame.payload.length)
  MAGIC.copy(bytes, 0)
  bytes[4] = WINDOWS_PEER_BROKER_PROTOCOL_VERSION
  bytes[5] = frame.kind
  bytes.writeUInt16LE(0, 6)
  bytes.writeUInt32LE(frame.operationId, 8)
  bytes.writeUInt32LE(frame.payload.length, 12)
  frame.payload.copy(bytes, WINDOWS_PEER_BROKER_HEADER_BYTES)
  return bytes
}

export class WindowsPeerBrokerFrameDecoder {
  private buffer = Buffer.alloc(0)

  push(chunk: Uint8Array): WindowsPeerBrokerFrame[] {
    if (chunk.length === 0) return []
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk])
    const frames: WindowsPeerBrokerFrame[] = []
    while (this.buffer.length >= WINDOWS_PEER_BROKER_HEADER_BYTES) {
      if (!this.buffer.subarray(0, 4).equals(MAGIC)) throw protocolError('Invalid Windows peer broker frame magic')
      if (this.buffer[4] !== WINDOWS_PEER_BROKER_PROTOCOL_VERSION) {
        throw protocolError('Unsupported Windows peer broker protocol version')
      }
      const kind = this.buffer[5]!
      if (!KNOWN_KINDS.has(kind)) throw protocolError('Unknown Windows peer broker frame kind')
      if (this.buffer.readUInt16LE(6) !== 0) throw protocolError('Unsupported Windows peer broker frame flags')
      const payloadLength = this.buffer.readUInt32LE(12)
      if (payloadLength > WINDOWS_PEER_BROKER_MAX_PAYLOAD_BYTES) {
        throw protocolError('Windows peer broker frame exceeds the payload limit')
      }
      const frameLength = WINDOWS_PEER_BROKER_HEADER_BYTES + payloadLength
      if (this.buffer.length < frameLength) break
      frames.push({
        kind: kind as WindowsPeerBrokerFrameKind,
        operationId: this.buffer.readUInt32LE(8),
        payload: Buffer.from(this.buffer.subarray(WINDOWS_PEER_BROKER_HEADER_BYTES, frameLength)),
      })
      this.buffer = this.buffer.subarray(frameLength)
    }
    return frames
  }

  finish(): void {
    if (this.buffer.length !== 0) throw protocolError('Truncated Windows peer broker frame')
  }
}

class PayloadWriter {
  private readonly chunks: Buffer[] = []
  private length = 0

  string(value: string): this {
    const bytes = Buffer.from(value, 'utf8')
    if (bytes.length > 0xffff) throw protocolError('Windows peer broker string exceeds the limit')
    const prefix = Buffer.allocUnsafe(2)
    prefix.writeUInt16LE(bytes.length)
    this.push(prefix)
    this.push(bytes)
    return this
  }

  bytes(value: Uint8Array): this {
    if (value.length > MAX_PEER_FRAME_BYTES) throw protocolError('Peer frame exceeds the broker limit')
    const prefix = Buffer.allocUnsafe(4)
    prefix.writeUInt32LE(value.length)
    this.push(prefix)
    this.push(Buffer.from(value))
    return this
  }

  u32(value: number): this {
    assertOperationId(value)
    const bytes = Buffer.allocUnsafe(4)
    bytes.writeUInt32LE(value)
    this.push(bytes)
    return this
  }

  build(): Buffer {
    if (this.length > WINDOWS_PEER_BROKER_MAX_PAYLOAD_BYTES) {
      throw protocolError('Windows peer broker control payload exceeds the limit')
    }
    return Buffer.concat(this.chunks, this.length)
  }

  private push(bytes: Buffer): void {
    this.length += bytes.length
    this.chunks.push(bytes)
  }
}

class PayloadReader {
  private offset = 0

  constructor(private readonly bytes: Buffer) {}

  string(): string {
    const length = this.take(2).readUInt16LE(0)
    const bytes = this.take(length)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw protocolError('Windows peer broker string is not valid UTF-8')
    }
  }

  byteArray(): Buffer {
    const length = this.take(4).readUInt32LE(0)
    if (length > MAX_PEER_FRAME_BYTES) throw protocolError('Peer frame exceeds the broker limit')
    return Buffer.from(this.take(length))
  }

  u32(): number {
    return this.take(4).readUInt32LE(0)
  }

  finish(): void {
    if (this.offset !== this.bytes.length) throw protocolError('Unexpected Windows peer broker payload suffix')
  }

  private take(length: number): Buffer {
    const end = this.offset + length
    if (!Number.isSafeInteger(end) || end > this.bytes.length) {
      throw protocolError('Truncated Windows peer broker payload')
    }
    const value = this.bytes.subarray(this.offset, end)
    this.offset = end
    return value
  }
}

export function encodeSecureRuntimePayload(root: string): Buffer {
  return new PayloadWriter().string(root).build()
}

export function encodeStartServerPayload(input: {
  namespaceId: string
  instanceId: string
  inboxToken: string
}): Buffer {
  return new PayloadWriter().string(input.namespaceId).string(input.instanceId).string(input.inboxToken).build()
}

export function encodeOutboundRequestPayload(input: {
  address: string
  targetToken: string
  senderInstanceId: string
  timeoutMs: number
  peerFrame: Uint8Array
}): Buffer {
  return new PayloadWriter()
    .string(input.address)
    .string(input.targetToken)
    .string(input.senderInstanceId)
    .u32(input.timeoutMs)
    .bytes(input.peerFrame)
    .build()
}

export function encodePeerFramePayload(peerFrame: Uint8Array): Buffer {
  return new PayloadWriter().bytes(peerFrame).build()
}

export function decodeOneStringPayload(payload: Buffer): string {
  const reader = new PayloadReader(payload)
  const value = reader.string()
  reader.finish()
  return value
}

export function decodePeerFramePayload(payload: Buffer): Buffer {
  const reader = new PayloadReader(payload)
  const peerFrame = reader.byteArray()
  if (peerFrame.length === 0) throw protocolError('Windows peer broker returned an empty peer frame')
  reader.finish()
  return peerFrame
}

export function decodeInboundRequestPayload(payload: Buffer): { senderInstanceId: string; peerFrame: Buffer } {
  const reader = new PayloadReader(payload)
  const senderInstanceId = reader.string()
  const peerFrame = reader.byteArray()
  if (peerFrame.length === 0) throw protocolError('Windows peer broker returned an empty inbound frame')
  reader.finish()
  return { senderInstanceId, peerFrame }
}

export function decodeOperationErrorPayload(payload: Buffer): { code: string; message: string } {
  const reader = new PayloadReader(payload)
  const code = reader.string()
  const message = reader.string()
  reader.finish()
  if (!/^PEER_[A-Z0-9_]+$/.test(code)) throw protocolError('Windows peer broker returned an invalid error code')
  return { code, message }
}
