import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '18-permission-deny',
  name: 'print 模式无 --trust：writeFile 被拒，文件未创建，loop 不崩',
  async run(ctx) {
    const r = await ctx.runCli(
      'Use the writeFile tool to create a file named blocked.txt in the current directory with the content "should not appear". After the attempt, tell me what happened.',
      { args: ['--max-turns', '4'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'writeFile', { filePath: /blocked\.txt$/ })
    const exists = await ctx.fileExists('blocked.txt')
    ctx.expect.truthy(
      !exists,
      'expected blocked.txt NOT to be written (no --trust → onAskPermission returns no), but the file exists',
    )
    // print.ts writes this marker to stderr when it denies a tool call.
    ctx.expect.truthy(
      /permission denied/i.test(r.stderr),
      `expected stderr to contain "permission denied"; got:\n${r.stderr.slice(0, 300)}`,
    )
  },
}

export default scenario
