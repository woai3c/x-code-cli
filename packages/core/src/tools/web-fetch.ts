// @x-code/core — webFetch tool (HTTP fetch + HTML→Markdown)
import * as cheerio from 'cheerio'
// @ts-expect-error turndown has no types
import TurndownService from 'turndown'

import { tool } from 'ai'

import { z } from 'zod'

// eslint-disable-next-line @typescript-eslint/no-unsafe-call
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
}) as { turndown: (html: string) => string }

export const webFetch = tool({
  description: 'Fetch a web page and extract its content as markdown. No API key needed.',
  inputSchema: z.object({
    url: z.string().url().describe('The URL to fetch'),
    prompt: z.string().optional().describe('What information to extract from the page'),
  }),
  execute: async ({ url, prompt }) => {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; X-Code-CLI/0.1)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(15000),
      })

      if (!response.ok) {
        return `Error: HTTP ${response.status} ${response.statusText}`
      }

      const contentType = response.headers.get('content-type') ?? ''
      const body = await response.text()

      if (contentType.includes('application/json')) {
        return body.slice(0, 30000)
      }

      // HTML → Markdown
      const $ = cheerio.load(body)
      $('script, style, nav, footer, header, aside, .sidebar, .nav, .menu, .ads, .advertisement').remove()

      const mainContent = $('main, article, .content, .post, #content').first()
      const html = mainContent.length ? mainContent.html() : $('body').html()

      if (!html) return 'Error: Could not extract content from page.'

      let markdown: string = turndown.turndown(html)
      if (markdown.length > 30000) {
        markdown = markdown.slice(0, 30000) + '\n\n... [content truncated]'
      }

      if (prompt) {
        return `# Content from ${url}\n\n${markdown}\n\n---\nExtract instruction: ${prompt}`
      }
      return markdown
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error fetching URL: ${msg}`
    }
  },
})
