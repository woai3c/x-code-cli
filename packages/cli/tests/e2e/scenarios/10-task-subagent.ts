import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '10-task-subagent',
  name: 'task 工具委派给 explore 子 agent',
  async run(ctx) {
    // 准备 3 个文件让子 agent 有东西可探索。
    // 文件名里嵌入只有读源码才能拿到的标识符（fmt / parseValue），
    // 这样断言"assistant 引用了这些标识符"就能证明 sub-agent
    // 真的读了文件，而不是父 agent 自己 listDir 拿到文件名糊弄。
    await ctx.writeFile('src/utils/format.ts', 'export const fmt = (x: number) => `${x}`\n')
    await ctx.writeFile('src/utils/parse.ts', 'export const parseValue = (s: string) => Number(s)\n')
    await ctx.writeFile('src/index.ts', 'import { fmt } from "./utils/format"\nexport default fmt\n')
    await ctx.writeFile('package.json', '{"name":"demo"}\n')

    const r = await ctx.runCli(
      'Use the `task` tool with the `explore` sub-agent type (subagent_type: "explore") to investigate ' +
        'what utilities live in the src/utils/ directory. The sub-agent should look at each file and ' +
        'return a short summary that names every exported identifier it finds. Then quote that summary ' +
        'back to me verbatim in your final answer.',
      { args: ['--trust', '--max-turns', '15'] },
    )
    ctx.expect.exitCode(r, 0)
    // 必须用 explore 子 agent — 否则任何 sub-agent（甚至 general-purpose）都能蒙混。
    ctx.expect.toolCalled(r, 'task', { subagent_type: 'explore' })
    // 两个文件都要被提到 — 一个文件名提到就过的旧断言会让"只探索一半"漏过。
    ctx.expect.assistantMentions(r, /format\.ts/)
    ctx.expect.assistantMentions(r, /parse\.ts/)
    // 关键：标识符 fmt / parseValue 只有真的读了源码才能拿到。
    // 父 agent 单靠 listDir + prompt 上下文是看不到它们的，这条断言把
    // "task 走过场、用别的工具糊弄" 这条作弊路径堵死。
    ctx.expect.assistantMentions(r, /\bfmt\b/)
    ctx.expect.assistantMentions(r, /parseValue/)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
