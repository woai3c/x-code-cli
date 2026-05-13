import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '11-todo-write',
  name: 'todoWrite：模型为多步任务建任务清单',
  async run(ctx) {
    await ctx.writeFile('a.txt', 'A\n')
    await ctx.writeFile('b.txt', 'B\n')
    await ctx.writeFile('c.txt', 'C\n')

    const r = await ctx.runCli(
      [
        'I want you to do these 3 things in order:',
        '  (1) read a.txt',
        '  (2) read b.txt',
        '  (3) read c.txt',
        'Before reading anything, use the todoWrite tool to create a todo list with these 3 items. Then execute each one and update the todo status as you go.',
      ].join('\n'),
      { args: ['--trust', '--max-turns', '15'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'todoWrite')
    // 至少应该读到一个文件
    ctx.expect.toolCalled(r, 'readFile')
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
