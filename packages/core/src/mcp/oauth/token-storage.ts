// @x-code-cli/core — Per-server OAuth token + client info persistence
//
// One file: ~/.x-code/mcp-auth.json
//
//   {
//     "sentry": {
//       "url": "https://mcp.sentry.dev",
//       "clientInformation": { client_id: "...", client_secret: "...", ... },
//       "tokens":            { access_token: "...", refresh_token: "...", expires_in: 3600, ... }
//     },
//     ...
//   }
//
// Permissions: 0o600 (owner read/write only) on POSIX; on Windows the
// mode bits are ignored but the file lives under the user profile so
// other-user reach is bounded by OS ACLs. Atomic writes (tmp + rename)
// so a crash mid-write can't corrupt previously-good tokens.
//
// The SDK's `OAuthClientProvider` interface (see ../oauth/provider.ts)
// is the actual consumer — this module is the bare persistence layer.
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

import fs from 'node:fs/promises'
import path from 'node:path'

import { debugLog, userXcodeDir } from '../../utils.js'

function authFile(): string {
  return path.join(userXcodeDir(), 'mcp-auth.json')
}

export interface StoredServerAuth {
  /** Server URL — recorded so we can detect "this stored token belongs
   *  to a different deployment" if the user repoints config later. */
  url: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  /** UTC ISO timestamp when the most recent tokens were obtained. Used
   *  to compute expiry locally because OAuth `expires_in` is relative
   *  to issuance, not absolute. */
  tokensIssuedAt?: string
}

type FileShape = Record<string, StoredServerAuth>

export class McpTokenStorage {
  private cache: FileShape | null = null

  async get(serverName: string): Promise<StoredServerAuth | undefined> {
    await this.ensureLoaded()
    return this.cache![serverName]
  }

  async setClientInformation(serverName: string, url: string, info: OAuthClientInformationMixed): Promise<void> {
    await this.ensureLoaded()
    const entry = (this.cache![serverName] ??= { url })
    entry.url = url
    entry.clientInformation = info
    await this.flush()
  }

  async setTokens(serverName: string, url: string, tokens: OAuthTokens): Promise<void> {
    await this.ensureLoaded()
    const entry = (this.cache![serverName] ??= { url })
    entry.url = url
    entry.tokens = tokens
    entry.tokensIssuedAt = new Date().toISOString()
    await this.flush()
  }

  async clear(serverName: string): Promise<void> {
    await this.ensureLoaded()
    if (this.cache![serverName]) {
      delete this.cache![serverName]
      await this.flush()
    }
  }

  async listServers(): Promise<Array<{ name: string; url: string; hasTokens: boolean }>> {
    await this.ensureLoaded()
    return Object.entries(this.cache!).map(([name, entry]) => ({
      name,
      url: entry.url,
      hasTokens: !!entry.tokens,
    }))
  }

  // ── helpers ────────────────────────────────────────────────────────────

  /** Compute the absolute expiry timestamp from issuedAt + expires_in.
   *  Returns undefined when either is missing (some servers omit expiry —
   *  in that case callers should optimistically use the token and let a
   *  401 trigger refresh). */
  static expiresAt(stored: StoredServerAuth | undefined): number | undefined {
    const t = stored?.tokens
    if (!t) return undefined
    if (typeof t.expires_in !== 'number') return undefined
    const issued = stored.tokensIssuedAt ? Date.parse(stored.tokensIssuedAt) : NaN
    if (Number.isNaN(issued)) return undefined
    return issued + t.expires_in * 1000
  }

  /** True iff stored tokens exist AND look fresh enough to use
   *  (i.e. won't expire in the next `skewMs` window). When expiry
   *  isn't known we return true and let the next 401 drive a refresh. */
  static isAccessTokenLikelyValid(stored: StoredServerAuth | undefined, skewMs = 60_000): boolean {
    if (!stored?.tokens?.access_token) return false
    const expiresAt = McpTokenStorage.expiresAt(stored)
    if (expiresAt === undefined) return true
    return Date.now() + skewMs < expiresAt
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this.cache !== null) return
    this.cache = await readFile()
  }

  private async flush(): Promise<void> {
    if (!this.cache) return
    try {
      await fs.mkdir(userXcodeDir(), { recursive: true })
      const tmp = authFile() + '.tmp'
      await fs.writeFile(tmp, JSON.stringify(this.cache, null, 2) + '\n', {
        encoding: 'utf-8',
        mode: 0o600,
      })
      await fs.rename(tmp, authFile())
    } catch (err) {
      debugLog('mcp.token-write-failed', String(err))
    }
  }
}

async function readFile(): Promise<FileShape> {
  try {
    const raw = await fs.readFile(authFile(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as FileShape
    }
  } catch {
    // missing / malformed — start clean
  }
  return {}
}

/** Singleton instance. Wiring is simple: CLI startup constructs it once,
 *  passes it to loadMcpServers (which threads it into per-server OAuth
 *  providers) and to /mcp auth / /mcp logout handlers. */
let globalInstance: McpTokenStorage | null = null
export function getTokenStorage(): McpTokenStorage {
  if (!globalInstance) globalInstance = new McpTokenStorage()
  return globalInstance
}

/** Test hook — replace the singleton so unit tests don't touch
 *  ~/.x-code/. Note that X_CODE_HOME also reroutes the file, so most
 *  tests can just set that env var and avoid this hook. */
export function setTokenStorageForTesting(s: McpTokenStorage | null): void {
  globalInstance = s
}

export type { OAuthClientInformationFull, OAuthClientInformationMixed, OAuthTokens }
