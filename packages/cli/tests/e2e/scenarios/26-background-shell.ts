import type { Scenario } from '../framework/types.js'

const MARKER = 'BACKGROUND_SHELL_E2E_9274'

const scenario: Scenario = {
  id: '26-background-shell',
  name: '后台 shell：启动后用动态 shellId 等待并读取最终输出',
  async run(ctx) {
    const command = `node -e "setTimeout(() => console.log('${MARKER}'), 700)"`
    const r = await ctx.runCli(
      [
        `Use the shell tool to run exactly this cross-platform command: \`${command}\`.`,
        'Set yieldTimeMs to 0 so the first call returns a background shellId immediately.',
        'Then call shellOutput with that exact shellId and wait until the command exits.',
        'Finally quote the marker printed by the command. Do not run the command a second time.',
      ].join(' '),
      { args: ['--trust', '--max-turns', '6'] },
    )

    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'shell', {
      command: (value: unknown) => typeof value === 'string' && value.includes(MARKER),
      yieldTimeMs: 0,
    })
    const shellCalls = r.toolCalls.filter((toolCall) => toolCall.toolName === 'shell')
    ctx.expect.truthy(shellCalls.length === 1, `expected one shell call, got ${shellCalls.length}`)
    const outputCall = ctx.expect.toolCalled(r, 'shellOutput', {
      shellId: (value: unknown) => typeof value === 'string' && value.length > 0,
    })
    ctx.expect.truthy(
      outputCall.resultText?.includes(MARKER),
      `shellOutput should contain ${MARKER}; got: ${outputCall.resultText?.slice(0, 300)}`,
    )
    ctx.expect.assistantMentions(r, MARKER)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
