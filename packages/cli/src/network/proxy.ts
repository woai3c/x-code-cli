import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

/** Loopback traffic is never meant to go through an outbound HTTP proxy:
 *  local OpenAI-compatible servers, local MCP HTTP transports, and the test
 *  suite's fake provider all listen on 127.0.0.1. A user who exports
 *  HTTPS_PROXY for a remote model endpoint would otherwise find every local
 *  endpoint silently broken. */
const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1'

/** undici's EnvHttpProxyAgent only reads HTTP_PROXY / HTTPS_PROXY / NO_PROXY.
 *  ALL_PROXY is the common macOS/Linux single-variable convention, so it has
 *  to be mapped onto both schemes by hand. */
const FIRST_KEYS = ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'] as const
const SECOND_KEYS = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'] as const
const NO_PROXY_KEYS = ['NO_PROXY', 'no_proxy'] as const

export interface EnvProxyOptions {
  httpProxy?: string
  httpsProxy?: string
  noProxy: string
}

function readEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = env[key]?.trim()
    if (value) return value
  }
  return null
}

/** Accept the bare `host:port` form users copy out of proxy clients. */
function withScheme(value: string): string {
  return value.includes('://') ? value : `http://${value}`
}

/** Pure env resolution so the routing decision is unit-testable without
 *  touching the process-wide dispatcher. Returns null when no proxy is
 *  configured, leaving `fetch` on its default direct path. */
export function resolveEnvProxyOptions(env: NodeJS.ProcessEnv = process.env): EnvProxyOptions | null {
  const httpProxy = readEnv(env, FIRST_KEYS)
  const httpsProxy = readEnv(env, SECOND_KEYS)
  if (!httpProxy && !httpsProxy) return null

  const userNoProxy = readEnv(env, NO_PROXY_KEYS)
  return {
    ...(httpProxy ? { httpProxy: withScheme(httpProxy) } : {}),
    ...(httpsProxy ? { httpsProxy: withScheme(httpsProxy) } : {}),
    noProxy: userNoProxy ? `${userNoProxy},${LOOPBACK_NO_PROXY}` : LOOPBACK_NO_PROXY,
  }
}

/** Node's bundled `fetch` resolves its dispatcher from the well-known
 *  `Symbol.for('undici.globalDispatcher.1')` slot on globalThis, and the
 *  `undici` npm package writes that same slot. Driving the native fetch
 *  through `setGlobalDispatcher` therefore covers every outbound call —
 *  provider requests, webFetch, update checks — instead of threading a
 *  dispatcher through each call site. */
export function installEnvProxy(
  env: NodeJS.ProcessEnv = process.env,
  apply: (options: EnvProxyOptions) => void = (options) => setGlobalDispatcher(new EnvHttpProxyAgent(options)),
): boolean {
  const options = resolveEnvProxyOptions(env)
  if (!options) return false
  apply(options)
  return true
}
