import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '16-edit-replace-all',
  name: 'edit 工具 replaceAll：单次调用批量替换标识符',
  async run(ctx) {
    await ctx.writeFile(
      'config.ts',
      [
        'const oldName = 1',
        'export { oldName }',
        'function useOldName() { return oldName }',
        'export const sum = oldName + oldName',
        '',
      ].join('\n'),
    )

    const r = await ctx.runCli(
      'Read config.ts, then use the edit tool with replaceAll=true to rename every occurrence of the identifier `oldName` to `newName` in that file. Use a single edit call (not multiple).',
      { args: ['--trust', '--max-turns', '6'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'edit', {
      filePath: /config\.ts$/,
      oldString: /oldName/,
      replaceAll: true,
    })
    const content = await ctx.readFile('config.ts')
    ctx.expect.truthy(
      !content.includes('oldName'),
      `expected 0 occurrences of 'oldName' after replaceAll, file still contains it:\n${content}`,
    )
    const newOccurrences = (content.match(/newName/g) ?? []).length
    ctx.expect.truthy(newOccurrences >= 4, `expected ≥4 occurrences of 'newName', got ${newOccurrences}:\n${content}`)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
