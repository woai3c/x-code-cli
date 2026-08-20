import type { Scenario } from '../framework/types.js'

const WIKIPEDIA_URL = /https:\/\/en\.wikipedia\.org\/wiki\/Prompt_engineering/i

const scenario: Scenario = {
  id: '15-web-search',
  name: 'webSearch 工具：搜一个外部主题（需要任一搜索 API key）',
  requires: (env) =>
    Boolean(
      env.TAVILY_API_KEY ||
      env.BRAVE_API_KEY ||
      env.EXA_API_KEY ||
      env.PERPLEXITY_API_KEY ||
      env.FIRECRAWL_API_KEY ||
      env.DEEPSEEK_API_KEY,
    ),
  requiresReason: 'set TAVILY_API_KEY (or another search key / DEEPSEEK_API_KEY) to enable',
  async run(ctx) {
    const r = await ctx.runCli(
      'Use the webSearch tool to find the Wikipedia article URL for prompt engineering, ' +
        'then quote the URL in your final answer.',
      { args: ['--max-turns', '6'] },
    )
    ctx.expect.exitCode(r, 0)
    const searchCall = ctx.expect.toolCalled(r, 'webSearch', { query: /(prompt[- ]?engin|wikipedia)/i })
    // Wikipedia article URLs are stable — no vendor domain churn like docs sites
    // (e.g. Anthropic moved docs.anthropic.com → platform.claude.com), so the
    // assertion can pin the exact URL in both the search result and final answer.
    ctx.expect.truthy(
      WIKIPEDIA_URL.test(searchCall.resultText ?? ''),
      `webSearch result did not contain the expected Wikipedia URL; got: ${(searchCall.resultText ?? '').slice(0, 400)}`,
    )
    ctx.expect.assistantMentions(r, WIKIPEDIA_URL)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
