import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '12-plan-mode',
  name: '--plan 启动：模型只读探索、不调写工具',
  async run(ctx) {
    await ctx.writeFile('src/main.ts', 'export const greet = () => "hello"\n')
    await ctx.writeFile('package.json', '{"name":"demo"}\n')

    const r = await ctx.runCli(
      'I want to refactor src/main.ts to also export a `bye` function. Look at what is there and then describe (in writing) how you would change it. Do not actually make the change.',
      { args: ['--plan', '--trust', '--max-turns', '12'] },
    )
    ctx.expect.exitCode(r, 0)
    // 必须没有调用任何写工具
    ctx.expect.toolNotCalled(r, 'writeFile')
    ctx.expect.toolNotCalled(r, 'edit')
    // 文件不应被改动
    await ctx.expect.fileContent('src/main.ts', /greet/)
    const content = await ctx.readFile('src/main.ts')
    ctx.expect.truthy(!content.includes('bye'), 'src/main.ts should NOT have been modified in plan mode')
  },
}

export default scenario
