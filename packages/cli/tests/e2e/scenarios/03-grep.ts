import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '03-grep',
  name: 'grep 工具按正则查内容并报告命中文件',
  async run(ctx) {
    await ctx.writeFile('src/foo.ts', 'export function uniqueMarkerForGrep(): void {}\n')
    await ctx.writeFile('src/bar.ts', 'export const hello = 1\n')
    await ctx.writeFile('README.md', 'no marker here\n')

    const r = await ctx.runCli(
      'Use the grep tool to find every file that contains the literal string "uniqueMarkerForGrep" in this project. List the matching filename in your answer.',
    )
    ctx.expect.exitCode(r, 0)
    // 必须用 uniqueMarkerForGrep 作为 pattern 调 grep — 否则模型可以 grep
    // 一个无关词、再"猜"到 foo.ts（因为 src/foo.ts 是常见路径）就过。
    const grepCall = ctx.expect.toolCalled(r, 'grep', { pattern: /uniqueMarkerForGrep/ })
    // grep 工具自己的 resultText 必须真的命中 foo.ts —— 直接验证工具行为，
    // 不依赖 assistant 文本（assistant 可能从 prompt/setup 推断 foo.ts）。
    ctx.expect.truthy(
      /foo\.ts/.test(grepCall.resultText ?? ''),
      `grep resultText should report foo.ts as a hit; got:\n${(grepCall.resultText ?? '').slice(0, 300)}`,
    )
    ctx.expect.assistantMentions(r, /foo\.ts/)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
