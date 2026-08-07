import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '25-edit-batch',
  name: 'edit 工具批量原子替换：单次调用修改三个独立位置',
  async run(ctx) {
    await ctx.writeFile('constants.ts', 'export const alpha = 1\nexport const beta = 2\nexport const gamma = 3\n')

    const r = await ctx.runCli(
      'Read constants.ts and change alpha to first, beta to second, and gamma to third. Use exactly one edit call with three entries in the edits array.',
      { args: ['--trust', '--max-turns', '6'] },
    )
    ctx.expect.exitCode(r, 0)
    const call = ctx.expect.toolCalled(r, 'edit', {
      filePath: /constants\.ts$/,
      edits: (value: unknown) => Array.isArray(value) && value.length === 3,
    })
    ctx.expect.truthy(
      r.toolCalls.filter((toolCall) => toolCall.toolName === 'edit').length === 1,
      `expected one edit call, got ${r.toolCalls.filter((toolCall) => toolCall.toolName === 'edit').length}`,
    )
    ctx.expect.truthy(call.resultText?.includes('(3 replacements)'), `unexpected edit result: ${call.resultText}`)
    await ctx.expect.fileContent(
      'constants.ts',
      'export const first = 1\nexport const second = 2\nexport const third = 3\n',
    )
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
