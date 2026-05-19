// @x-code-cli/core — webFetch tool (HTTP fetch + HTML→Markdown, with LRU cache + CF fallback)
import * as cheerio from 'cheerio'
// @ts-expect-error turndown has no types
import TurndownService from 'turndown'

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

const PRIVATE_IP_PATTERNS = [
  /^127\./, // loopback
  /^10\./, // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
  /^192\.168\./, // 192.168.0.0/16
  /^169\.254\./, // link-local (AWS/GCP metadata)
  /^0\./, // 0.0.0.0/8
  /^::1$/, // IPv6 loopback
  /^fd[0-9a-f]{2}:/i, // IPv6 ULA
  /^fe80:/i, // IPv6 link-local
]

function isPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal')) return true
  // IP-literal in URL — strip surrounding brackets for IPv6
  const bare = lower.startsWith('[') ? lower.slice(1, -1) : lower
  return PRIVATE_IP_PATTERNS.some((re) => re.test(bare))
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

async function doFetch(url: string, userAgent: string): Promise<Response> {
  return fetch(url, {
    headers: {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
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
  execute: async ({ url, prompt }, { toolCallId }) => {
    try {
      const urlError = validateFetchUrl(url)
      if (urlError) return `Error: ${urlError}`

      const cached = fetchCache.get(url)
      if (cached) {
        reportProgress(toolCallId, 'Using cached copy')
        return formatOutput(url, cached, prompt)
      }

      reportProgress(toolCallId, `Fetching ${url}`)
      let response = await doFetch(url, BROWSER_UA)

      // Cloudflare bot-challenge fallback: on 403 + cf-mitigated header, retry with
      // an honest CLI UA. Many CF rules whitelist identified crawlers while blocking
      // anything that fails the browser TLS fingerprint check.
      if (response.status === 403 && response.headers.get('cf-mitigated') !== null) {
        response = await doFetch(url, FALLBACK_UA)
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
