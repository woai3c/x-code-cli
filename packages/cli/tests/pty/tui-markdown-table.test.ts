import { describe, expect, it } from 'vitest'

import { submitInput, withTui } from './test-context.js'

describe('markdown table rendering in narrow PTY', () => {
  it('wraps wide CJK table cells inside an intact box grid without terminal auto-wrap tearing', async () => {
    const COLS = 56
    const reply = [
      '| 命令 | 说明 |',
      '| --- | --- |',
      '| `/model` | 切换当前会话使用的模型与推理档位，立即生效无需重启 |',
      '| `/clear` | 清空当前终端历史消息并开始全新对话上下文 |',
      '',
      'table-render-complete',
    ].join('\n')

    await withTui(
      'narrow-markdown-table',
      [{ type: 'completion', text: reply }],
      async ({ harness }) => {
        await submitInput(harness, 'show table')
        await harness.waitForText('table-render-complete', 30000)
        await harness.settle()

        const screen = harness.screen()
        // Extract assistant table rows (2-space assistant indent + box-drawing border).
        const tableRows = screen.filter((line) => /^  [┌├└│]/.test(line))
        expect(tableRows.length).toBeGreaterThanOrEqual(7)

        // Top border, row separators, data rows, and bottom border must all
        // begin at column 2 (`  `) and close cleanly on the right without
        // wrapping onto the next xterm row.
        expect(tableRows[0]!.startsWith('  ┌')).toBe(true)
        expect(tableRows[0]!.trimEnd().endsWith('┐')).toBe(true)
        expect(tableRows[tableRows.length - 1]!.startsWith('  └')).toBe(true)
        expect(tableRows[tableRows.length - 1]!.trimEnd().endsWith('┘')).toBe(true)

        for (const row of tableRows) {
          expect(row.startsWith('  ')).toBe(true)
          expect(/[┐┤┘│]$/.test(row.trimEnd())).toBe(true)
        }

        const joined = tableRows.join('\n')
        expect(joined).toContain('/model')
        expect(joined).toContain('/clear')
        expect(joined).toContain('切换当前会话')
        expect(joined).toContain('效无需重启')

        harness.key('ctrl-c')
      },
      { columns: COLS, rows: 36 },
    )
  }, 60000)
})
