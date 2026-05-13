import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '01-read-file',
  name: 'readFile 工具读 package.json 并答出 packageManager 字段',
  async run(ctx) {
    await ctx.writeFile(
      'package.json',
      JSON.stringify({ name: 'demo', version: '1.0.0', packageManager: 'pnpm@9.0.0' }, null, 2),
    )
    const r = await ctx.runCli(
      'Read the package.json in the current directory and tell me which package manager this project uses. Answer in one short sentence.',
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'readFile', { filePath: /package\.json$/ })
    ctx.expect.assistantMentions(r, /pnpm/i)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
