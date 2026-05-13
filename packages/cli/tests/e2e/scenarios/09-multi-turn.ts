import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '09-multi-turn',
  name: 'agent loop 多轮：读 -> 分析 -> 编辑',
  async run(ctx) {
    await ctx.writeFile('config.json', JSON.stringify({ feature: 'old', port: 3000 }, null, 2))

    const r = await ctx.runCli(
      'In config.json, find the value of the "feature" field, then update it from "old" to "new" using the edit tool. Confirm the change in one sentence.',
      { args: ['--trust', '--max-turns', '10'] },
    )
    ctx.expect.exitCode(r, 0)
    // 必须既调用 readFile 又调用 edit，证明走了多轮
    ctx.expect.toolCalled(r, 'readFile', { filePath: /config\.json$/ })
    ctx.expect.toolCalled(r, 'edit', { filePath: /config\.json$/ })
    await ctx.expect.fileContent('config.json', /"feature":\s*"new"/)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
