// @x-code-cli/core — webFetch tool (HTTP fetch + HTML→Markdown, with LRU cache + CF fallback)
import * as cheerio from 'cheerio'
// @ts-expect-error turndown has no types
import TurndownService from 'turndown'

import { tool } from 'ai'

import { z } from 'zod'

const FETCH_TIMEOUT_MS = 15_000
// Markdown returned to the model. Bumped from 30 KB (which cut docs pages in half)
// but kept well under the model's context budget: ~100 KB ≈ ~25 K tokens, roughly
// 12% of a Sonnet 200 K window, so a single fetch can't blow context.
// This is a per-call cap; the model can always fetch again with a narrower prompt.
const MAX_CONTENT_CHARS = 100_000
// Raw HTML ceiling before turndown. 10 MB is comfortable for any real doc page;
// enforced via content-length header (best-effort — chunked responses skip this,
// in which case the 15 s fetch timeout bounds the download).
const MAX_HTTP_BYTES = 10 * 1024 * 1024
const CACHE_TTL_MS = 15 * 60 * 1000
const CACHE_MAX_ENTRIES = 50

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
// Used as Cloudflare fallback: aggressive bot rules often let honest CLI UAs through
// while blocking browser impersonators that fail TLS-fingerprint checks.
const FALLBACK_UA = 'x-code-cli/0.1 (+https://github.com/woai3c/x-code-cli)'

const YEAR = new Date().getFullYear()

// ── Minimal in-memory LRU cache (URL → rendered markdown) ──
interface CacheEntry {
  markdown: string
  at: number
}
const fetchCache = new Map<string, CacheEntry>()

function cacheGet(url: string): string | null {
  const entry = fetchCache.get(url)
  if (!entry) return null
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    fetchCache.delete(url)
    return null
  }
  // LRU: re-insert to move this entry to the tail (most-recently-used)
  fetchCache.delete(url)
  fetchCache.set(url, entry)
  return entry.markdown
}

function cacheSet(url: string, markdown: string): void {
  if (fetchCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = fetchCache.keys().next().value
    if (oldest !== undefined) fetchCache.delete(oldest)
  }
  fetchCache.set(url, { markdown, at: Date.now() })
}

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
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
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
  execute: async ({ url, prompt }) => {
    try {
      const cached = cacheGet(url)
      if (cached) return formatOutput(url, cached, prompt)

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

      // Best-effort size guard: content-length is optional under chunked encoding,
      // so we also rely on fetch's 15s timeout to bound pathological pages.
      const contentLength = Number(response.headers.get('content-length') ?? '0')
      if (contentLength > MAX_HTTP_BYTES) {
        const mb = Math.round(contentLength / 1024 / 1024)
        return `Error: Content too large (${mb} MB, limit ${MAX_HTTP_BYTES / 1024 / 1024} MB)`
      }

      const contentType = response.headers.get('content-type') ?? ''
      const body = await response.text()

      if (contentType.includes('application/json')) {
        const json = body.slice(0, MAX_CONTENT_CHARS)
        cacheSet(url, json)
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

      cacheSet(url, markdown)
      return formatOutput(url, markdown, prompt)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error fetching URL: ${msg}`
    }
  },
})
