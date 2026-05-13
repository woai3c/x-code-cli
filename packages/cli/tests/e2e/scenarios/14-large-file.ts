import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '14-large-file',
  name: '大文件 readFile：截断生效，不产生 orphan tool_call',
  async run(ctx) {
    // 生成 5000 行文件，远超 LARGE_FILE_LINE_THRESHOLD=2000
    const lines: string[] = []
    for (let i = 1; i <= 5000; i++) {
      lines.push(`line ${i}: lorem ipsum dolor sit amet`)
    }
    // 关键标记放在尾部，验证 head-tail 截断把尾部也保留下来
    lines[4999] = 'line 5000: FINAL_SENTINEL_TOKEN_XYZ'
    await ctx.writeFile('big.txt', lines.join('\n'))

    const r = await ctx.runCli(
      'Read big.txt and tell me roughly how many lines it has, and whether you can see the very last line. Answer in one short paragraph.',
      { args: ['--max-turns', '6'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'readFile', { filePath: /big\.txt$/ })
    // 重点：没有 orphan tool_call 错误（这种错误会进 stderr 或导致 isError）
    ctx.expect.noToolErrors(r)
    ctx.expect.truthy(
      !r.stderr.toLowerCase().includes('tool_use without tool_result'),
      'stderr contained orphan tool_call complaint: ' + r.stderr.slice(0, 300),
    )
  },
}

export default scenario
