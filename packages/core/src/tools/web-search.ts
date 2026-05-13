// @x-code-cli/core — webSearch tool (Tavily primary, Brave fallback)
import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'
import { getShellProvider } from './shell-provider.js'

const YEAR = new Date().getFullYear()
const BRAVE_TIMEOUT_MS = 15_000

interface SearchResult {
  title: string
  url: string
  content: string
}

async function searchWithTavily(query: string, maxResults: number): Promise<SearchResult[]> {
  const { tavily } = await import('@tavily/core')
  const client = tavily({ apiKey: process.env.TAVILY_API_KEY! })
  const response = await client.search(query, { maxResults })
  return response.results.map((r: SearchResult) => ({ title: r.title, url: r.url, content: r.content }))
}

async function searchWithBrave(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(Math.min(maxResults, 20)))

  const res = await fetch(url, {
    headers: {
      'X-Subscription-Token': process.env.BRAVE_API_KEY!,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(BRAVE_TIMEOUT_MS),
  })

  if (!res.ok) {
    throw new Error(`Brave API returned HTTP ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as {
    web?: { results?: Array<{ title: string; url: string; description: string }> }
  }
  return (data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, content: r.description }))
}

function buildMissingKeyError(): string {
  const { type } = getShellProvider()
  let setupBlock: string

  if (type === 'powershell') {
    setupBlock = [
      '  # current session:',
      '  $env:TAVILY_API_KEY = "tvly-xxx"',
      '  $env:BRAVE_API_KEY  = "BSA-xxx"',
      '  # persistent (new shells):',
      '  [Environment]::SetEnvironmentVariable("TAVILY_API_KEY","tvly-xxx","User")',
      '  [Environment]::SetEnvironmentVariable("BRAVE_API_KEY", "BSA-xxx", "User")',
    ].join('\n')
  } else {
    const rc = type === 'zsh' ? '~/.zshrc' : '~/.bashrc'
    setupBlock = [
      '  # current session:',
      '  export TAVILY_API_KEY="tvly-xxx"',
      '  export BRAVE_API_KEY="BSA-xxx"',
      '  # persistent (new shells):',
      `  echo 'export TAVILY_API_KEY="tvly-xxx"' >> ${rc}`,
      `  echo 'export BRAVE_API_KEY="BSA-xxx"' >> ${rc}`,
    ].join('\n')
  }

  return [
    'Error: WebSearch requires an API key. Two free options (set either one):',
    '',
    '  1. Tavily — 1000 searches/month, recommended',
    '     Sign up: https://tavily.com → copy API key from dashboard',
    '',
    '  2. Brave  — ~1000 searches/month via $5 free credit (requires credit card, over-usage billed)',
    '     Sign up: https://api.search.brave.com → create API key',
    '',
    `Setup (${type}):`,
    setupBlock,
    '',
    'After setting, restart this shell for the variable to take effect.',
  ].join('\n')
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results found.'
  return results.map((r) => `### ${r.title}\n${r.url}\n${r.content}`).join('\n\n')
}

export const webSearch = tool({
  description:
    `Search the web for information. Useful for looking up documentation, error messages, or current information. ` +
    `The current year is ${YEAR} — use it whenever the user asks for recent/latest/current information ` +
    `(e.g. prefer "React 19 release notes ${YEAR}" over "React latest release notes").`,
  inputSchema: z.object({
    query: z.string().describe('The search query'),
    maxResults: z.number().optional().describe('Max results (default: 5)'),
  }),
  execute: async ({ query, maxResults }, { toolCallId }) => {
    const n = maxResults ?? 5
    const hasTavily = !!process.env.TAVILY_API_KEY
    const hasBrave = !!process.env.BRAVE_API_KEY

    if (!hasTavily && !hasBrave) return buildMissingKeyError()

    reportProgress(toolCallId, `Searching: ${query}`)
    try {
      const results = hasTavily ? await searchWithTavily(query, n) : await searchWithBrave(query, n)
      return formatResults(results)
    } catch (err) {
      return formatToolError(`searching (${hasTavily ? 'Tavily' : 'Brave'})`, err)
    }
  },
})
