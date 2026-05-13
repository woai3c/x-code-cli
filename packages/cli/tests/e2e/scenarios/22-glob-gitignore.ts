import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '22-glob-gitignore',
  name: 'glob 工具尊重 .gitignore：node_modules/ 被过滤掉',
  // Regression guard for commit 605cba1 — glob switched to ripgrep and
  // started honoring .gitignore. Before that, `**/*.js` would happily
  // return every vendored dep, which is both noise and a cost multiplier.
  async run(ctx) {
    // ripgrep only honors .gitignore when it detects a git repo (no
    // `--no-require-git` flag in the glob tool, by design — outside a git
    // tree, .gitignore semantically doesn't apply). So we need a minimal
    // .git/ marker for the test to exercise the gitignore path.
    await ctx.mkdir('.git')
    await ctx.writeFile('.git/HEAD', 'ref: refs/heads/main\n')
    await ctx.writeFile('.gitignore', 'node_modules/\n')
    await ctx.writeFile('src/main.js', '// app entry\n')
    await ctx.writeFile('src/util.js', '// helper\n')
    await ctx.writeFile('node_modules/lodash/index.js', '// vendor\n')
    await ctx.writeFile('node_modules/react/index.js', '// vendor\n')

    const r = await ctx.runCli(
      'Use the glob tool with the pattern `**/*.js` to find every JavaScript file in this directory tree. List the paths the tool returned.',
      { args: ['--max-turns', '4'] },
    )
    ctx.expect.exitCode(r, 0)
    const globCall = ctx.expect.toolCalled(r, 'glob')
    const result = globCall.resultText ?? ''
    ctx.expect.truthy(
      /main\.js/.test(result) && /util\.js/.test(result),
      `glob should find src/main.js and src/util.js; got resultText:\n${result.slice(0, 400)}`,
    )
    ctx.expect.truthy(
      !/node_modules/.test(result),
      `glob result should respect .gitignore and exclude node_modules/; got resultText:\n${result.slice(0, 400)}`,
    )
  },
}

export default scenario
