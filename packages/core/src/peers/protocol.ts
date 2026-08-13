import { isUuid } from './identity.js'
import { stripTerminalControls } from './terminal-sanitize.js'

export const MAX_FRAME_BYTES = 131_072
export const MAX_MESSAGE_BYTES = 96_000

export type PeerFrameV1 =
  | { v: 1; type: 'auth'; targetToken: string; senderInstanceId: string }
  | { v: 1; type: 'auth-ok' }
  | { v: 1; type: 'ping'; requestId: string }
  | { v: 1; type: 'pong'; requestId: string; instanceId: string }
  | {
      v: 1
      type: 'message'
      requestId: string
      messageId: string
      senderInstanceId: string
      text: string
      summary?: string
      sentAt: string
      senderPermissionClass: 'prompted' | 'bypass'
    }
  | {
      v: 1
      type: 'ack'
      requestId: string
      messageId?: string
      status: 'delivered' | 'held' | 'refused' | 'duplicate'
      duplicateOfStatus?: 'delivered' | 'held' | 'denied' | 'expired' | 'refused'
      heldUntil?: string
      reason?: string
    }
  | {
      v: 1
      type: 'delivery-update'
      requestId: string
      messageId: string
      receiverInstanceId: string
      status: 'delivered' | 'denied' | 'expired'
      reason?: string
    }
  | {
      v: 1
      type: 'delivery-update-ack'
      requestId: string
      messageId: string
      status: 'recorded' | 'duplicate' | 'ignored'
      reason?: string
    }
  | { v: 1; type: 'error'; requestId?: string; code: string; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value)
  return (
    required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key))
  )
}

function isWellFormedString(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++index)
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}

function validString(value: unknown, max = 4096): value is string {
  return typeof value === 'string' && value.length <= max && isWellFormedString(value)
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && isUuid(value)
}

function validDate(value: unknown): value is string {
  return validString(value, 64) && Number.isFinite(Date.parse(value))
}

function sanitizeFrameStrings(value: Record<string, unknown>): Record<string, unknown> {
  const frame = { ...value }
  const fields =
    value.type === 'message'
      ? ['text', 'summary']
      : value.type === 'ack' || value.type === 'delivery-update' || value.type === 'delivery-update-ack'
        ? ['reason']
        : value.type === 'error'
          ? ['code', 'message']
          : []
  for (const field of fields) {
    if (typeof frame[field] === 'string') frame[field] = stripTerminalControls(frame[field])
  }
  return frame
}

function validatePeerFrame(value: unknown, sanitizeStrings: boolean): PeerFrameV1 {
  if (!isRecord(value) || value.v !== 1 || typeof value.type !== 'string') throw new Error('Invalid peer frame')
  const frame = sanitizeStrings ? sanitizeFrameStrings(value) : { ...value }
  switch (frame.type) {
    case 'auth':
      if (
        !exactKeys(frame, ['v', 'type', 'targetToken', 'senderInstanceId']) ||
        !validString(frame.targetToken, 128) ||
        !validUuid(frame.senderInstanceId)
      )
        break
      return frame as PeerFrameV1
    case 'auth-ok':
      if (exactKeys(frame, ['v', 'type'])) return frame as PeerFrameV1
      break
    case 'ping':
      if (exactKeys(frame, ['v', 'type', 'requestId']) && validUuid(frame.requestId)) return frame as PeerFrameV1
      break
    case 'pong':
      if (
        exactKeys(frame, ['v', 'type', 'requestId', 'instanceId']) &&
        validUuid(frame.requestId) &&
        validUuid(frame.instanceId)
      )
        return frame as PeerFrameV1
      break
    case 'message':
      if (
        exactKeys(
          frame,
          ['v', 'type', 'requestId', 'messageId', 'senderInstanceId', 'text', 'sentAt', 'senderPermissionClass'],
          ['summary'],
        ) &&
        validUuid(frame.requestId) &&
        validUuid(frame.messageId) &&
        validUuid(frame.senderInstanceId) &&
        validString(frame.text, MAX_MESSAGE_BYTES) &&
        Buffer.byteLength(frame.text, 'utf8') <= MAX_MESSAGE_BYTES &&
        (frame.summary === undefined || validString(frame.summary, 200)) &&
        validDate(frame.sentAt) &&
        (frame.senderPermissionClass === 'prompted' || frame.senderPermissionClass === 'bypass')
      )
        return frame as PeerFrameV1
      break
    case 'ack':
      if (
        exactKeys(
          frame,
          ['v', 'type', 'requestId', 'status'],
          ['messageId', 'duplicateOfStatus', 'heldUntil', 'reason'],
        ) &&
        validUuid(frame.requestId) &&
        (frame.messageId === undefined || validUuid(frame.messageId)) &&
        ['delivered', 'held', 'refused', 'duplicate'].includes(frame.status as string) &&
        (frame.duplicateOfStatus === undefined ||
          ['delivered', 'held', 'denied', 'expired', 'refused'].includes(frame.duplicateOfStatus as string)) &&
        (frame.heldUntil === undefined || validDate(frame.heldUntil)) &&
        (frame.reason === undefined || validString(frame.reason, 1024))
      )
        return frame as PeerFrameV1
      break
    case 'delivery-update':
      if (
        exactKeys(frame, ['v', 'type', 'requestId', 'messageId', 'receiverInstanceId', 'status'], ['reason']) &&
        validUuid(frame.requestId) &&
        validUuid(frame.messageId) &&
        validUuid(frame.receiverInstanceId) &&
        ['delivered', 'denied', 'expired'].includes(frame.status as string) &&
        (frame.reason === undefined || validString(frame.reason, 1024))
      )
        return frame as PeerFrameV1
      break
    case 'delivery-update-ack':
      if (
        exactKeys(frame, ['v', 'type', 'requestId', 'messageId', 'status'], ['reason']) &&
        validUuid(frame.requestId) &&
        validUuid(frame.messageId) &&
        ['recorded', 'duplicate', 'ignored'].includes(frame.status as string) &&
        (frame.reason === undefined || validString(frame.reason, 1024))
      )
        return frame as PeerFrameV1
      break
    case 'error':
      if (
        exactKeys(frame, ['v', 'type', 'code', 'message'], ['requestId']) &&
        (frame.requestId === undefined || validUuid(frame.requestId)) &&
        validString(frame.code, 128) &&
        validString(frame.message, 1024)
      )
        return frame as PeerFrameV1
      break
  }
  throw new Error(`Invalid peer ${frame.type} frame`)
}

export function parsePeerFrame(value: unknown): PeerFrameV1 {
  return validatePeerFrame(value, true)
}

export function encodePeerFrame(frame: PeerFrameV1): Buffer {
  const validated = validatePeerFrame(frame, false)
  const encoded = Buffer.from(JSON.stringify(validated) + '\n', 'utf8')
  if (encoded.byteLength > MAX_FRAME_BYTES) throw new Error('PEER_FRAME_TOO_LARGE')
  return encoded
}

export class NdjsonFrameDecoder {
  private pending = Buffer.alloc(0)

  push(chunk: Buffer): PeerFrameV1[] {
    if (chunk.length === 0) return []
    this.pending = Buffer.concat([this.pending, chunk])
    const frames: PeerFrameV1[] = []
    while (true) {
      const newline = this.pending.indexOf(0x0a)
      if (newline < 0) {
        if (this.pending.length > MAX_FRAME_BYTES) throw new Error('PEER_FRAME_TOO_LARGE')
        return frames
      }
      if (newline + 1 > MAX_FRAME_BYTES) throw new Error('PEER_FRAME_TOO_LARGE')
      const bytes = this.pending.subarray(0, newline)
      this.pending = this.pending.subarray(newline + 1)
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new Error('PEER_INVALID_UTF8')
      }
      if (!text) throw new Error('PEER_EMPTY_FRAME')
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error('PEER_INVALID_JSON')
      }
      frames.push(parsePeerFrame(parsed))
    }
  }

  finish(): void {
    if (this.pending.length > 0) throw new Error('PEER_PARTIAL_FRAME')
  }
}
