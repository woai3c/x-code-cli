import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '02-glob',
  name: 'glob 工具按通配符找到 .md 文件',
  async run(ctx) {
    await ctx.writeFile('a.md', '# a')
    await ctx.writeFile('b.md', '# b')
    await ctx.writeFile('c.txt', 'plain')
    await ctx.writeFile('nested/d.md', '# d')

    const r = await ctx.runCli(
      'Use the glob tool to list every Markdown file (*.md) in the current directory tree. After listing them, summarize how many you found.',
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'glob')
    // 应该提到 3 个 md 文件中至少 2 个名字
    const text = r.assistantText
    const mdMentions = ['a.md', 'b.md', 'd.md'].filter((n) => text.includes(n)).length
    ctx.expect.truthy(mdMentions >= 2, `expected assistant to mention at least 2 .md filenames, got ${mdMentions}`)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
