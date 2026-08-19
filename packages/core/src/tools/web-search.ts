// @x-code-cli/core — webSearch tool (multi-provider).
//
// Provider order: explicit X_CODE_WEB_SEARCH_PROVIDER override, then the
// first keyed provider in SEARCH_PROVIDERS order, then — only when the
// active model runs on the dedicated `deepseek` provider — DeepSeek's
// built-in server-side web search. Routing a DeepSeek model through an
// OpenAI-compatible custom endpoint does NOT trigger the fallback (the
// provider id differs). There is no runtime failover between providers:
// a configured provider that errors reports the error rather than
// silently billing another key.
import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'
import { getShellProvider } from './shell-provider.js'

const YEAR = new Date().getFullYear()
const SEARCH_TIMEOUT_MS = 15_000
// DeepSeek search is a full model turn server-side, not a plain lookup, so
// it needs a much wider budget than the REST search APIs.
const DEEPSEEK_TIMEOUT_MS = 60_000

interface SearchResult {
  title: string
  url: string
  content: string
}

interface ProviderResponse {
  answer?: string
  results: SearchResult[]
}

interface WebSearchProvider {
  id: string
  label: string
  envKey: string
  signup: string
  search(query: string, maxResults: number, signal?: AbortSignal): Promise<ProviderResponse>
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

// HTTP error bodies carry the actionable message ("model not found",
// "invalid api key"); statusText alone makes provider failures undebuggable.
async function httpError(label: string, res: Response): Promise<Error> {
  const body = await res.text().catch(() => '')
  const detail = body.replace(/\s+/g, ' ').trim().slice(0, 200)
  return new Error(`${label} API returned HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`)
}

async function searchWithTavily(query: string, maxResults: number, signal?: AbortSignal): Promise<ProviderResponse> {
  // Use Tavily's small REST surface directly. The SDK pulls axios plus the
  // full js-tiktoken tables into the CLI bundle even though basic search
  // needs neither; direct fetch also lets Esc cancel the request immediately.
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.TAVILY_API_KEY!}`,
      'Content-Type': 'application/json',
      'X-Client-Source': 'x-code-cli',
    },
    body: JSON.stringify({ query, max_results: maxResults }),
    signal: withTimeout(signal, SEARCH_TIMEOUT_MS),
  })

  if (!res.ok) {
    throw await httpError('Tavily', res)
  }

  const data = (await res.json()) as { results?: SearchResult[] }
  return { results: (data.results ?? []).map((r) => ({ title: r.title, url: r.url, content: r.content })) }
}

async function searchWithBrave(query: string, maxResults: number, signal?: AbortSignal): Promise<ProviderResponse> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(Math.min(maxResults, 20)))

  const res = await fetch(url, {
    headers: {
      'X-Subscription-Token': process.env.BRAVE_API_KEY!,
      Accept: 'application/json',
    },
    signal: withTimeout(signal, SEARCH_TIMEOUT_MS),
  })

  if (!res.ok) {
    throw await httpError('Brave', res)
  }

  const data = (await res.json()) as {
    web?: { results?: Array<{ title: string; url: string; description: string }> }
  }
  return {
    results: (data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, content: r.description })),
  }
}

async function searchWithExa(query: string, maxResults: number, signal?: AbortSignal): Promise<ProviderResponse> {
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.EXA_API_KEY!}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      query,
      type: 'auto',
      numResults: maxResults,
      contents: { highlights: { highlightsPerUrl: 1 } },
    }),
    signal: withTimeout(signal, SEARCH_TIMEOUT_MS),
  })

  if (!res.ok) {
    throw await httpError('Exa', res)
  }

  const data = (await res.json()) as {
    results?: Array<{ url?: string; title?: string; highlights?: string[] }>
  }
  return {
    results: (data.results ?? [])
      .filter((r) => !!r.url)
      .map((r) => ({ title: r.title ?? r.url!, url: r.url!, content: r.highlights?.[0] ?? '' })),
  }
}

async function searchWithPerplexity(
  query: string,
  _maxResults: number,
  signal?: AbortSignal,
): Promise<ProviderResponse> {
  // Sonar is a chat-completions endpoint that grounds the answer itself:
  // it returns prose plus structured sources instead of raw hits.
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY!}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar',
      max_tokens: 1024,
      messages: [{ role: 'user', content: query }],
    }),
    signal: withTimeout(signal, SEARCH_TIMEOUT_MS),
  })

  if (!res.ok) {
    throw await httpError('Perplexity', res)
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    search_results?: Array<{ url?: string; title?: string; snippet?: string }>
    citations?: string[]
  }
  const answer = data.choices?.[0]?.message?.content
  const results: SearchResult[] = data.search_results
    ? data.search_results
        .filter((r) => !!r.url)
        .map((r) => ({ title: r.title ?? r.url!, url: r.url!, content: r.snippet ?? '' }))
    : // Older responses carry only a URL list, without titles or snippets.
      (data.citations ?? []).map((url) => ({ title: url, url, content: '' }))
  return { answer, results }
}

async function searchWithFirecrawl(query: string, maxResults: number, signal?: AbortSignal): Promise<ProviderResponse> {
  const res = await fetch('https://api.firecrawl.dev/v2/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY!}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, limit: maxResults }),
    signal: withTimeout(signal, SEARCH_TIMEOUT_MS),
  })

  if (!res.ok) {
    throw await httpError('Firecrawl', res)
  }

  const data = (await res.json()) as {
    data?: { web?: Array<{ url?: string; title?: string; description?: string }> }
  }
  return {
    results: (data.data?.web ?? [])
      .filter((r) => !!r.url)
      .map((r) => ({ title: r.title ?? r.url!, url: r.url!, content: r.description ?? '' })),
  }
}

// DeepSeek has no standalone search API. Web search is a server-side tool
// on its Anthropic-compatible Messages endpoint: the request declares
// web_search_20250305 and the response carries web_search_tool_result
// blocks. Each search costs a full (cheap) model turn.
interface AnthropicContentBlock {
  type: string
  text?: string
  content?: Array<{ type?: string; url?: string; title?: string }> | { type?: string }
  citations?: Array<{ url?: string; cited_text?: string }>
}

async function searchWithDeepseek(query: string, maxResults: number, signal?: AbortSignal): Promise<ProviderResponse> {
  const apiKey = process.env.DEEPSEEK_API_KEY!
  // Accept the documented base (https://api.deepseek.com/anthropic) with or
  // without the /v1 segment, then append the remaining path ourselves.
  const rawBase = (process.env.DEEPSEEK_SEARCH_BASE_URL || 'https://api.deepseek.com/anthropic').replace(/\/+$/, '')
  const messagesURL = rawBase.endsWith('/v1') ? `${rawBase}/messages` : `${rawBase}/v1/messages`
  const res = await fetch(messagesURL, {
    method: 'POST',
    headers: {
      // Official DeepSeek expects x-api-key; Anthropic-compatible proxies
      // expect Authorization. Send both so either route works.
      'x-api-key': apiKey,
      Authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      // A full (cheap) model turn powers each search; override if DeepSeek
      // retires the id or a cheaper search-capable model appears.
      model: process.env.DEEPSEEK_SEARCH_MODEL || 'deepseek-v4-flash',
      max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    }),
    signal: withTimeout(signal, DEEPSEEK_TIMEOUT_MS),
  })

  if (!res.ok) {
    throw await httpError('DeepSeek search', res)
  }

  const data = (await res.json()) as { content?: AnthropicContentBlock[] }
  const blocks = data.content ?? []

  // Snippets are not part of the result items; they arrive as citations on
  // separate text blocks. First citation per URL wins. The text blocks
  // themselves are the model's grounded summary and are surfaced as `answer`.
  const snippets = new Map<string, string>()
  const texts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && block.text?.trim()) texts.push(block.text.trim())
    for (const citation of block.citations ?? []) {
      if (citation.url && citation.cited_text && !snippets.has(citation.url)) {
        snippets.set(citation.url, citation.cited_text)
      }
    }
  }

  const seen = new Set<string>()
  const results: SearchResult[] = []
  for (const block of blocks) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue
    for (const item of block.content) {
      if (item.type !== 'web_search_result' || !item.url || seen.has(item.url)) continue
      seen.add(item.url)
      results.push({ title: item.title ?? item.url, url: item.url, content: snippets.get(item.url) ?? '' })
    }
  }

  // Strict mode: never scrape URLs out of model prose. If the server ran no
  // search, say so instead of returning a confident-looking empty list.
  if (results.length === 0) {
    throw new Error('DeepSeek returned no web_search_tool_result block for this query')
  }
  return { answer: texts.join('\n\n') || undefined, results: results.slice(0, maxResults) }
}

const deepseekProvider: WebSearchProvider = {
  id: 'deepseek',
  label: 'DeepSeek built-in search',
  envKey: 'DEEPSEEK_API_KEY',
  signup: 'https://platform.deepseek.com',
  search: searchWithDeepseek,
}

// Priority order for automatic selection. DeepSeek is deliberately NOT in
// this list: it bills a model turn per search, so it only kicks in as the
// fallback for DeepSeek-model users or via explicit override.
const SEARCH_PROVIDERS: WebSearchProvider[] = [
  {
    id: 'tavily',
    label: 'Tavily',
    envKey: 'TAVILY_API_KEY',
    signup: 'https://tavily.com',
    search: searchWithTavily,
  },
  {
    id: 'brave',
    label: 'Brave',
    envKey: 'BRAVE_API_KEY',
    signup: 'https://api.search.brave.com',
    search: searchWithBrave,
  },
  {
    id: 'exa',
    label: 'Exa',
    envKey: 'EXA_API_KEY',
    signup: 'https://exa.ai',
    search: searchWithExa,
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    envKey: 'PERPLEXITY_API_KEY',
    signup: 'https://www.perplexity.ai/settings/api',
    search: searchWithPerplexity,
  },
  {
    id: 'firecrawl',
    label: 'Firecrawl',
    envKey: 'FIRECRAWL_API_KEY',
    signup: 'https://firecrawl.dev',
    search: searchWithFirecrawl,
  },
]

const ALL_PROVIDERS: WebSearchProvider[] = [...SEARCH_PROVIDERS, deepseekProvider]

/** Side-channel: provider name of the active model (modelId split on ':').
 *  Set by the agent loop each turn, mirroring setZhipuReasoningEffort, so
 *  the statically-registered tool can tell whether the user runs DeepSeek. */
let currentModelProvider: string | undefined

export function setWebSearchModelProvider(provider: string | undefined): void {
  currentModelProvider = provider
}

type PickResult = { provider: WebSearchProvider } | { error: string } | { none: true }

function pickProvider(modelProvider: string | undefined): PickResult {
  const forced = process.env.X_CODE_WEB_SEARCH_PROVIDER?.trim().toLowerCase()
  if (forced) {
    const p = ALL_PROVIDERS.find((candidate) => candidate.id === forced)
    if (!p) {
      return {
        error:
          `Unknown web search provider "${forced}" in X_CODE_WEB_SEARCH_PROVIDER. ` +
          `Valid values: ${ALL_PROVIDERS.map((candidate) => candidate.id).join(', ')}.`,
      }
    }
    if (!process.env[p.envKey]) {
      return { error: `X_CODE_WEB_SEARCH_PROVIDER=${forced} is set but ${p.envKey} is missing.` }
    }
    return { provider: p }
  }
  for (const p of SEARCH_PROVIDERS) {
    if (process.env[p.envKey]) return { provider: p }
  }
  if (modelProvider === 'deepseek' && process.env.DEEPSEEK_API_KEY) {
    return { provider: deepseekProvider }
  }
  return { none: true }
}

/** Which provider a webSearch call would use right now, for startup hints.
 *  Pass the resolved model's provider explicitly; falls back to the
 *  loop-injected side-channel. */
export function resolveWebSearchProvider(modelProvider?: string): { id: string; label: string } | null {
  const picked = pickProvider(modelProvider ?? currentModelProvider)
  return 'provider' in picked ? { id: picked.provider.id, label: picked.provider.label } : null
}

function buildMissingKeyError(): string {
  const { type } = getShellProvider()
  let setupBlock: string

  if (type === 'powershell') {
    setupBlock = [
      '  # current session:',
      '  $env:TAVILY_API_KEY = "tvly-xxx"',
      '  # persistent (new shells):',
      '  [Environment]::SetEnvironmentVariable("TAVILY_API_KEY","tvly-xxx","User")',
    ].join('\n')
  } else {
    const rc = type === 'zsh' ? '~/.zshrc' : '~/.bashrc'
    setupBlock = [
      '  # current session:',
      '  export TAVILY_API_KEY="tvly-xxx"',
      '  # persistent (new shells):',
      `  echo 'export TAVILY_API_KEY="tvly-xxx"' >> ${rc}`,
    ].join('\n')
  }

  return [
    'Error: WebSearch requires a search API key. Options (set any one):',
    '',
    '  1. Tavily     — 1000 searches/month free, recommended',
    '     Sign up: https://tavily.com → copy API key from dashboard (TAVILY_API_KEY)',
    '',
    '  2. Brave      — paid, $5 free credit (BRAVE_API_KEY, https://api.search.brave.com)',
    '  3. Exa        — 1000 requests/month free (EXA_API_KEY, https://exa.ai)',
    '  4. Perplexity — paid Sonar API (PERPLEXITY_API_KEY, https://www.perplexity.ai/settings/api)',
    '  5. Firecrawl  — free credits tier (FIRECRAWL_API_KEY, https://firecrawl.dev)',
    '',
    '  Using a DeepSeek model? No extra key needed — webSearch automatically uses',
    "  DeepSeek's built-in web search with your DEEPSEEK_API_KEY.",
    '',
    `Setup (${type}):`,
    setupBlock,
    '',
    'After setting, restart this shell for the variable to take effect.',
  ].join('\n')
}

function formatResults(response: ProviderResponse): string {
  const parts: string[] = []
  if (response.answer) parts.push(response.answer)
  if (response.results.length > 0) {
    parts.push(response.results.map((r) => `### ${r.title}\n${r.url}\n${r.content}`).join('\n\n'))
  }
  if (parts.length === 0) return 'No results found.'
  return parts.join('\n\n')
}

export const webSearch = tool({
  description:
    `Search the web for information. Useful for looking up documentation, error messages, or current information. ` +
    `The current year is ${YEAR} — use it whenever the user asks for recent/latest/current information ` +
    `(e.g. prefer "React 19 release notes ${YEAR}" over "React latest release notes").`,
  inputSchema: z.object({
    query: z.string().describe('The search query'),
    maxResults: z.number().int().min(1).max(20).optional().describe('Max results (default: 5, max: 20)'),
  }),
  // Per-request model provider, supplied via streamText toolsContext. This
  // channel is race-safe for concurrent sub-agent loops; the module-level
  // setWebSearchModelProvider value is only a fallback.
  contextSchema: z.object({ modelProvider: z.string().optional() }),
  execute: async ({ query, maxResults }, { toolCallId, abortSignal, context }) => {
    const n = maxResults ?? 5
    const picked = pickProvider(context?.modelProvider ?? currentModelProvider)

    if ('none' in picked) return buildMissingKeyError()
    if ('error' in picked) return `Error: ${picked.error}`

    const { provider } = picked
    reportProgress(toolCallId, `Searching (${provider.label}): ${query}`)
    try {
      const response = await provider.search(query, n, abortSignal)
      // Uniform cap: some providers (Perplexity) can't limit result counts
      // server-side, so enforce the seam-level bound here.
      return formatResults({ ...response, results: response.results.slice(0, n) })
    } catch (err) {
      return formatToolError(`searching (${provider.label})`, err)
    }
  },
})
