import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '08-shell-write',
  name: 'shell 写命令（mkdir / echo > file）在 --trust 下放行',
  async run(ctx) {
    const r = await ctx.runCli(
      'Use the shell tool to run a single command that creates a directory named `build` in the current directory. After it succeeds, confirm in one short sentence.',
      { args: ['--trust'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'shell')
    await ctx.expect.fileExists('build')
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
