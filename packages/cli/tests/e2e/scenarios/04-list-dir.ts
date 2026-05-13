import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '04-list-dir',
  name: 'listDir 工具列出当前目录条目',
  async run(ctx) {
    await ctx.writeFile('alpha.txt', 'a')
    await ctx.writeFile('beta.txt', 'b')
    await ctx.mkdir('subdir')

    const r = await ctx.runCli(
      'Use the listDir tool to list the files and subdirectories at the project root. ' +
        'After listing, name every file and every subdirectory you saw, and tell me how many of each.',
    )
    ctx.expect.exitCode(r, 0)
    const listCall = ctx.expect.toolCalled(r, 'listDir')
    // 直接验证 listDir 工具的输出 — 三个条目都应该返回。
    // 旧版断言 /alpha|beta|subdir/ 只要提到一个就过，listDir 漏返回两个也测不出来。
    const result = listCall.resultText ?? ''
    ctx.expect.truthy(
      /alpha\.txt/.test(result) && /beta\.txt/.test(result) && /subdir/.test(result),
      `listDir should return alpha.txt, beta.txt and subdir; got resultText:\n${result.slice(0, 400)}`,
    )
    // 模型必须真的消费完整列表 — 三个名字都要在最终答案里出现。
    // 不验"计数 = 2/1"是因为表达方式太散（"two files"/"2 files"/"alpha and beta"），
    // 三个名字全列出来反而比数字更稳。
    ctx.expect.assistantMentions(r, /alpha/)
    ctx.expect.assistantMentions(r, /beta/)
    ctx.expect.assistantMentions(r, /subdir/)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
