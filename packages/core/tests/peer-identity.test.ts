import { describe, expect, it } from 'vitest'

import { Buffer } from 'node:buffer'

import { createPeerIdentity, normalizePeerName, peerAddress } from '../src/peers/identity.js'
import { peerRegistrationPath, peerSocketPath } from '../src/peers/paths.js'

describe('peer identity', () => {
  it('creates a full UUID address, stable short display id, and 256-bit token', () => {
    const identity = createPeerIdentity({ name: 'frontend', now: () => new Date('2026-08-13T00:00:00.000Z') })
    expect(identity.instanceId).toMatch(/^[0-9a-f-]{36}$/)
    expect(identity.address).toBe(`peer:${identity.instanceId}`)
    expect(identity.shortId).toBe(identity.instanceId.slice(0, 8))
    expect(Buffer.from(identity.inboxToken, 'base64url')).toHaveLength(32)
    expect(identity).toMatchObject({ name: 'frontend', startedAt: '2026-08-13T00:00:00.000Z' })
  })

  it('derives a safe default name from the cwd and instance suffix', () => {
    const identity = createPeerIdentity({ cwd: '/repo/客户端@web' })
    expect(identity.name).toMatch(/^客户端-web-[0-9a-f]{4}$/)
  })

  it('accepts bounded Unicode names and rejects controls, paths, and protocol separators', () => {
    expect(normalizePeerName('  前端  alpha_1  ')).toBe('前端 alpha_1')
    for (const invalid of ['', 'a'.repeat(65), 'bad/name', 'bad\\name', 'peer:name', 'line\nbreak', 'bell\u0007']) {
      expect(() => normalizePeerName(invalid)).toThrow()
    }
  })

  it('never accepts a short id as a protocol address', () => {
    expect(() => peerAddress('deadbeef')).toThrow('UUID')
    expect(() => peerRegistrationPath('../../victim')).toThrow('UUID')
    expect(() => peerSocketPath('/tmp/safe', '../../victim')).toThrow('UUID')
  })
})
