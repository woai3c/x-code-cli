import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '17-web-fetch',
  name: 'webFetch 工具：抓一个稳定 URL 并解出页面内容',
  // No API key needed for webFetch, but it does need outbound HTTPS.
  // example.com is HTTPS-served, has been online since 1992, and ships
  // a tiny "Example Domain" page that any HTML→markdown extractor handles.
  async run(ctx) {
    const r = await ctx.runCli(
      'Use the webFetch tool to fetch https://example.com/ and then tell me, in one sentence, what the page says or what it is for.',
      { args: ['--max-turns', '4'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'webFetch', { url: /example\.com/ })
    ctx.expect.assistantMentions(r, /example|domain|illustrative|documentation/i)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
