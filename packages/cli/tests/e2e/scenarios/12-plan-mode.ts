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

    // Plan mode CAN call writeFile/edit — but ONLY on the plan-storage
    // file under `.x-code/plans/`. enterPlanMode's tool result explicitly
    // tells the model to use writeFile on the plan file to build the plan
    // (see plan-tools.ts:131). The invariant we care about is: no write
    // tool touches anything outside `.x-code/plans/`.
    const isPlanFile = (p: unknown): boolean => typeof p === 'string' && /[\\/]\.x-code[\\/]plans[\\/]/.test(p)
    for (const tc of r.toolCalls) {
      if (tc.toolName !== 'writeFile' && tc.toolName !== 'edit') continue
      const filePath = tc.input.filePath
      ctx.expect.truthy(
        isPlanFile(filePath),
        `plan mode wrote outside .x-code/plans/: ${tc.toolName} → ${String(filePath)}`,
      )
    }

    // src/main.ts must not have been touched at all
    await ctx.expect.fileContent('src/main.ts', /greet/)
    const content = await ctx.readFile('src/main.ts')
    ctx.expect.truthy(!content.includes('bye'), 'src/main.ts should NOT have been modified in plan mode')
  },
}

export default scenario
