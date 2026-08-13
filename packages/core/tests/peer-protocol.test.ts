import { describe, expect, it } from 'vitest'

import { randomUUID } from 'node:crypto'

import {
  MAX_FRAME_BYTES,
  MAX_MESSAGE_BYTES,
  NdjsonFrameDecoder,
  encodePeerFrame,
  parsePeerFrame,
} from '../src/peers/protocol.js'

describe('peer NDJSON protocol', () => {
  it('decodes partial and multiple byte-framed messages', () => {
    const one = encodePeerFrame({ v: 1, type: 'ping', requestId: randomUUID() })
    const two = encodePeerFrame({ v: 1, type: 'ping', requestId: randomUUID() })
    const decoder = new NdjsonFrameDecoder()
    expect(decoder.push(one.subarray(0, 5))).toEqual([])
    const frames = decoder.push(Buffer.concat([one.subarray(5), two]))
    expect(frames.map((frame) => frame.type)).toEqual(['ping', 'ping'])
    expect(() => decoder.finish()).not.toThrow()
  })

  it('rejects invalid UTF-8, oversized frames, and a partial final frame', () => {
    expect(() => new NdjsonFrameDecoder().push(Buffer.from([0xc3, 0x28, 0x0a]))).toThrow('PEER_INVALID_UTF8')
    expect(() => new NdjsonFrameDecoder().push(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61))).toThrow('PEER_FRAME_TOO_LARGE')
    const decoder = new NdjsonFrameDecoder()
    decoder.push(Buffer.from('{"v":1'))
    expect(() => decoder.finish()).toThrow('PEER_PARTIAL_FRAME')
  })

  it('uses serialized UTF-8 bytes as the authoritative cap', () => {
    const frame = {
      v: 1,
      type: 'message',
      requestId: randomUUID(),
      messageId: randomUUID(),
      senderInstanceId: randomUUID(),
      text: '界'.repeat(Math.floor(MAX_MESSAGE_BYTES / 3)),
      sentAt: new Date().toISOString(),
      senderPermissionClass: 'prompted',
    } as const
    expect(encodePeerFrame(frame).byteLength).toBeLessThanOrEqual(MAX_FRAME_BYTES)
    expect(() => parsePeerFrame({ ...frame, text: '界'.repeat(Math.floor(MAX_MESSAGE_BYTES / 3) + 1) })).toThrow()
  })

  it('rejects unpaired surrogate escapes and unknown fields', () => {
    expect(() => parsePeerFrame({ v: 1, type: 'error', code: 'BAD', message: '\ud800' })).toThrow()
    expect(() => parsePeerFrame({ v: 1, type: 'ping', requestId: randomUUID(), extra: true })).toThrow()
  })

  it('keeps delivery-update acknowledgements distinct from message acknowledgements', () => {
    const requestId = randomUUID()
    const messageId = randomUUID()
    expect(parsePeerFrame({ v: 1, type: 'delivery-update-ack', requestId, messageId, status: 'recorded' })).toEqual({
      v: 1,
      type: 'delivery-update-ack',
      requestId,
      messageId,
      status: 'recorded',
    })
    expect(() => parsePeerFrame({ v: 1, type: 'ack', requestId, messageId, status: 'recorded' })).toThrow()
  })

  it('sanitizes message text and summary before applying their byte and character caps', () => {
    const frame = {
      v: 1,
      type: 'message',
      requestId: randomUUID(),
      messageId: randomUUID(),
      senderInstanceId: randomUUID(),
      text: 'x'.repeat(MAX_MESSAGE_BYTES) + `\x1b]52;c;${'z'.repeat(2_000)}\x07`,
      summary: `ok\x1b]8;;https://evil.test${'z'.repeat(300)}\x1b\\`,
      sentAt: new Date().toISOString(),
      senderPermissionClass: 'prompted',
    } as const

    expect(parsePeerFrame(frame)).toMatchObject({ text: 'x'.repeat(MAX_MESSAGE_BYTES), summary: 'ok' })
  })

  it('sanitizes status reasons and protocol error text', () => {
    const requestId = randomUUID()
    const messageId = randomUUID()
    const reason = 'denied\x1b]52;c;Y2xpcGJvYXJk\x07\u202ereversed'
    expect(parsePeerFrame({ v: 1, type: 'ack', requestId, status: 'refused', reason })).toMatchObject({
      reason: 'deniedreversed',
    })
    expect(
      parsePeerFrame({
        v: 1,
        type: 'delivery-update',
        requestId,
        messageId,
        receiverInstanceId: randomUUID(),
        status: 'denied',
        reason,
      }),
    ).toMatchObject({ reason: 'deniedreversed' })
    expect(
      parsePeerFrame({ v: 1, type: 'delivery-update-ack', requestId, messageId, status: 'ignored', reason }),
    ).toMatchObject({ reason: 'deniedreversed' })
    expect(parsePeerFrame({ v: 1, type: 'error', code: `BAD\x07`, message: reason })).toMatchObject({
      code: 'BAD',
      message: 'deniedreversed',
    })
  })

  it('sanitizes a terminal sequence split across transport chunks', () => {
    const frame = {
      v: 1,
      type: 'message',
      requestId: randomUUID(),
      messageId: randomUUID(),
      senderInstanceId: randomUUID(),
      text: '前\x1b]52;c;Y2xpcGJvYXJk\x07后',
      sentAt: new Date().toISOString(),
      senderPermissionClass: 'prompted',
    } as const
    const encoded = Buffer.from(JSON.stringify(frame) + '\n', 'utf8')
    const escapeOffset = encoded.indexOf(Buffer.from('\\u001b', 'utf8'))
    expect(escapeOffset).toBeGreaterThan(0)
    const decoder = new NdjsonFrameDecoder()
    expect(decoder.push(encoded.subarray(0, escapeOffset + 3))).toEqual([])
    const frames = decoder.push(encoded.subarray(escapeOffset + 3))
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ type: 'message', text: '前后' })
  })

  it('preserves the approved outbound payload on the wire and sanitizes only at decode', () => {
    const frame = {
      v: 1,
      type: 'message',
      requestId: randomUUID(),
      messageId: randomUUID(),
      senderInstanceId: randomUUID(),
      text: 'approved\x1b[2Jpayload',
      sentAt: new Date().toISOString(),
      senderPermissionClass: 'prompted',
    } as const
    const encoded = encodePeerFrame(frame)
    expect(JSON.parse(encoded.toString('utf8')).text).toBe(frame.text)
    expect(new NdjsonFrameDecoder().push(encoded)[0]).toMatchObject({ text: 'approvedpayload' })
  })
})
