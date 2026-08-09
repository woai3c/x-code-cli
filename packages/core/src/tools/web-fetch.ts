// @x-code-cli/core — webFetch tool (HTTP fetch + HTML→Markdown, with LRU cache + CF fallback)
import * as cheerio from 'cheerio'
// @ts-expect-error turndown has no types
import TurndownService from 'turndown'
import { Agent, fetch as undiciFetch } from 'undici'

import { lookup as dnsLookup } from 'node:dns'
import { BlockList, isIP } from 'node:net'

import { fetchWithValidatedRedirects } from '@ai-sdk/provider-utils'
import { tool } from 'ai'

import { z } from 'zod'

import { LruCache } from '../utils/lru-cache.js'
import { formatToolError } from '../utils/tool-errors.js'
import { VERSION } from '../version.js'
import { reportProgress } from './progress.js'

const FETCH_TIMEOUT_MS = 15_000
// Markdown returned to the model. Bumped from 30 KB (which cut docs pages in half)
// but kept well under the model's context budget: ~100 KB ≈ ~25 K tokens, roughly
// 12% of a Sonnet 200 K window, so a single fetch can't blow context.
// This is a per-call cap; the model can always fetch again with a narrower prompt.
const MAX_CONTENT_CHARS = 100_000
// Raw HTML ceiling before turndown. 10 MB is comfortable for any real doc page;
// enforced both by content-length header AND by streaming body read (see
// readResponseBody) so chunked responses are also bounded.
const MAX_HTTP_BYTES = 10 * 1024 * 1024
const MAX_URL_LENGTH = 2000
const CACHE_TTL_MS = 15 * 60 * 1000
const CACHE_MAX_ENTRIES = 50

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
// Used as Cloudflare fallback: aggressive bot rules often let honest CLI UAs through
// while blocking browser impersonators that fail TLS-fingerprint checks.
const FALLBACK_UA = `x-code-cli/${VERSION} (+https://github.com/woai3c/x-code-cli)`

const YEAR = new Date().getFullYear()

// ── SSRF protection ──
// Reject URLs targeting internal/private networks. Mirrors Claude Code's
// validateURL: hostname must have ≥2 dot-separated segments (rejects
// `localhost`, bare hostnames), no embedded credentials, no non-HTTP schemes,
// and no IPs in private/link-local/loopback ranges.

const DISALLOWED_ADDRESSES = new BlockList()

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  DISALLOWED_ADDRESSES.addSubnet(network, prefix, 'ipv4')
}

for (const [network, prefix] of [
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['3fff::', 20],
] as const) {
  DISALLOWED_ADDRESSES.addSubnet(network, prefix, 'ipv6')
}

DISALLOWED_ADDRESSES.addAddress('::', 'ipv6')
DISALLOWED_ADDRESSES.addAddress('::1', 'ipv6')

function isFakeIpAddress(address: string, family: number): boolean {
  if (family !== 4) return false
  const [first, second] = address.split('.').map(Number)
  return first === 198 && (second === 18 || second === 19)
}

function isDisallowedAddress(address: string, family: number): boolean {
  if (family === 4) return isIP(address) !== 4 || DISALLOWED_ADDRESSES.check(address, 'ipv4')
  if (family === 6) return isIP(address) !== 6 || DISALLOWED_ADDRESSES.check(address, 'ipv6')
  return true
}

function isPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal')) return true
  // IP-literal in URL — strip surrounding brackets for IPv6
  const bare = lower.startsWith('[') ? lower.slice(1, -1) : lower
  const family = isIP(bare)
  return family !== 0 && isDisallowedAddress(bare, family)
}

/** @internal Exported for DNS-guard tests. */
export function validateResolvedAddress(
  hostname: string,
  address: string,
  family: number,
  allowHttpsFakeIp = false,
): void {
  // Clash/Mihomo fake-IP mode deliberately maps public hostnames into
  // 198.18.0.0/15 and routes those sockets through its TUN interface. Permit
  // that synthetic address only for an HTTPS hostname. IP-literal URLs are
  // still rejected by validateFetchUrl, and every redirect is revalidated.
  if (allowHttpsFakeIp && isIP(hostname) === 0 && isFakeIpAddress(address, family)) return

  if (isDisallowedAddress(address, family)) {
    throw new Error(`Hostname ${hostname} resolved to disallowed IP address ${address}`)
  }
}

type LookupAddress = { address: string; family: number }
type LookupOptions = {
  all?: boolean
  family?: number
  hints?: number
  order?: 'ipv4first' | 'ipv6first' | 'verbatim'
  verbatim?: boolean
}
type LookupAllCallback = (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
type LookupOneCallback = (error: NodeJS.ErrnoException | null, address: string, family: number) => void
type Lookup = (hostname: string, options: LookupOptions & { all: true }, callback: LookupAllCallback) => void

function createValidatedLookup(allowHttpsFakeIp: boolean) {
  const lookupAll = dnsLookup as unknown as Lookup
  return (hostname: string, options: LookupOptions, callback: LookupAllCallback | LookupOneCallback): void => {
    lookupAll(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        const rejectLookup = callback as (error: NodeJS.ErrnoException) => void
        rejectLookup(error)
        return
      }

      try {
        const [firstAddress] = addresses
        if (!firstAddress) throw new Error(`Hostname ${hostname} did not resolve to an address`)
        for (const { address, family } of addresses) {
          validateResolvedAddress(hostname, address, family, allowHttpsFakeIp)
        }

        if (options.all === true) (callback as LookupAllCallback)(null, addresses)
        else (callback as LookupOneCallback)(null, firstAddress.address, firstAddress.family)
      } catch (error) {
        const rejectLookup = callback as (error: Error) => void
        rejectLookup(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}

const strictAgent = new Agent({ connect: { lookup: createValidatedLookup(false) as never } })
const httpsFakeIpAgent = new Agent({ connect: { lookup: createValidatedLookup(true) as never } })

const fakeIpCompatibleFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? new URL(input.url) : new URL(String(input))
  const dispatcher = url.protocol === 'https:' ? httpsFakeIpAgent : strictAgent
  return undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    {
      ...init,
      dispatcher,
    } as Parameters<typeof undiciFetch>[1],
  ) as unknown as Promise<Response>
}

function isFakeIpDnsRejection(error: unknown): boolean {
  let current = error
  for (let depth = 0; current && depth < 6; depth++) {
    if (current instanceof Error) {
      if (/resolved to disallowed IP address 198\.(?:18|19)\./i.test(current.message)) return true
      current = current.cause
    } else {
      break
    }
  }
  return false
}

/** @internal Exported for testing only. */
export function validateFetchUrl(url: string): string | null {
  if (url.length > MAX_URL_LENGTH) return `URL exceeds ${MAX_URL_LENGTH} character limit`
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'Invalid URL'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Unsupported protocol: ${parsed.protocol} (only http/https allowed)`
  }
  if (parsed.username || parsed.password) return 'URLs with embedded credentials are not allowed'
  const parts = parsed.hostname.split('.')
  if (parts.length < 2) return `Hostname "${parsed.hostname}" is not a public domain (must have at least two segments)`
  if (isPrivateHost(parsed.hostname)) {
    return `Fetching private/internal address "${parsed.hostname}" is blocked for security`
  }
  return null
}

const fetchCache = new LruCache<string>({ maxEntries: CACHE_MAX_ENTRIES, ttlMs: CACHE_TTL_MS })

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
}) as { turndown: (html: string) => string }

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** @internal Exported for redirect-validation tests. */
export async function doFetch(
  url: string,
  userAgent: string,
  abortSignal?: AbortSignal,
  customFetch?: typeof fetch,
): Promise<Response> {
  const request = {
    url,
    headers: {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    abortSignal: withTimeout(abortSignal),
    maxRedirects: 10,
  }

  if (customFetch) return fetchWithValidatedRedirects({ ...request, fetch: customFetch })

  try {
    return await fetchWithValidatedRedirects(request)
  } catch (error) {
    if (!isFakeIpDnsRejection(error)) throw error
    return fetchWithValidatedRedirects({ ...request, fetch: fakeIpCompatibleFetch })
  }
}

/** Stream-read response body with a hard byte cap. Prevents OOM on chunked
 *  responses where content-length is absent or lying. */
async function readResponseBody(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return response.text()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel()
      break
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(Math.min(totalBytes, maxBytes))
  let offset = 0
  for (const chunk of chunks) {
    const remaining = merged.byteLength - offset
    if (remaining <= 0) break
    const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk
    merged.set(slice, offset)
    offset += slice.byteLength
  }
  return new TextDecoder().decode(merged)
}

function formatOutput(url: string, markdown: string, prompt?: string): string {
  if (prompt) {
    return `# Content from ${url}\n\n${markdown}\n\n---\nExtract instruction: ${prompt}`
  }
  return markdown
}

export const webFetch = tool({
  description:
    `Fetch a web page and extract its content as markdown. No API key needed. ` +
    `When summarizing the returned content for the user, preserve key details, concrete examples, ` +
    `section structure, and numbers — don't over-compress. ` +
    `Results are cached for 15 minutes per URL, so repeated reads of the same page are free. ` +
    `The current year is ${YEAR} — use it whenever the user asks for recent/latest/current information.`,
  inputSchema: z.object({
    url: z.string().url().describe('The URL to fetch'),
    prompt: z.string().optional().describe('What information to extract from the page'),
  }),
  execute: async ({ url, prompt }, { toolCallId, abortSignal }) => {
    try {
      const urlError = validateFetchUrl(url)
      if (urlError) return `Error: ${urlError}`

      const cached = fetchCache.get(url)
      if (cached) {
        reportProgress(toolCallId, 'Using cached copy')
        return formatOutput(url, cached, prompt)
      }

      reportProgress(toolCallId, `Fetching ${url}`)
      let response = await doFetch(url, BROWSER_UA, abortSignal)

      // Cloudflare bot-challenge fallback: on 403 + cf-mitigated header, retry with
      // an honest CLI UA. Many CF rules whitelist identified crawlers while blocking
      // anything that fails the browser TLS fingerprint check.
      if (response.status === 403 && response.headers.get('cf-mitigated') !== null) {
        response = await doFetch(url, FALLBACK_UA, abortSignal)
      }

      if (!response.ok) {
        return `Error: HTTP ${response.status} ${response.statusText}`
      }

      // Reject upfront when content-length exceeds the cap.
      const contentLength = Number(response.headers.get('content-length') ?? '0')
      if (contentLength > MAX_HTTP_BYTES) {
        const mb = Math.round(contentLength / 1024 / 1024)
        return `Error: Content too large (${mb} MB, limit ${MAX_HTTP_BYTES / 1024 / 1024} MB)`
      }

      const contentType = response.headers.get('content-type') ?? ''
      // Stream-read with hard byte cap — prevents OOM on chunked responses
      // where content-length is absent or lies.
      const body = await readResponseBody(response, MAX_HTTP_BYTES)

      if (contentType.includes('application/json')) {
        const json = body.slice(0, MAX_CONTENT_CHARS)
        fetchCache.set(url, json)
        return formatOutput(url, json, prompt)
      }

      const $ = cheerio.load(body)
      $('script, style, nav, footer, header, aside, .sidebar, .nav, .menu, .ads, .advertisement').remove()

      const mainContent = $('main, article, .content, .post, #content').first()
      const html = mainContent.length ? mainContent.html() : $('body').html()

      if (!html) return 'Error: Could not extract content from page.'

      let markdown: string = turndown.turndown(html)
      if (markdown.length > MAX_CONTENT_CHARS) {
        markdown = markdown.slice(0, MAX_CONTENT_CHARS) + '\n\n... [content truncated]'
      }

      fetchCache.set(url, markdown)
      return formatOutput(url, markdown, prompt)
    } catch (err) {
      return formatToolError('fetching URL', err)
    }
  },
})
