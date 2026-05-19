// @x-code-cli/core — Per-server MCP client wrapper
//
// One McpClient instance == one server connection. The class hides the
// SDK's slightly awkward two-object setup (`new Client(...)` +
// `new XxxTransport(...)` + `client.connect(transport)`) behind one
// `connect()` method, owns transport teardown on `close()`, and exposes a
// narrow surface (listTools / callTool / listResources / readResource /
// close) that the registry actually needs.
//
// abortSignal threading: every server-bound RPC method takes an optional
// AbortSignal and forwards it via `RequestOptions.signal`. When the user
// hits Esc mid-tool-call the agent loop's signal aborts the SDK request,
// which closes the JSON-RPC future without killing the underlying
// connection — the next call can reuse the same transport.
import { type OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import { Stream } from 'node:stream'

import { debugLog } from '../utils.js'
import { VERSION } from '../version.js'
import { McpOAuthProvider } from './oauth/provider.js'
import {
  type McpCallResult,
  type McpResourceEntry,
  type McpServerConfig,
  isHttpConfig,
  isStdioConfig,
} from './types.js'

/** How many tail lines of stderr to keep around for diagnostics.
 *  When a stdio server dies on startup or fails mid-call, surfacing the
 *  last bit of its stderr in `/mcp list` is the difference between a
 *  meaningful error and a useless "exit code 1". */
const STDERR_TAIL_LINES = 20

const CLIENT_INFO = { name: 'x-code-cli', version: VERSION }

/** Default first-connect timeout (ms). Overridable per-server via the
 *  config's `timeout` field. 30s is generous — community stdio servers
 *  are usually up in 100-500ms; the budget is for slow npx installs on
 *  cold cache, not normal operation. */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000

export interface ConnectInfo {
  toolCount: number
  resourceCount: number
}

export class McpClient {
  /** SDK client. Only present after a successful connect. */
  private client: Client | null = null
  /** SDK transport. Owned by us so we can `close()` it cleanly. */
  private transport: Transport | null = null
  /** Rolling tail of stderr (stdio servers only). */
  private stderrTail: string[] = []
  /** Cached results from the last connect, served to the registry. */
  private cachedTools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> = []
  private cachedResources: McpResourceEntry[] = []

  constructor(
    public readonly serverName: string,
    private readonly config: McpServerConfig,
    /** Optional OAuth provider for HTTP servers. Stdio servers ignore this. */
    private readonly authProvider?: OAuthClientProvider,
  ) {}

  /** Spawn / dial the server and complete the MCP initialize handshake.
   *  On success, populates internal tool + resource caches. On failure,
   *  cleans up the transport (no zombie subprocess) and re-throws. */
  async connect(): Promise<ConnectInfo> {
    const timeout = this.config.timeout ?? DEFAULT_CONNECT_TIMEOUT_MS

    this.transport = this.buildTransport()
    this.client = new Client(CLIENT_INFO, { capabilities: {} })

    // SDK's connect() runs the initialize roundtrip and resolves once the
    // server has acknowledged. Race it against an explicit timer because
    // a stuck stdio child (e.g. npx hanging on registry fetch) wouldn't
    // surface as an error otherwise — it'd just sit there.
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    try {
      await this.client.connect(this.transport, { signal: ctrl.signal })
    } catch (err) {
      // UnauthorizedError is the expected throw during an OAuth flow:
      // the SDK has called redirectToAuthorization and now wants the
      // caller to finishAuth(code) on the SAME transport. If we tear
      // down here, runOAuthDance loses its handle and can't complete
      // the exchange. Leave transport + client alive; the caller
      // (runOAuthDance) or finally-shutdown path will clean up. For
      // any other error we still safeClose to avoid leaking a child
      // process / dangling HTTP connection.
      if (!isUnauthorizedError(err)) {
        await this.safeClose()
      }
      throw this.enrichError(err)
    } finally {
      clearTimeout(timer)
    }

    // Discover capabilities. Tools/resources are independent — a server
    // can offer one without the other — and we tolerate either listing
    // throwing (some servers reject `listResources` if they have none).
    try {
      const tools = await this.client.listTools()
      this.cachedTools = (tools.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
      }))
    } catch (err) {
      debugLog('mcp.listTools-failed', `${this.serverName}: ${String(err)}`)
      this.cachedTools = []
    }

    try {
      const resources = await this.client.listResources()
      this.cachedResources = (resources.resources ?? []).map((r) => ({
        uri: r.uri,
        name: r.name ?? r.uri,
        description: r.description,
        mimeType: r.mimeType,
        serverName: this.serverName,
      }))
    } catch (err) {
      debugLog('mcp.listResources-failed', `${this.serverName}: ${String(err)}`)
      this.cachedResources = []
    }

    return {
      toolCount: this.cachedTools.length,
      resourceCount: this.cachedResources.length,
    }
  }

  /** Tools discovered at connect time. Stable for the connection lifetime;
   *  refresh by calling connect() again on a fresh McpClient. */
  tools(): ReadonlyArray<{ name: string; description?: string; inputSchema: Record<string, unknown> }> {
    return this.cachedTools
  }

  resources(): ReadonlyArray<McpResourceEntry> {
    return this.cachedResources
  }

  /** Connect with a full interactive OAuth round-trip.
   *
   *  The MCP SDK's StreamableHTTP transport handles auth lazily: a fresh
   *  connect with no stored token calls `authProvider.redirectToAuthorization`
   *  and then throws `UnauthorizedError` because the token-exchange step
   *  has to wait for the user. The caller is expected to wait for the
   *  redirect callback to land, hand the authorization code to
   *  `transport.finishAuth(code)`, then retry connect — at which point
   *  tokens are saved and the next attempt succeeds.
   *
   *  We encapsulate that dance here so that the `/mcp auth` handler can
   *  opt into "drive OAuth to completion" without knowing about
   *  `finishAuth`. The default `connect()` path keeps the OAuth provider
   *  PASSIVE — `redirectToAuthorization` is a no-op until we flip
   *  `setInteractive(true)` here, so CLI boot doesn't accidentally pop a
   *  browser window for servers in `needs_auth`. */
  async connectWithOAuth(hooks: { onBrowserOpen?: (url: string) => void } = {}): Promise<ConnectInfo> {
    if (!this.authProvider) {
      throw new Error(`MCP server "${this.serverName}" has no OAuth provider configured`)
    }
    if (!(this.authProvider instanceof McpOAuthProvider)) {
      // Allow third-party providers but skip our `waitForAuthCode` hook —
      // they're expected to handle the flow themselves.
      return this.connect()
    }

    const provider = this.authProvider

    // Eagerly start the callback server so the real loopback port is
    // bound to `clientMetadata.redirect_uris` and `redirectUrl` BEFORE
    // the SDK builds the dynamic-registration request. Otherwise we
    // register with a port-less placeholder and Sentry (and any other
    // auth server that doesn't honour RFC 8252 §7.3 loopback any-port)
    // rejects the auth URL's real-port redirect_uri as "Invalid".
    await provider.prepareForAuth()

    // Tee the browser-open notification through the caller's hook so the
    // /mcp auth handler can print into the CLI scrollback alongside the
    // provider's own onOpenBrowser callback. We monkey-patch the method
    // for the lifetime of THIS call (try/finally restores it). The
    // provider doesn't expose an event API, but patching one method on
    // one instance for one flow is bounded enough to be safe.
    const originalRedirect = provider.redirectToAuthorization.bind(provider)
    if (hooks.onBrowserOpen) {
      provider.redirectToAuthorization = async (url: URL) => {
        try {
          hooks.onBrowserOpen?.(url.toString())
        } catch {
          // Hook failures must not abort the OAuth flow.
        }
        return originalRedirect(url)
      }
    }
    try {
      return await this.runOAuthDance()
    } finally {
      provider.setInteractive(false)
      if (hooks.onBrowserOpen) {
        provider.redirectToAuthorization = originalRedirect
      }
    }
  }

  /** The actual two-phase connect: attempt-1 fires redirect, then we
   *  wait for the user, finish the auth, attempt-2 lands a real
   *  session. Both attempts share `cachedTools` / `cachedResources`. */
  private async runOAuthDance(): Promise<ConnectInfo> {
    const provider = this.authProvider as McpOAuthProvider

    // First attempt: most likely throws UnauthorizedError after the
    // browser has been launched. If tokens were somehow already valid
    // (stale state on disk) this succeeds and we short-circuit out.
    try {
      return await this.connect()
    } catch (err) {
      // Anything that isn't "we need to wait for the user" propagates.
      if (!isUnauthorizedError(err)) {
        provider.cancel()
        throw err
      }
    }

    // The provider has already called redirectToAuthorization (the SDK
    // does that internally before throwing). Now wait for the user to
    // come back via the callback server, then complete the exchange.
    const { code } = await provider.waitForAuthCode()
    const transport = this.transport
    if (!(transport instanceof StreamableHTTPClientTransport)) {
      throw new Error(`Internal error: OAuth flow expected an HTTP transport for "${this.serverName}"`)
    }
    await transport.finishAuth(code)

    // Tokens are now saved. The first attempt left the client + transport
    // in a half-open state (the SDK's connect threw mid-handshake); we
    // need a clean transport for the retry, so close and rebuild. This
    // also means the SDK's initialize roundtrip happens against a fresh
    // socket, avoiding any "already connected" / state-leak surprises.
    await this.safeClose()
    return this.connect()
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    if (!this.client) throw new Error(`MCP server "${this.serverName}" is not connected`)
    const result = await this.client.callTool(
      { name, arguments: args as Record<string, unknown> | undefined },
      undefined,
      { signal },
    )
    return flattenCallResult(result)
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<{ text: string; mimeType?: string }> {
    if (!this.client) throw new Error(`MCP server "${this.serverName}" is not connected`)
    const result = await this.client.readResource({ uri }, { signal })
    // Resources return an array of content blocks; concatenate text
    // representations, preserving the first mimeType for the caller.
    const parts: string[] = []
    let mimeType: string | undefined
    for (const c of result.contents ?? []) {
      mimeType ??= (c as { mimeType?: string }).mimeType
      const text = (c as { text?: string }).text
      if (typeof text === 'string') parts.push(text)
      else if ((c as { blob?: string }).blob !== undefined) {
        parts.push(`[binary content omitted, mimeType=${mimeType ?? 'unknown'}]`)
      }
    }
    return { text: parts.join('\n'), mimeType }
  }

  /** Snapshot the last N stderr lines for diagnostics. Empty for HTTP. */
  stderr(): string {
    return this.stderrTail.join('\n')
  }

  async close(): Promise<void> {
    await this.safeClose()
  }

  // ── internals ──────────────────────────────────────────────────────────

  private buildTransport(): Transport {
    if (isStdioConfig(this.config)) {
      const t = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        env: this.config.env,
        cwd: this.config.cwd,
        // Pipe stderr so we can capture diagnostics. Default "inherit"
        // would dump the child's noise into the parent CLI's terminal,
        // scrambling our cell-buffer UI.
        stderr: 'pipe',
      })
      const stderr: Stream | null = t.stderr
      if (stderr) {
        stderr.on('data', (chunk: Buffer | string) => {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
          for (const line of text.split(/\r?\n/)) {
            if (!line) continue
            this.stderrTail.push(line)
            if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift()
          }
        })
      }
      return t
    }

    if (isHttpConfig(this.config)) {
      return new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: this.config.headers ? { headers: this.config.headers } : undefined,
        authProvider: this.authProvider,
      })
    }

    // Schema validation upstream should prevent this, but be defensive.
    throw new Error(`mcp server "${this.serverName}": unrecognised config shape`)
  }

  private async safeClose(): Promise<void> {
    // SDK's Client.close() also closes the transport. We try client first
    // because it sends a proper shutdown notification; falling back to
    // transport.close() if the client was never built (e.g. constructor
    // threw before assignment).
    try {
      if (this.client) {
        await this.client.close()
      } else if (this.transport) {
        await this.transport.close()
      }
    } catch (err) {
      debugLog('mcp.close-error', `${this.serverName}: ${String(err)}`)
    } finally {
      this.client = null
      this.transport = null
    }
  }

  /** Attach stderr tail (if any) to a connect error so /mcp list shows
   *  something more useful than "Connection closed". */
  private enrichError(err: unknown): Error {
    const base = err instanceof Error ? err : new Error(String(err))
    if (this.stderrTail.length === 0) return base
    const tail = this.stderrTail.slice(-5).join(' | ')
    const enriched = new Error(`${base.message} — stderr: ${tail}`)
    enriched.stack = base.stack
    return enriched
  }
}

/** Pattern-match an UnauthorizedError from the SDK without depending
 *  on instanceof (which can be fragile across bundling boundaries when
 *  the SDK is duplicated under different esm/cjs roots). The SDK exports
 *  the class directly though, so we use both checks. */
function isUnauthorizedError(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true
  if (err instanceof Error) {
    if (err.name === 'UnauthorizedError') return true
    if (/unauthorized|401/i.test(err.message)) return true
  }
  return false
}

/** Flatten MCP call result content blocks into a single string.
 *  MCP responses are an array of `{ type: "text" | "image" | ... }`
 *  blocks. For tool_result we only care about the text; images/audio are
 *  noted but not actually surfaced (the agent loop doesn't ingest images
 *  from tool results, only from user input). */
function flattenCallResult(result: unknown): McpCallResult {
  const r = result as { content?: Array<unknown>; isError?: boolean }
  const blocks = Array.isArray(r.content) ? r.content : []
  const parts: string[] = []
  for (const b of blocks) {
    const block = b as { type?: string; text?: string; data?: unknown; mimeType?: string }
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'image') {
      parts.push(`[image content omitted, mimeType=${block.mimeType ?? 'unknown'}]`)
    } else if (block.type === 'resource') {
      // Embedded resource — surface a one-line marker + any nested text.
      const nested = (block as { resource?: { text?: string; uri?: string } }).resource
      if (nested?.text) parts.push(nested.text)
      else if (nested?.uri) parts.push(`[resource: ${nested.uri}]`)
    } else if (block.type) {
      parts.push(`[${block.type} content]`)
    }
  }
  return {
    text: parts.join('\n').trim() || '(empty response)',
    isError: r.isError === true,
  }
}
