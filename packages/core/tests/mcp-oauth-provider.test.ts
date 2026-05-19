import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import os from 'node:os'
import path from 'node:path'

import { McpOAuthProvider } from '../src/mcp/oauth/provider.js'
import { McpTokenStorage } from '../src/mcp/oauth/token-storage.js'

/** Isolate the test from the developer's real ~/.x-code/mcp-auth.json. */
function isolate(): string {
  const dir = path.join(os.tmpdir(), 'mcp-oauth-test-' + Math.random().toString(36).slice(2))
  process.env.X_CODE_HOME = dir
  return dir
}

function makeProvider(): McpOAuthProvider {
  return new McpOAuthProvider({
    serverName: 'test-server',
    serverUrl: 'https://example.com/mcp',
    storage: new McpTokenStorage(),
  })
}

describe('McpOAuthProvider.redirectUrl', () => {
  beforeEach(() => {
    isolate()
  })
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('returns a loopback placeholder when no callback server is running', () => {
    // Regression: a previous version threw here, which surfaced HTTP MCP
    // servers as `failed` instead of `needs_auth` on first boot (the SDK
    // reads redirectUrl while constructing the authorize URL, BEFORE
    // redirectToAuthorization fires and starts the callback server).
    const provider = makeProvider()
    const url = provider.redirectUrl
    expect(typeof url).toBe('string')
    // Must be a loopback URL — per RFC 8252 the auth server must accept
    // any port on this host, so the lack of a concrete port is fine.
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1/)
  })

  it('keeps clientMetadata.redirect_uris consistent with redirectUrl', () => {
    // The placeholder used by both getters must agree, otherwise the
    // dynamic-registration request includes one URL and the SDK builds
    // the authorize URL with a different one — auth server returns
    // redirect_uri_mismatch.
    const provider = makeProvider()
    expect(provider.clientMetadata.redirect_uris).toContain(provider.redirectUrl)
  })
})

describe('McpOAuthProvider.redirectToAuthorization (passive vs interactive)', () => {
  beforeEach(() => {
    isolate()
  })
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('does NOT open a browser by default (passive mode)', async () => {
    // Regression: a previous version unconditionally opened the browser
    // here, which fired on CLI boot whenever an HTTP MCP server had no
    // stored token. No competing CLI does that — they all wait for an
    // explicit user action. We verify by checking that no callback
    // server got started and no onOpenBrowser hook fired.
    let opened: string | null = null
    const provider = new McpOAuthProvider({
      serverName: 'test-server',
      serverUrl: 'https://example.com/mcp',
      storage: new McpTokenStorage(),
      onOpenBrowser: (url) => {
        opened = url
      },
    })

    const before = provider.redirectUrl
    await provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'))
    const after = provider.redirectUrl

    expect(opened).toBeNull()
    // Same placeholder before AND after — the callback server was never
    // started, so the URL didn't change to include a real port.
    expect(after).toBe(before)
  })

  // We deliberately don't test the interactive (setInteractive(true))
  // path here. That path calls openInBrowser → child_process.spawn,
  // which would actually launch the developer's browser every time
  // `pnpm test` runs. The interactive flow is covered by manual /mcp
  // auth testing + the existing connectWithOAuth wiring.
})
