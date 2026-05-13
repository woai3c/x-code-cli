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
    ctx.expect.toolCalled(r, 'grep')
    ctx.expect.assistantMentions(r, /foo\.ts/)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
