import { describe, expect, it } from 'vitest'

import { validateFetchUrl } from '../src/tools/web-fetch.js'

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
