import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '06-write-file',
  name: 'writeFile 创建新文件（--trust 自动放行）',
  async run(ctx) {
    const r = await ctx.runCli(
      'Use the writeFile tool to create a file named hello.txt in the current directory with the exact content `hello e2e`. Then briefly confirm the file is written.',
      { args: ['--trust'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'writeFile', { filePath: /hello\.txt$/ })
    await ctx.expect.fileExists('hello.txt')
    await ctx.expect.fileContent('hello.txt', /hello e2e/)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
