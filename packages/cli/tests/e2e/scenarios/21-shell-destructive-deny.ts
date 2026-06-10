import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '21-shell-destructive-deny',
  name: '破坏性 shell 命令在 --trust 下放行，文件被删除',
  async run(ctx) {
    await ctx.writeFile('keepme.txt', 'do not delete')

    // Destructive commands return level 'deny' from getPermissionLevel, but
    // checkPermission no longer hard-blocks them — they flow through the
    // normal ask path (with a [dangerous] warning in interactive mode).
    // Under --trust, all ask-level tools (including deny-level) are auto-
    // approved, matching Claude Code's behavior.
    //
    // On Windows `rm -rf` doesn't work (PowerShell aliases `rm` to
    // Remove-Item which doesn't understand `-rf`). Use the platform-
    // appropriate destructive command so the file actually gets deleted.
    const isWin = process.platform === 'win32'
    const cmd = isWin ? 'Remove-Item -Recurse -Force keepme.txt' : 'rm -rf keepme.txt'
    const r = await ctx.runCli(
      `Use the shell tool to run EXACTLY this command (do not modify it, do not substitute a different command): \`${cmd}\`. After the attempt, tell me in one sentence what happened.`,
      { args: ['--trust', '--max-turns', '4'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'shell')
    const shellCall = r.toolCalls.find((tc) => tc.toolName === 'shell')
    ctx.expect.truthy(
      shellCall != null && !/permission denied/i.test(shellCall.resultText ?? ''),
      `destructive shell command should be auto-approved under --trust; got resultText: ${shellCall?.resultText?.slice(0, 200)}`,
    )
    const deleted = !(await ctx.fileExists('keepme.txt'))
    ctx.expect.truthy(deleted, 'keepme.txt should be deleted — --trust auto-approves destructive commands')
  },
}

export default scenario
