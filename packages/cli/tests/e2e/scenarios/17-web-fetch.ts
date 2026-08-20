import type { Scenario } from '../framework/types.js'

const PAGE_PHRASE =
  /illustrative examples|literature without prior coordination|may use this domain|documentation examples|without needing permission|avoid use in operations/i

const scenario: Scenario = {
  id: '17-web-fetch',
  name: 'webFetch 工具：抓一个稳定 URL 并解出页面内容',
  // No API key needed for webFetch, but it does need outbound HTTPS.
  // example.com is HTTPS-served, has been online since 1992, and ships
  // a tiny "Example Domain" page that any HTML→markdown extractor handles.
  async run(ctx) {
    const prompt =
      'Use the webFetch tool to fetch https://example.com/ and then summarize the page content ' +
      'in one short sentence. Include in your summary at least one specific phrase you saw on the page.'
    let r = await ctx.runCli(prompt, { args: ['--max-turns', '4'] })

    // External HTTPS can fail transiently even when webFetch is healthy. Retry only
    // transport-level failures once; persistent failures still reach the assertions.
    const transientFailure = r.toolCalls.some(
      (tc) =>
        tc.toolName === 'webFetch' &&
        /Error fetching URL:.*(?:fetch failed|timed? ?out|timeout|ECONNRESET|EAI_AGAIN|socket)/is.test(
          tc.resultText ?? '',
        ),
    )
    if (transientFailure) {
      r = await ctx.runCli(prompt, { args: ['--max-turns', '4'] })
    }

    ctx.expect.exitCode(r, 0)
    const fetchCall = ctx.expect.toolCalled(r, 'webFetch', { url: /example\.com/ })
    ctx.expect.truthy(
      PAGE_PHRASE.test(fetchCall.resultText ?? ''),
      `webFetch result did not contain expected page content; got: ${(fetchCall.resultText ?? '').slice(0, 400)}`,
    )
    // 旧断言 /example|domain|.../ 在 prompt 里就有 "example.com"，模型不用真抓页面
    // 也能蒙混。这里改成 example.com 页面正文里独有的短语 — 凭常识/prompt 都拼不出来。
    // 注意：IANA 已改版 example.com，旧文案 "illustrative examples / may use this
    // domain" 换成了 "documentation examples / without needing permission /
    // Avoid use in operations"。两组短语都保留，任一版本页面都能命中。
    ctx.expect.assistantMentions(r, PAGE_PHRASE)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
