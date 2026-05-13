import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '07-edit-file',
  name: 'edit 工具替换文件中的字符串（--trust 自动放行）',
  async run(ctx) {
    await ctx.writeFile('greeting.txt', 'hello world\n')

    const r = await ctx.runCli(
      'Read greeting.txt then use the edit tool to change the word `world` to `universe` in that file. Do not rewrite the entire file — use the edit tool with oldString/newString.',
      { args: ['--trust'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'edit', { filePath: /greeting\.txt$/ })
    await ctx.expect.fileContent('greeting.txt', /hello universe/)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
