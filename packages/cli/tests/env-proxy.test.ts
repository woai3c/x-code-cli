import { describe, expect, it, vi } from 'vitest'

import { installEnvProxy, resolveEnvProxyOptions } from '../src/network/proxy.js'

const LOOPBACK = 'localhost,127.0.0.1,::1'

describe('resolveEnvProxyOptions', () => {
  it('returns null when no proxy variable is set', () => {
    expect(resolveEnvProxyOptions({})).toBeNull()
  })

  it('treats blank values as unset', () => {
    expect(resolveEnvProxyOptions({ HTTPS_PROXY: '  ', HTTP_PROXY: '' })).toBeNull()
  })

  it('reads HTTPS_PROXY and defaults NO_PROXY to loopback bypass', () => {
    expect(resolveEnvProxyOptions({ HTTPS_PROXY: 'http://127.0.0.1:7897' })).toEqual({
      httpsProxy: 'http://127.0.0.1:7897',
      noProxy: LOOPBACK,
    })
  })

  it('accepts the bare host:port form users copy from proxy clients', () => {
    expect(resolveEnvProxyOptions({ HTTPS_PROXY: '127.0.0.1:7897' })?.httpsProxy).toBe('http://127.0.0.1:7897')
  })

  it('prefers the uppercase variable when both spellings exist', () => {
    expect(resolveEnvProxyOptions({ HTTPS_PROXY: 'http://upper:1', https_proxy: 'http://lower:2' })?.httpsProxy).toBe(
      'http://upper:1',
    )
  })

  it('maps ALL_PROXY onto both schemes', () => {
    expect(resolveEnvProxyOptions({ ALL_PROXY: 'socks5://127.0.0.1:1080' })).toEqual({
      httpProxy: 'socks5://127.0.0.1:1080',
      httpsProxy: 'socks5://127.0.0.1:1080',
      noProxy: LOOPBACK,
    })
  })

  it('keeps a user NO_PROXY list ahead of the loopback bypass', () => {
    expect(resolveEnvProxyOptions({ HTTPS_PROXY: 'http://proxy:1', NO_PROXY: 'internal.example' })?.noProxy).toBe(
      `internal.example,${LOOPBACK}`,
    )
  })
})

describe('installEnvProxy', () => {
  it('does not touch the global dispatcher without proxy configuration', () => {
    const apply = vi.fn()

    expect(installEnvProxy({}, apply)).toBe(false)
    expect(apply).not.toHaveBeenCalled()
  })

  it('applies the resolved options once when a proxy is configured', () => {
    const apply = vi.fn()

    expect(installEnvProxy({ HTTPS_PROXY: 'http://127.0.0.1:7897' }, apply)).toBe(true)
    expect(apply).toHaveBeenCalledWith({ httpsProxy: 'http://127.0.0.1:7897', noProxy: LOOPBACK })
    expect(apply).toHaveBeenCalledTimes(1)
  })
})
