import path from 'node:path'

import type { Scenario } from '../framework/types.js'

const ROOT_MARKER = 'MAGENTA_FOX_8821'
const LEAF_MARKER = 'AZURE_OWL_4242'

const scenario: Scenario = {
  id: '19-knowledge-monorepo',
  name: 'AGENTS.md monorepo 链：root + leaf 都注入 system prompt',
  async run(ctx) {
    // A `.git` at the root scopes the AGENTS.md walker — without it, the
    // walker keeps climbing past tmpDir and may pick up unrelated CLAUDE.md
    // / AGENTS.md files on the developer's machine, making the test flaky.
    await ctx.mkdir('.git')
    await ctx.writeFile('.git/HEAD', 'ref: refs/heads/main\n')

    await ctx.writeFile('AGENTS.md', [`# Repo root`, '', `The repo-root unique marker is ${ROOT_MARKER}.`].join('\n'))
    await ctx.writeFile(
      'packages/widget/AGENTS.md',
      [`# Widget package`, '', `The widget-package unique marker is ${LEAF_MARKER}.`].join('\n'),
    )
    await ctx.writeFile('packages/widget/package.json', '{"name":"widget"}\n')

    const widgetDir = path.join(ctx.tmpDir, 'packages', 'widget')
    const r = await ctx.runCli(
      'In this project both the repo root and the current package ship an AGENTS.md with one unique marker each. Quote both marker strings back to me verbatim.',
      { args: ['--max-turns', '4'], cwd: widgetDir },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.assistantMentions(r, ROOT_MARKER)
    ctx.expect.assistantMentions(r, LEAF_MARKER)
  },
}

export default scenario
