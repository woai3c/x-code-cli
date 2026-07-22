import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '17-web-fetch',
  name: 'webFetch 工具：抓一个稳定 URL 并解出页面内容',
  // No API key needed for webFetch, but it does need outbound HTTPS.
  // example.com is HTTPS-served, has been online since 1992, and ships
  // a tiny "Example Domain" page that any HTML→markdown extractor handles.
  async run(ctx) {
    const r = await ctx.runCli(
      'Use the webFetch tool to fetch https://example.com/ and then summarize the page content ' +
        'in one short sentence. Include in your summary at least one specific phrase you saw on the page.',
      { args: ['--max-turns', '4'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'webFetch', { url: /example\.com/ })
    // 旧断言 /example|domain|.../ 在 prompt 里就有 "example.com"，模型不用真抓页面
    // 也能蒙混。这里改成 example.com 页面正文里独有的短语 — 凭常识/prompt 都拼不出来。
    // 注意：IANA 已改版 example.com，旧文案 "illustrative examples / may use this
    // domain" 换成了 "documentation examples / without needing permission /
    // Avoid use in operations"。两组短语都保留，任一版本页面都能命中。
    ctx.expect.assistantMentions(
      r,
      /illustrative examples|literature without prior coordination|may use this domain|documentation examples|without needing permission|avoid use in operations/i,
    )
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
