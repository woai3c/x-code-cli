import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '23-continue-session',
  name: '--continue 加载上轮会话：模型记得前一轮告诉过它的数字',
  // Two consecutive `xc -p` invocations in the same tmpDir. The second one
  // uses --continue, which makes main() pick the latest jsonl from
  // <tmpDir>/.x-code/sessions/ and hand it to runPrintMode as
  // initialSession — runPrintMode then seeds agentLoop's LoopState via
  // hydrateLoopState. Without the print-mode plumbing for initialSession,
  // the second turn would see a fresh conversation and have no idea what
  // 4242 means.
  async run(ctx) {
    const r1 = await ctx.runCli(
      'For this session, please remember a specific fact: the magic number is 4242. Just acknowledge in one short sentence — no tools needed.',
      { args: ['--max-turns', '2'] },
    )
    ctx.expect.exitCode(r1, 0)
    ctx.expect.assistantMentions(r1, '4242')

    const r2 = await ctx.runCli(
      'What magic number did I tell you to remember a moment ago? Answer with the number alone.',
      { args: ['--continue', '--max-turns', '2'] },
    )
    ctx.expect.exitCode(r2, 0)
    ctx.expect.assistantMentions(r2, '4242')
  },
}

export default scenario
