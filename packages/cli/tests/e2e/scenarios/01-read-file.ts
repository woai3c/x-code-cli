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
      'Read the package.json in the current directory and tell me the exact value of the `packageManager` field. Quote it verbatim.',
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'readFile', { filePath: /package\.json$/ })
    // 旧断言 /pnpm/i 是 JS 项目常识默认，模型不读文件靠先验就能蒙混。
    // 改成完整版本号 pnpm@9.0.0 — 不读 package.json 拼不出。
    ctx.expect.assistantMentions(r, /pnpm@9\.0\.0/)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
