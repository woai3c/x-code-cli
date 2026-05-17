// @x-code-cli/core — OAuthClientProvider implementation
//
// Hooks the MCP SDK's auth flow up to our persistence + UX:
//
//   - tokens()                 — read from McpTokenStorage
//   - saveTokens()             — write to McpTokenStorage
//   - clientInformation()      — read from McpTokenStorage
//   - saveClientInformation()  — write to McpTokenStorage (covers
//                                RFC 7591 dynamic registration result)
//   - codeVerifier() / save    — kept in-process memory; PKCE verifier
//                                is single-use per auth flow
//   - redirectUrl              — set to a freshly-started local
//                                callback server's URL
//   - redirectToAuthorization  — open the URL in the user's browser
//
// One instance per server. Built lazily by the factory in loader.ts.
//
// External browser launcher: we use `node:child_process` to spawn the
// platform-default opener (`start` on Windows, `open` on macOS,
// `xdg-open` on Linux). No npm dep — the cross-platform `open` package
// is nice but pulls in another 200KB.
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

import { spawn } from 'node:child_process'

import { debugLog } from '../../utils.js'
import { type RunningCallbackServer, startCallbackServer } from './callback-server.js'
import { McpTokenStorage } from './token-storage.js'

const CLIENT_METADATA_BASE: Omit<OAuthClientMetadata, 'redirect_uris'> = {
  client_name: 'X-Code CLI',
  client_uri: 'https://github.com/woai3c/x-code-cli',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
}

export interface CreateProviderOptions {
  serverName: string
  serverUrl: string
  storage: McpTokenStorage
  /** Callback that should be invoked just before the browser opens,
   *  e.g. to print "Opening browser for sentry auth..." to the CLI UI. */
  onOpenBrowser?: (url: string) => void
}

/** Concrete provider, wired up to fetched persisted state + a callback
 *  server that gets started on demand. Reused across multiple connect /
 *  refresh attempts for the same server. */
export class McpOAuthProvider implements OAuthClientProvider {
  /** Currently-running callback server. We keep a handle so a second
   *  call to redirectToAuthorization (after a failed first attempt)
   *  reuses the same port instead of opening another listener. */
  private callbackServer: RunningCallbackServer | null = null
  /** PKCE verifier — kept in memory only, replaced on each new flow. */
  private memoryCodeVerifier: string | null = null
  /** Pending callback that the SDK will consume via `finishAuth` on
   *  the transport. Caller of `waitForAuthCode()` retrieves it. */
  private pendingCode: Promise<{ code: string; state?: string }> | null = null

  constructor(private readonly opts: CreateProviderOptions) {}

  // ── OAuthClientProvider ────────────────────────────────────────────────

  get redirectUrl(): string {
    // Caller MUST call ensureCallbackServer() before this getter is
    // first used by the SDK. The SDK calls `redirectUrl` after
    // `redirectToAuthorization` has been invoked (per its own flow),
    // so the practical ordering holds.
    if (!this.callbackServer) {
      throw new Error('Callback server not started — redirectToAuthorization must be called first')
    }
    return this.callbackServer.url
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      ...CLIENT_METADATA_BASE,
      // Filled in by redirectToAuthorization once the server is up.
      // Until then the SDK may inspect this object during dynamic
      // registration — we use a placeholder; the SDK will overwrite
      // the registration response anyway.
      redirect_uris: [this.callbackServer?.url ?? 'http://127.0.0.1/callback'],
    }
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const stored = await this.opts.storage.get(this.opts.serverName)
    return stored?.clientInformation
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.opts.storage.setClientInformation(this.opts.serverName, this.opts.serverUrl, info)
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const stored = await this.opts.storage.get(this.opts.serverName)
    return stored?.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.opts.storage.setTokens(this.opts.serverName, this.opts.serverUrl, tokens)
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.memoryCodeVerifier = codeVerifier
  }

  codeVerifier(): string {
    if (!this.memoryCodeVerifier) {
      throw new Error('No PKCE verifier set — auth flow not in progress')
    }
    return this.memoryCodeVerifier
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Lazy-start the callback server right before we hand the auth URL
    // to the browser, so the URL we advertise (via `redirectUrl`)
    // matches what we'll listen on. We rebuild the auth URL with the
    // updated redirect_uri reflecting our actual port.
    await this.ensureCallbackServer()
    authorizationUrl.searchParams.set('redirect_uri', this.callbackServer!.url)

    this.opts.onOpenBrowser?.(authorizationUrl.toString())
    openInBrowser(authorizationUrl.toString())

    // Stash the pending callback so the caller can `await` it through
    // `waitForAuthCode()` while the transport machinery handles the
    // token-exchange step.
    this.pendingCode = this.callbackServer!.waitForCallback()
  }

  // ── Helpers used by /mcp auth handler ─────────────────────────────────

  /** Block until the auth server has redirected back. Resolves with the
   *  captured code; the caller then calls `transport.finishAuth(code)`
   *  on the SDK's StreamableHTTPClientTransport. */
  async waitForAuthCode(): Promise<{ code: string; state?: string }> {
    if (!this.pendingCode) {
      throw new Error('Auth flow not started — redirectToAuthorization was never invoked')
    }
    try {
      return await this.pendingCode
    } finally {
      this.pendingCode = null
      this.memoryCodeVerifier = null
      this.callbackServer?.close()
      this.callbackServer = null
    }
  }

  /** Drop any in-progress flow without saving. Safe to call any time. */
  cancel(): void {
    this.callbackServer?.close()
    this.callbackServer = null
    this.pendingCode = null
    this.memoryCodeVerifier = null
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async ensureCallbackServer(): Promise<void> {
    if (this.callbackServer) return
    this.callbackServer = await startCallbackServer()
  }
}

/** Best-effort cross-platform `open <url>`. Detached so the CLI doesn't
 *  block on the browser process; stdio piped to /dev/null so output
 *  doesn't smear into our terminal UI. Failures are logged but never
 *  thrown — the user can still copy/paste the URL by hand. */
function openInBrowser(url: string): void {
  try {
    let cmd: string
    let args: string[]
    if (process.platform === 'win32') {
      // `start` is a cmd builtin, so we go via cmd /c.
      cmd = 'cmd'
      // Empty "" arg is the window title — `start "title" "url"` so
      // a URL containing spaces (rare but possible in test contexts)
      // isn't interpreted as the title.
      args = ['/c', 'start', '""', url]
    } else if (process.platform === 'darwin') {
      cmd = 'open'
      args = [url]
    } else {
      cmd = 'xdg-open'
      args = [url]
    }
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.unref()
    child.on('error', (err) => debugLog('mcp.browser-open-failed', String(err)))
  } catch (err) {
    debugLog('mcp.browser-open-threw', String(err))
  }
}

/** Factory used by loader.ts. Returns undefined for stdio servers — the
 *  loader skips OAuth construction for those. */
export function createOAuthProviderFactory(
  storage: McpTokenStorage,
  onOpenBrowser?: (serverName: string, url: string) => void,
) {
  return (serverName: string, serverUrl: string): McpOAuthProvider => {
    return new McpOAuthProvider({
      serverName,
      serverUrl,
      storage,
      onOpenBrowser: onOpenBrowser ? (url) => onOpenBrowser(serverName, url) : undefined,
    })
  }
}
