import {
  WINDOWS_PEER_BROKER_HEADER_BYTES,
  WINDOWS_PEER_BROKER_MAX_PAYLOAD_BYTES,
  WindowsPeerBrokerFrameDecoder,
  WindowsPeerBrokerFrameKind,
  decodeCancelAckPayload,
  decodeInboundRequestPayload,
  decodeOneStringPayload,
  decodeOperationErrorPayload,
  decodePeerFramePayload,
  encodeOutboundRequestPayload,
  encodePeerFramePayload,
  encodeStartServerPayload,
  encodeWindowsPeerBrokerFrame,
} from '../src/peers/windows-peer-broker-protocol.js'

function frame(kind = WindowsPeerBrokerFrameKind.OutboundResponse, payload = Buffer.from('payload')): Buffer {
  return encodeWindowsPeerBrokerFrame({ kind, operationId: 7, payload })
}

describe('Windows peer broker protocol', () => {
  it('decodes every fragmentation boundary and merged frames', () => {
    const encoded = frame()
    for (let split = 1; split < encoded.length; split++) {
      const decoder = new WindowsPeerBrokerFrameDecoder()
      expect(decoder.push(encoded.subarray(0, split))).toEqual([])
      expect(decoder.push(encoded.subarray(split))).toEqual([
        { kind: WindowsPeerBrokerFrameKind.OutboundResponse, operationId: 7, payload: Buffer.from('payload') },
      ])
      expect(() => decoder.finish()).not.toThrow()
    }

    const decoder = new WindowsPeerBrokerFrameDecoder()
    expect(decoder.push(Buffer.concat([encoded, encoded]))).toHaveLength(2)
  })

  it('rejects malformed headers, flags, versions, lengths, and truncated EOF', () => {
    const valid = frame()
    for (const mutate of [
      (bytes: Buffer) => (bytes[0] = 0),
      (bytes: Buffer) => (bytes[4] = 2),
      (bytes: Buffer) => (bytes[5] = 0x40),
      (bytes: Buffer) => (bytes[6] = 1),
      (bytes: Buffer) => bytes.writeUInt32LE(WINDOWS_PEER_BROKER_MAX_PAYLOAD_BYTES + 1, 12),
    ]) {
      const bytes = Buffer.from(valid)
      mutate(bytes)
      expect(() => new WindowsPeerBrokerFrameDecoder().push(bytes)).toThrow()
    }

    const decoder = new WindowsPeerBrokerFrameDecoder()
    decoder.push(valid.subarray(0, WINDOWS_PEER_BROKER_HEADER_BYTES - 1))
    expect(() => decoder.finish()).toThrow('Truncated')
  })

  it('locks the exact control payload boundary', () => {
    expect(() =>
      encodeWindowsPeerBrokerFrame({
        kind: WindowsPeerBrokerFrameKind.OutboundResponse,
        operationId: 1,
        payload: Buffer.alloc(WINDOWS_PEER_BROKER_MAX_PAYLOAD_BYTES),
      }),
    ).not.toThrow()
    expect(() =>
      encodeWindowsPeerBrokerFrame({
        kind: WindowsPeerBrokerFrameKind.OutboundResponse,
        operationId: 1,
        payload: Buffer.alloc(WINDOWS_PEER_BROKER_MAX_PAYLOAD_BYTES + 1),
      }),
    ).toThrow('payload limit')
  })

  it('encodes fixed payload layouts and rejects suffixes and invalid UTF-8', () => {
    const start = encodeStartServerPayload({
      namespaceId: '0123456789ab',
      instanceId: '12345678-1234-4234-8234-123456789abc',
      inboxToken: 'a'.repeat(43),
    })
    expect(start.readUInt16LE(0)).toBe(12)
    expect(start.subarray(2, 14).toString()).toBe('0123456789ab')

    const outbound = encodeOutboundRequestPayload({
      address: '\\\\.\\pipe\\x-code-peer-v1-0123456789ab-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      targetToken: 'b'.repeat(43),
      senderInstanceId: '12345678-1234-4234-8234-123456789abc',
      timeoutMs: 3_000,
      peerFrame: Buffer.from('{"v":1}\n'),
    })
    expect(outbound.length).toBeGreaterThan(100)

    const inbound = Buffer.concat([
      Buffer.from([36, 0]),
      Buffer.from('12345678-1234-4234-8234-123456789abc'),
      encodePeerFramePayload(Buffer.from('frame')),
    ])
    expect(decodeInboundRequestPayload(inbound)).toEqual({
      senderInstanceId: '12345678-1234-4234-8234-123456789abc',
      peerFrame: Buffer.from('frame'),
    })
    expect(decodePeerFramePayload(encodePeerFramePayload(Buffer.from('frame')))).toEqual(Buffer.from('frame'))
    expect(() => decodeOneStringPayload(Buffer.from([2, 0, 0xc3, 0x28]))).toThrow('UTF-8')
    expect(() => decodeOneStringPayload(Buffer.from([1, 0, 0x61, 0x00]))).toThrow('suffix')
  })

  it('decodes stable operation errors and cancel acknowledgements', () => {
    const errorPayload = Buffer.concat([
      Buffer.from([15, 0]),
      Buffer.from('PEER_TEST_ERROR'),
      Buffer.from([7, 0]),
      Buffer.from('failure'),
    ])
    expect(decodeOperationErrorPayload(errorPayload)).toEqual({ code: 'PEER_TEST_ERROR', message: 'failure' })
    expect(decodeCancelAckPayload(Buffer.from([0]))).toBe('canceled')
    expect(decodeCancelAckPayload(Buffer.from([1]))).toBe('too-late')
    expect(() => decodeCancelAckPayload(Buffer.from([2]))).toThrow('invalid cancel')
  })
})
