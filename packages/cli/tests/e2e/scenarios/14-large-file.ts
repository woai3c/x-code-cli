import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '14-large-file',
  name: '大文件 readFile：head 截断后模型按 hint 二次调用拉尾部',
  async run(ctx) {
    // 生成 5000 行文件，远超 LARGE_FILE_LINE_THRESHOLD=2000。
    // readFile 默认只返回 head（前 2000 行），随后给出一条 hint：
    //   "showing first 2000/5000 lines. Call readFile again with offset/limit..."
    // 模型必须按 hint 再调一次 readFile 才能看到尾部。
    const lines: string[] = []
    for (let i = 1; i <= 5000; i++) {
      lines.push(`line ${i}: lorem ipsum dolor sit amet`)
    }
    // 关键标记放在尾部。前 4999 行模式完全一致 — 一个偷懒的模型只看 head
    // 就会"按模式外推"答 `lorem ipsum dolor sit amet`（deepseek-v4-flash 实测会）；
    // 只有真的二次调 readFile(offset≈5000) 拿到尾部才能引用出这个 token。
    lines[4999] = 'line 5000: FINAL_SENTINEL_TOKEN_XYZ'
    await ctx.writeFile('big.txt', lines.join('\n'))

    const r = await ctx.runCli(
      'Use the readFile tool to read big.txt. Because the file is large, the first call will ' +
        'truncate and the tool result will tell you so. When that happens you MUST call readFile ' +
        'again with offset/limit to fetch the very last line of the file — do not guess, do not ' +
        'extrapolate from the pattern of earlier lines. Then quote the very last line of the file ' +
        'verbatim in your final answer.',
      { args: ['--max-turns', '6'] },
    )
    ctx.expect.exitCode(r, 0)
    // 至少要有两次 readFile 调用：第一次拿 head，第二次按 hint 拉尾部
    const readCalls = r.toolCalls.filter(
      (tc) => tc.toolName === 'readFile' && /big\.txt$/.test(String(tc.input.filePath)),
    )
    ctx.expect.truthy(
      readCalls.length >= 2,
      `expected ≥2 readFile calls on big.txt (head + tail via offset), got ${readCalls.length}`,
    )
    // 至少一次带 offset — 证明模型真的按 hint 跳到了别的位置，不是反复读 head
    const hasOffsetCall = readCalls.some((tc) => tc.input.offset != null)
    ctx.expect.truthy(
      hasOffsetCall,
      `expected at least one readFile call with offset set; got inputs: ${readCalls.map((c) => JSON.stringify(c.input)).join(', ')}`,
    )
    ctx.expect.noToolErrors(r)
    // 核心：尾部 token 只能从二次读拿到，凭模式外推拼不出。
    ctx.expect.assistantMentions(r, /FINAL_SENTINEL_TOKEN_XYZ/)
    // 顺手守住：loop 没冒出 orphan tool_call 报错
    ctx.expect.truthy(
      !r.stderr.toLowerCase().includes('tool_use without tool_result'),
      'stderr contained orphan tool_call complaint: ' + r.stderr.slice(0, 300),
    )
  },
}

export default scenario
