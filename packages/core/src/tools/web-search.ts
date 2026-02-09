// @x-code/core — webSearch tool (Tavily API)
import { tool } from 'ai'

import { z } from 'zod'

export const webSearch = tool({
  description:
    'Search the web for information. Useful for looking up documentation, error messages, or current information.',
  inputSchema: z.object({
    query: z.string().describe('The search query'),
    maxResults: z.number().optional().describe('Max results (default: 5)'),
  }),
  execute: async ({ query, maxResults }) => {
    if (!process.env.TAVILY_API_KEY) {
      return 'Error: TAVILY_API_KEY is not configured. Get a free API key (1000 searches/month) at https://tavily.com'
    }
    try {
      const { tavily } = await import('@tavily/core')
      const client = tavily({ apiKey: process.env.TAVILY_API_KEY })
      const response = await client.search(query, { maxResults: maxResults ?? 5 })
      const results = response.results.map(
        (r: { title: string; url: string; content: string }) => `### ${r.title}\n${r.url}\n${r.content}`,
      )
      return results.join('\n\n') || 'No results found.'
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error searching: ${msg}`
    }
  },
})
