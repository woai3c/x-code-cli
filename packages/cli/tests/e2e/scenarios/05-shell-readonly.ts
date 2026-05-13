import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '05-shell-readonly',
  name: '只读 shell（ls / pwd）自动放行，不需 --trust',
  async run(ctx) {
    await ctx.writeFile('hello.txt', 'world')
    await ctx.writeFile('greet.txt', 'hi')

    // 注意：不传 --trust。只读 shell 走 always-allow 应该自动通过。
    const r = await ctx.runCli(
      'Use the shell tool to run a read-only listing command (such as `ls`) in the current directory, then tell me which files you see.',
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'shell')
    // 没有 trust 时 deny 类工具会得到 permission denied — 这里期望它不返回 denied
    const shellCall = r.toolCalls.find((tc) => tc.toolName === 'shell')
    ctx.expect.truthy(
      shellCall != null && !(shellCall.resultText ?? '').toLowerCase().includes('permission denied'),
      `shell call should auto-allow read-only command, got resultText: ${shellCall?.resultText?.slice(0, 200)}`,
    )
    ctx.expect.assistantMentions(r, /hello\.txt|greet\.txt/)
  },
}

export default scenario
