import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { validateFetchUrl, webFetch } from '../src/tools/web-fetch.js'

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

// Mocked-fetch tests for the redirect handling. Cross-host redirects MUST
// be stopped — without this, validateFetchUrl's SSRF guard is trivially
// bypassed by a public site returning 302 → http://10.0.0.5.
describe('webFetch redirect handling', () => {
  const realFetch = globalThis.fetch
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function htmlResponse(body = '<html><body>ok</body></html>') {
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
  }
  function redirectResponse(location: string, status = 302) {
    return new Response(null, { status, headers: { location } })
  }

  const ctx = { toolCallId: 't', messages: [], abortSignal: undefined as unknown as AbortSignal }

  // Note: webFetch has a 15-min in-memory LRU cache keyed by URL — use a
  // unique URL per test so a prior test's cached result doesn't short-
  // circuit the fetch and make assertions count zero.
  it('follows same-host redirects transparently (www <-> non-www counted as same)', async () => {
    fetchMock
      .mockResolvedValueOnce(redirectResponse('https://www.example.com/page'))
      .mockResolvedValueOnce(htmlResponse('<html><body><p>final-content</p></body></html>'))

    const result = (await webFetch.execute!({ url: 'https://example.com/sameredirect' }, ctx)) as string
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result).not.toContain('REDIRECT DETECTED')
    expect(result).toContain('final-content')
  })

  it('stops on cross-host redirect and tells the model the new URL', async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse('https://attacker.example.org/landing'))

    const result = (await webFetch.execute!({ url: 'https://safe.example.com/crosstest' }, ctx)) as string
    expect(fetchMock).toHaveBeenCalledTimes(1) // did NOT chase the cross-host hop
    expect(result).toContain('REDIRECT DETECTED')
    expect(result).toContain('attacker.example.org')
    expect(result).toContain('webFetch again')
  })

  it('does not silently fetch the cross-host target body', async () => {
    // Two responses queued: the redirect, and (if we wrongly chased it)
    // a body that should NEVER appear in our result.
    fetchMock
      .mockResolvedValueOnce(redirectResponse('https://internal.example.org/secret'))
      .mockResolvedValueOnce(htmlResponse('<html><body>SECRET-CONTENT-SHOULD-NOT-LEAK</body></html>'))

    const result = (await webFetch.execute!({ url: 'https://entry.example.com/follow' }, ctx)) as string
    expect(fetchMock).toHaveBeenCalledTimes(1) // only the initial fetch
    expect(result).not.toContain('SECRET-CONTENT-SHOULD-NOT-LEAK')
    expect(result).toContain('REDIRECT DETECTED')
  })

  it('stops after MAX_REDIRECTS to prevent loops', async () => {
    for (let i = 0; i < 12; i++) {
      fetchMock.mockResolvedValueOnce(redirectResponse(`https://loophost.example.com/hop-${i}`))
    }
    const result = (await webFetch.execute!({ url: 'https://loophost.example.com/start' }, ctx)) as string
    expect(result).toMatch(/too many redirects/i)
  })
})
