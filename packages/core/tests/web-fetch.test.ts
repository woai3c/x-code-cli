import { describe, expect, it, vi } from 'vitest'

import { doFetch, validateFetchUrl, validateResolvedAddress } from '../src/tools/web-fetch.js'

describe('validateFetchUrl — SSRF protection', () => {
  it('allows normal public URLs', () => {
    expect(validateFetchUrl('https://example.com')).toBeNull()
    expect(validateFetchUrl('https://docs.github.com/en/rest')).toBeNull()
    expect(validateFetchUrl('http://www.example.org/path?q=1')).toBeNull()
  })

  it('rejects non-HTTP protocols', () => {
    expect(validateFetchUrl('file:///etc/passwd')).toContain('Unsupported protocol')
    expect(validateFetchUrl('ftp://files.example.com')).toContain('Unsupported protocol')
    expect(validateFetchUrl('javascript:alert(1)')).not.toBeNull()
  })

  it('rejects URLs with embedded credentials', () => {
    expect(validateFetchUrl('https://user:pass@example.com')).toContain('credentials')
    expect(validateFetchUrl('https://admin@example.com')).toContain('credentials')
  })

  it('rejects single-segment hostnames (localhost, bare names)', () => {
    expect(validateFetchUrl('http://localhost/admin')).toContain('not a public domain')
    expect(validateFetchUrl('http://intranet/secret')).toContain('not a public domain')
  })

  it('rejects private/loopback IPv4', () => {
    expect(validateFetchUrl('http://127.0.0.1/')).toContain('blocked for security')
    expect(validateFetchUrl('http://127.0.0.99/')).toContain('blocked for security')
    expect(validateFetchUrl('http://10.0.0.1/')).toContain('blocked for security')
    expect(validateFetchUrl('http://192.168.1.1/')).toContain('blocked for security')
    expect(validateFetchUrl('http://172.16.0.1/')).toContain('blocked for security')
    expect(validateFetchUrl('http://172.31.255.255/')).toContain('blocked for security')
  })

  it('rejects link-local / metadata IP (169.254.x.x)', () => {
    expect(validateFetchUrl('http://169.254.169.254/latest/meta-data/')).toContain('blocked for security')
  })

  it('rejects 0.x.x.x range', () => {
    expect(validateFetchUrl('http://0.0.0.0/')).toContain('blocked for security')
  })

  it('rejects a literal fake-IP benchmarking address', () => {
    expect(validateFetchUrl('https://198.18.1.86/')).toContain('blocked for security')
    expect(validateFetchUrl('https://198.19.255.255/')).toContain('blocked for security')
  })

  it('rejects .local and .internal suffixes', () => {
    expect(validateFetchUrl('http://myhost.local/api')).toContain('blocked for security')
    expect(validateFetchUrl('http://service.internal/health')).toContain('blocked for security')
  })

  it('rejects URLs exceeding length limit', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2000)
    expect(validateFetchUrl(longUrl)).toContain('character limit')
  })

  it('rejects invalid URLs', () => {
    expect(validateFetchUrl('not a url at all')).toContain('Invalid URL')
    expect(validateFetchUrl('')).not.toBeNull()
  })

  it('allows public IPs that are not in private ranges', () => {
    expect(validateFetchUrl('http://8.8.8.8/')).toBeNull()
    expect(validateFetchUrl('http://1.1.1.1/')).toBeNull()
    expect(validateFetchUrl('http://172.15.0.1/')).toBeNull()
    expect(validateFetchUrl('http://172.32.0.1/')).toBeNull()
  })
})

describe('webFetch DNS validation', () => {
  it('allows proxy fake-IP addresses only for a hostname on the HTTPS fallback', () => {
    expect(() => validateResolvedAddress('example.com', '198.18.1.86', 4, true)).not.toThrow()
    expect(() => validateResolvedAddress('198.18.1.86', '198.18.1.86', 4, true)).toThrow(/disallowed IP/)
    expect(() => validateResolvedAddress('example.com', '198.18.1.86', 4, false)).toThrow(/disallowed IP/)
  })

  it('continues to reject private DNS answers while fake-IP compatibility is active', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1']) {
      expect(() => validateResolvedAddress('example.com', address, 4, true), address).toThrow(/disallowed IP/)
    }
  })

  it('allows ordinary public DNS answers', () => {
    expect(() => validateResolvedAddress('example.com', '93.184.216.34', 4)).not.toThrow()
    expect(() => validateResolvedAddress('example.com', '2606:4700:4700::1111', 6)).not.toThrow()
  })
})

describe('webFetch redirect validation', () => {
  it('blocks a public URL that redirects to a private address', async () => {
    const mockFetch = vi.fn(async () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1/admin' },
        }),
      ),
    )

    await expect(doFetch('https://example.com/start', 'x-code-cli/test', undefined, mockFetch)).rejects.toThrow(
      /private|blocked|invalid|not allowed/i,
    )
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('propagates cancellation to the active request', async () => {
    const controller = new AbortController()
    const mockFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }),
    )

    const pending = doFetch('https://example.com/slow', 'x-code-cli/test', controller.signal, mockFetch)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
