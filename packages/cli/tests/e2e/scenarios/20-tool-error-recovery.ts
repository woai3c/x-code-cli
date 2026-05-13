import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '20-tool-error-recovery',
  name: 'readFile 失败：loop 不崩，模型在 final text 中报告文件不存在',
  async run(ctx) {
    const r = await ctx.runCli(
      'Use the readFile tool to read the file `does-not-exist.txt` in the current directory. If reading fails, tell me in your final answer that the file does not exist — do not retry endlessly.',
      { args: ['--max-turns', '4'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'readFile', { filePath: /does-not-exist\.txt$/ })
    ctx.expect.assistantMentions(r, /(not exist|no such|cannot find|doesn't exist|missing|unable)/i)
  },
}

export default scenario
