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
  /** Whether `redirectToAuthorization` should actually launch a browser.
   *  Default false — booting the CLI with an HTTP MCP server that has
   *  no stored token must NOT silently open a browser window. The flag
   *  is flipped on for the duration of `connectWithOAuth` (driven by
   *  `/mcp auth <name>`) and back off in `finally`. */
  private interactive = false

  constructor(private readonly opts: CreateProviderOptions) {}

  /** Caller (client.ts:connectWithOAuth) toggles this around an
   *  authenticated dance. Outside that window we stay passive. */
  setInteractive(value: boolean): void {
    this.interactive = value
  }

  /** Eagerly start the callback server, so the real loopback port is
   *  available to `redirectUrl` and `clientMetadata.redirect_uris`
   *  BEFORE the SDK constructs the dynamic-registration request.
   *
   *  Why this matters: Sentry (and any auth server that doesn't follow
   *  RFC 8252 §7.3 strictly) validates the auth-URL `redirect_uri` against
   *  the value the client registered with. If we register with the
   *  port-less placeholder and then redirect to a concrete port, the
   *  server replies "Invalid redirect URI" and the whole flow dies.
   *  Pre-starting the server ensures registration and authorization use
   *  the SAME concrete `http://127.0.0.1:<port>/callback`. */
  async prepareForAuth(): Promise<void> {
    this.interactive = true
    await this.ensureCallbackServer()
  }

  // ── OAuthClientProvider ────────────────────────────────────────────────

  get redirectUrl(): string {
    // The SDK actually reads `redirectUrl` BEFORE `redirectToAuthorization`
    // fires (e.g. while constructing the authorize URL during the very
    // first connect attempt with no stored token). An earlier version
    // threw here, which surfaced HTTP servers as `failed` instead of the
    // intended `needs_auth` on the first launch after `/mcp add`.
    //
    // We return the same loopback placeholder `clientMetadata.redirect_uris`
    // already uses. RFC 8252 §7.3 says authorisation servers MUST accept any
    // port on a registered loopback redirect_uri, so the placeholder being
    // port-less is fine for the registration roundtrip; `redirectToAuthorization`
    // rewrites the actual `redirect_uri` query param with the real port
    // right before launching the browser.
    return this.callbackServer?.url ?? 'http://127.0.0.1/callback'
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
    // Passive (boot) mode: the SDK is in the middle of a "lazy" first
    // connect with no stored token. We must NOT open a browser window
    // unprompted — every other MCP-aware CLI (Claude Code, Gemini,
    // OpenCode) waits for explicit user action before doing that, and
    // a CLI start-up that hijacks the user's browser is a hostile
    // surprise. Returning here is enough: the SDK will throw
    // UnauthorizedError next, the registry classifies it as
    // `needs_auth`, and `/mcp auth <name>` can drive the real flow
    // (after setInteractive(true) flips us into the interactive path
    // below).
    if (!this.interactive) {
      return
    }

    // Lazy-start the callback server right before we hand the auth URL
    // to the browser, so the URL we advertise (via `redirectUrl`)
    // matches what we'll listen on. We rebuild the auth URL with the
    // updated redirect_uri reflecting our actual port.
    await this.ensureCallbackServer()
    authorizationUrl.searchParams.set('redirect_uri', this.callbackServer!.url)

    this.opts.onOpenBrowser?.(authorizationUrl.toString())
    await openInBrowser(authorizationUrl.toString())

    // Stash the pending callback so the caller can `await` it through
    // `waitForAuthCode()` while the transport machinery handles the
    // token-exchange step.
    this.pendingCode = this.callbackServer!.waitForCallback()
  }

  // ── Helpers used by /mcp auth handler ─────────────────────────────────

  /** Block until the auth server has redirected back. Resolves with the
   *  captured code; the caller then calls `transport.finishAuth(code)`
   *  on the SDK's StreamableHTTPClientTransport.
   *
   *  We close the callback server here because we already have the code
   *  — Sentry won't call us back again on this flow. But we leave
   *  `memoryCodeVerifier` alive: the SDK reads it during
   *  `transport.finishAuth(code)`, which the caller runs AFTER this
   *  promise resolves. Nulling the verifier in this finally block was
   *  the cause of "No PKCE verifier set — auth flow not in progress".
   *  Cleanup of the verifier happens either via `cancel()` (abort
   *  path) or naturally on the next `saveCodeVerifier(...)` call. */
  async waitForAuthCode(): Promise<{ code: string; state?: string }> {
    if (!this.pendingCode) {
      throw new Error('Auth flow not started — redirectToAuthorization was never invoked')
    }
    try {
      return await this.pendingCode
    } finally {
      this.pendingCode = null
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
async function openInBrowser(url: string): Promise<void> {
  try {
    if (process.platform === 'win32') {
      // We deliberately AVOID `cmd /c start` here. cmd.exe treats `&`
      // as a command separator, so an OAuth URL like
      //   https://x.com/auth?response_type=code&client_id=abc&code_challenge=...
      // got silently truncated to `https://x.com/auth?response_type=code`
      // — the user's browser landed on a URL with no client_id /
      // redirect_uri / PKCE challenge and Sentry replied "Invalid
      // redirect URI". Node's argv quoting doesn't quote `&` (it's not
      // a Windows-native special char, only a cmd-builtin special char)
      // so even passing the URL as a separate arg didn't save us.
      //
      // `rundll32 url.dll,FileProtocolHandler <url>` is the documented
      // Win32 way to invoke the default browser's protocol handler.
      // It bypasses cmd entirely, so `&` passes through verbatim.
      spawnDetached('rundll32', ['url.dll,FileProtocolHandler', url])
      return
    }
    if (process.platform === 'darwin') {
      // macOS `open` is rock-solid for URLs, no quirks.
      spawnDetached('open', [url])
      return
    }

    // Linux / *BSD: no single command works everywhere. xdg-utils
    // (`xdg-open`) is the de-facto standard but missing on minimal
    // containers and many server distros; `gio open` covers newer
    // GNOME stacks; `wslview` covers WSL → Windows browser (when
    // xdg-open inside WSL doesn't reach the host); `kde-open` and
    // `gnome-open` cover their respective legacy desktops.
    //
    // We try each in turn, falling through on ENOENT or non-zero exit.
    // Failing silently with no opener would leave the user staring at
    // the CLI scrollback wondering why nothing happened — we surface a
    // `mcp.browser-open-no-opener` debug entry so the situation is at
    // least diagnosable, and the CLI's "Opened …" line already gave
    // them the URL to copy/paste by hand.
    const candidates: Array<[string, string[]]> = [
      ['xdg-open', [url]],
      ['gio', ['open', url]],
      ['wslview', [url]],
      ['kde-open', [url]],
      ['gnome-open', [url]],
    ]
    for (const [cmd, args] of candidates) {
      if (await trySpawnOpener(cmd, args)) return
    }
    debugLog('mcp.browser-open-no-opener', `no working URL opener found; advised user to copy/paste manually`)
  } catch (err) {
    debugLog('mcp.browser-open-threw', String(err))
  }
}

/** Fire a child process, detach, walk away. Used on Windows/macOS where
 *  the command is known-good — failure-detection is just a debug log. */
function spawnDetached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
  child.unref()
  child.on('error', (err) => debugLog('mcp.browser-open-failed', String(err)))
}

/** Try one Linux URL opener candidate. Resolves true if the binary
 *  exists and either exited cleanly OR is still alive after a brief
 *  grace window (most openers exec into a browser and exit ~immediately,
 *  but a few — notably wslview on cold start — fork and stay running for
 *  a moment). Resolves false on ENOENT or non-zero exit, signalling the
 *  caller to try the next candidate. */
function trySpawnOpener(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    } catch {
      settle(false)
      return
    }
    child.on('error', () => settle(false))
    child.on('exit', (code) => {
      if (code === 0) {
        child.unref()
        settle(true)
      } else {
        settle(false)
      }
    })
    // Grace window for openers that fork-and-stay-alive. 500 ms is well
    // under any user-perceptible delay yet covers the slowest reasonable
    // launch path; anything still alive at this point is almost certainly
    // the real browser-launching process.
    setTimeout(() => {
      if (!settled) {
        child.unref()
        settle(true)
      }
    }, 500)
  })
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
