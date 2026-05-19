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
