import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '15-web-search',
  name: 'webSearch 工具：搜一个外部主题（需要 TAVILY_API_KEY 或 BRAVE_API_KEY）',
  requires: (env) => Boolean(env.TAVILY_API_KEY || env.BRAVE_API_KEY),
  requiresReason: 'set TAVILY_API_KEY or BRAVE_API_KEY to enable',
  async run(ctx) {
    const r = await ctx.runCli(
      'Use the webSearch tool to find the official Anthropic documentation URL for prompt caching, ' +
        'then quote the URL in your final answer.',
      { args: ['--max-turns', '6'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'webSearch', { query: /(prompt[- ]?caching|cache|anthropic)/i })
    // Accept either the exact docs subdomain or the broader anthropic.com —
    // search results are non-deterministic and models sometimes describe the
    // URL without including the exact subdomain prefix.
    ctx.expect.assistantMentions(r, /anthropic\.com/i)
    ctx.expect.assistantMentions(r, /prompt[- ]?cach/i)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
