import type { Scenario } from '../framework/types.js'

const UNIQUE_MARKER = 'KIWI_BANANA_7717'

const scenario: Scenario = {
  id: '13-knowledge-injection',
  name: 'AGENTS.md 注入到 system prompt — 模型能引用其中独有的字符串',
  async run(ctx) {
    // AGENTS.md 在 cwd（即 tmpDir）下
    await ctx.writeFile(
      'AGENTS.md',
      [
        '# Project conventions',
        '',
        '- Every code review starts with the phrase ' + UNIQUE_MARKER + '.',
        '- Always use Tab indentation in this project.',
      ].join('\n'),
    )

    const r = await ctx.runCli(
      'Before doing anything, please tell me whether there is a special phrase that code reviews in this project should start with. If yes, quote it.',
      { args: ['--max-turns', '4'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.assistantMentions(r, UNIQUE_MARKER)
  },
}

export default scenario
