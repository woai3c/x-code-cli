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
    // todoWrite 调用里 todos 必须含至少 3 项，且分别提到 a/b/c.txt。
    // 旧版 toolCalled(todoWrite) 不查 input — 模型建一份只含 1 项的 todo
    // 也能过；这里用 predicate 把"清单真的是 3 步"作为不变量验证。
    ctx.expect.toolCalled(r, 'todoWrite', {
      todos: (todos: unknown) => {
        if (!Array.isArray(todos) || todos.length < 3) return false
        const blob = todos
          .map((t: unknown) => {
            if (!t || typeof t !== 'object') return ''
            const o = t as Record<string, unknown>
            return [o.content, o.activeForm].filter((v) => typeof v === 'string').join(' ')
          })
          .join(' | ')
          .toLowerCase()
        return blob.includes('a.txt') && blob.includes('b.txt') && blob.includes('c.txt')
      },
    })
    // 三个文件都必须被 readFile 读过 — "多步执行"才不是空话。
    // 旧版只查 readFile 调用过一次，模型完全可以跳过 b/c。
    ctx.expect.toolCalled(r, 'readFile', { filePath: /a\.txt$/ })
    ctx.expect.toolCalled(r, 'readFile', { filePath: /b\.txt$/ })
    ctx.expect.toolCalled(r, 'readFile', { filePath: /c\.txt$/ })
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
