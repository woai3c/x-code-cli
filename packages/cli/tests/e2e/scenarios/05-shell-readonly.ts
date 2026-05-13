import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '05-shell-readonly',
  name: '只读 shell（ls / pwd）自动放行，不需 --trust',
  async run(ctx) {
    // 不传 --trust。`echo` 在 shell-utils 的 READ_ONLY_COMMANDS 白名单里，
    // 走 always-allow，应当自动通过。命令选 echo 是因为：
    //   1. 在白名单里 (vs node --version 走的是 ask)
    //   2. listDir / readFile 替代不了 (vs `ls` 会被模型挑去用 listDir)
    // 所以模型只能落在 shell 工具上 — 这才真正测到 shell 的只读自动放行路径。
    const MARKER = 'SHELL_READONLY_MARKER_7777'
    const r = await ctx.runCli(
      `Use the shell tool to run the command \`echo ${MARKER}\`, then quote back exactly what it printed.`,
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'shell')
    // 没有 trust 时 deny 类工具会得到 permission denied — 这里期望它不返回 denied
    const shellCall = r.toolCalls.find((tc) => tc.toolName === 'shell')
    ctx.expect.truthy(
      shellCall != null && !(shellCall.resultText ?? '').toLowerCase().includes('permission denied'),
      `shell call should auto-allow read-only command, got resultText: ${shellCall?.resultText?.slice(0, 200)}`,
    )
    ctx.expect.assistantMentions(r, MARKER)
  },
}

export default scenario
