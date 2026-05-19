// @x-code-cli/core — Local OAuth callback receiver
//
// Spins up an ephemeral HTTP server on 127.0.0.1:<random-port>/callback,
// waits for the user's authorization-server redirect, returns the
// captured `code` + `state` (or error). Auto-closes after the first
// request (or on timeout).
//
// Why ephemeral & random-port:
//   - A fixed port collides if two CLIs run concurrently.
//   - Random ports require the OAuth provider to be told the URL after
//     the listener is up — we expose `start()` returning the actual URL
//     before resolving any callbacks.
//
// Security:
//   - Bound to 127.0.0.1 only, never 0.0.0.0 — the listener should not
//     be reachable from other machines.
//   - We only accept the first matching request; subsequent hits return
//     a friendly "auth complete, you can close this window" page.
//   - We do NOT validate `state` here — that's the SDK's job. We just
//     forward whatever the auth server sent back.
import http from 'node:http'
import { AddressInfo } from 'node:net'

import { debugLog } from '../../utils.js'

export interface CallbackResult {
  code: string
  state?: string
}

export interface RunningCallbackServer {
  /** The full redirect URL to advertise to the auth server. */
  url: string
  /** Resolves with the code/state on the first valid callback request,
   *  or rejects on timeout / OAuth error response. */
  waitForCallback: () => Promise<CallbackResult>
  /** Stop accepting new connections and free the port. Idempotent. */
  close: () => void
}

export interface StartOptions {
  /** Max time to wait (ms). Default 5 minutes. */
  timeoutMs?: number
  /** Path on which the auth server should redirect.
   *  Default '/callback'. */
  path?: string
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_PATH = '/callback'

/** Start the listener and return control to the caller so it can hand
 *  the URL to the auth provider. The actual waiting happens via the
 *  returned `waitForCallback()` promise. */
export async function startCallbackServer(options: StartOptions = {}): Promise<RunningCallbackServer> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const expectedPath = options.path ?? DEFAULT_PATH

  let resolveOnce: ((r: CallbackResult) => void) | null = null
  let rejectOnce: ((e: Error) => void) | null = null

  const waiter = new Promise<CallbackResult>((res, rej) => {
    resolveOnce = res
    rejectOnce = rej
  })

  const server = http.createServer((req, response) => {
    if (!req.url) {
      response.writeHead(400).end('missing URL')
      return
    }
    // Parse against a dummy base — we only care about pathname + search.
    const u = new URL(req.url, 'http://localhost')
    if (u.pathname !== expectedPath) {
      response.writeHead(404).end('not found')
      return
    }

    const err = u.searchParams.get('error')
    if (err) {
      const desc = u.searchParams.get('error_description') ?? ''
      response
        .writeHead(400, { 'Content-Type': 'text/html' })
        .end(`<html><body><h1>Authorization failed</h1><p>${escapeHtml(err)}: ${escapeHtml(desc)}</p></body></html>`)
      rejectOnce?.(new Error(`OAuth callback error: ${err} ${desc}`.trim()))
      resolveOnce = null
      rejectOnce = null
      return
    }

    const code = u.searchParams.get('code')
    if (!code) {
      response.writeHead(400).end('missing code')
      rejectOnce?.(new Error('OAuth callback missing `code` parameter'))
      resolveOnce = null
      rejectOnce = null
      return
    }

    const state = u.searchParams.get('state') ?? undefined
    response
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(
        `<html><body style="font-family:system-ui;padding:2rem;max-width:40rem;margin:auto;">` +
          `<h1>Authorization complete</h1>` +
          `<p>You can close this tab and return to the X-Code CLI.</p>` +
          `</body></html>`,
      )
    resolveOnce?.({ code, state })
    resolveOnce = null
    rejectOnce = null
  })

  // Watch for socket errors so a connection reset doesn't crash the
  // CLI on Windows where ECONNRESET is more common.
  server.on('error', (err) => {
    debugLog('mcp.callback-server-error', String(err))
    rejectOnce?.(err)
    resolveOnce = null
    rejectOnce = null
  })

  // Bind to ephemeral port. listen(0, '127.0.0.1') asks the OS for any
  // free port; the actual one comes out of address().
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const addr = server.address() as AddressInfo
  const url = `http://127.0.0.1:${addr.port}${expectedPath}`

  const timeoutHandle = setTimeout(() => {
    rejectOnce?.(new Error(`OAuth callback timed out after ${timeoutMs}ms`))
    resolveOnce = null
    rejectOnce = null
  }, timeoutMs)
  // Clear the timer on either resolution path.
  void waiter.finally(() => clearTimeout(timeoutHandle))

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    server.close()
  }
  // Auto-close once we've handled the (single) callback.
  void waiter.finally(close)

  return { url, waitForCallback: () => waiter, close }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}
