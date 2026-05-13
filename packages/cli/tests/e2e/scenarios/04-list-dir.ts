import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '04-list-dir',
  name: 'listDir 工具列出当前目录条目',
  async run(ctx) {
    await ctx.writeFile('alpha.txt', 'a')
    await ctx.writeFile('beta.txt', 'b')
    await ctx.mkdir('subdir')

    const r = await ctx.runCli(
      'Use the listDir tool to list the files and subdirectories at the project root. After listing, tell me how many files and how many subdirectories you saw.',
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'listDir')
    ctx.expect.assistantMentions(r, /alpha|beta|subdir/)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
