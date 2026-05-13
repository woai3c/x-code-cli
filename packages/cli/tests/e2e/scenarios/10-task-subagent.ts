import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '10-task-subagent',
  name: 'task 工具委派给 explore 子 agent',
  async run(ctx) {
    // 准备 3 个文件让子 agent 有东西可探索
    await ctx.writeFile('src/utils/format.ts', 'export const fmt = (x: number) => `${x}`\n')
    await ctx.writeFile('src/utils/parse.ts', 'export const parse = (s: string) => Number(s)\n')
    await ctx.writeFile('src/index.ts', 'import { fmt } from "./utils/format"\nexport default fmt\n')
    await ctx.writeFile('package.json', '{"name":"demo"}\n')

    const r = await ctx.runCli(
      'Use the `task` tool with the `explore` sub-agent type to investigate what utilities live in the src/utils/ directory. The sub-agent should look at each file and return a short summary. Then quote that summary back to me in your final answer.',
      { args: ['--trust', '--max-turns', '15'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'task')
    // 子 agent 应该至少提到一个文件名
    ctx.expect.assistantMentions(r, /format\.ts|parse\.ts/)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
